//! Read endpoints for the web UI. Positions are converted from uiMap % to world yards
//! (`wx = top + (bottom - top) * y`, `wy = left + (right - left) * x`, as forge does) at read
//! time, so a frame that arrives later still applies.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};

/// A return to the previous place within this many seconds is a border flip, not a journey.
const BORDER_FLIP: f64 = 120.0;
/// A gap without records longer than this splits play into sessions.
pub const SESSION_GAP: f64 = 30.0 * 60.0;
/// A gap between positions longer than this breaks the trail line (a loading screen, a
/// hearthstone, an instance).
const TRAIL_GAP: f64 = 120.0;
/// Positions further apart than this (yards) are a teleport, not a walk: the line breaks.
const TRAIL_JUMP: f64 = 400.0;

#[derive(Clone, Copy)]
pub struct Frame {
	pub c: i64,
	top: f64,
	left: f64,
	bottom: f64,
	right: f64,
}

impl Frame {
	pub fn world(&self, x: i64, y: i64) -> (f64, f64) {
		let (fx, fy) = (x as f64 / 10000.0, y as f64 / 10000.0);
		(self.top + (self.bottom - self.top) * fy, self.left + (self.right - self.left) * fx)
	}
}

pub fn frames(db: &Connection) -> rusqlite::Result<HashMap<i64, Frame>> {
	let mut st = db.prepare("SELECT id, c, top, left, bottom, right FROM maps WHERE c IS NOT NULL AND top IS NOT NULL")?;
	let rows = st.query_map([], |r| Ok((r.get(0)?, Frame { c: r.get(1)?, top: r.get(2)?, left: r.get(3)?, bottom: r.get(4)?, right: r.get(5)? })))?;
	rows.collect()
}

fn world_of(frames: &HashMap<i64, Frame>, map: Option<i64>, x: Option<i64>, y: Option<i64>) -> Value {
	match (map.and_then(|m| frames.get(&m)), x, y) {
		(Some(f), Some(x), Some(y)) => {
			let (wx, wy) = f.world(x, y);
			json!({ "map": map, "x": x, "y": y, "c": f.c, "wx": wx, "wy": wy })
		}
		_ if map.is_some() => json!({ "map": map, "x": x, "y": y }),
		_ => Value::Null,
	}
}

pub fn characters(db: &Connection) -> rusqlite::Result<Value> {
	let frames = frames(db)?;
	let mut st = db.prepare(
		"SELECT c.char_id, c.name, c.realm, c.race, c.class, c.faction, c.level,
		        (SELECT COUNT(*) FROM chunks k WHERE k.char_id = c.char_id),
		        (SELECT MIN(first_t) FROM chunks k WHERE k.char_id = c.char_id),
		        (SELECT MAX(last_t) FROM chunks k WHERE k.char_id = c.char_id),
		        c.surname, c.sex, c.xp, c.xp_max, c.rested,
		        c.realm_name, c.money, c.bind, c.guide,
		        (SELECT MAX(saved) FROM snapshots s WHERE s.char_id = c.char_id),
		        (SELECT json FROM snapshots s WHERE s.char_id = c.char_id ORDER BY saved DESC LIMIT 1)
		 FROM characters c ORDER BY 10 DESC",
	)?;
	let mut out = Vec::new();
	let rows = st.query_map([], |r| {
		Ok(json!({
			"id": r.get::<_, String>(0)?, "name": r.get::<_, Option<String>>(1)?, "realm": r.get::<_, Option<String>>(2)?,
			"race": r.get::<_, Option<String>>(3)?, "class": r.get::<_, Option<String>>(4)?, "faction": r.get::<_, Option<String>>(5)?,
			"level": r.get::<_, Option<i64>>(6)?, "chunks": r.get::<_, i64>(7)?, "first": r.get::<_, Option<f64>>(8)?, "last": r.get::<_, Option<f64>>(9)?,
			"surname": r.get::<_, Option<String>>(10)?, "sex": r.get::<_, Option<i64>>(11)?,
			"xp": r.get::<_, Option<i64>>(12)?, "xpMax": r.get::<_, Option<i64>>(13)?, "rested": r.get::<_, Option<i64>>(14)?,
			"realmName": r.get::<_, Option<String>>(15)?, "money": r.get::<_, Option<i64>>(16)?, "bind": r.get::<_, Option<String>>(17)?,
			"guide": r.get::<_, Option<String>>(18)?.and_then(|g| serde_json::from_str::<Value>(&g).ok()),
			"snapshotAt": r.get::<_, Option<f64>>(19)?,
			"vitals": r.get::<_, Option<String>>(20)?.and_then(|j| serde_json::from_str::<Value>(&j).ok()).and_then(|v| v.get("stats").cloned()),
		}))
	})?;
	for row in rows {
		let mut ch = row?;
		let id = ch["id"].as_str().unwrap_or_default().to_string();
		let last = db
			.query_row("SELECT t, map, x, y, flags FROM positions WHERE char_id = ?1 ORDER BY t DESC LIMIT 1", [&id], |r| {
				Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))
			})
			.ok();
		let zone = db
			.query_row("SELECT fields FROM events WHERE char_id = ?1 AND kind = 'zone' ORDER BY t DESC LIMIT 1", [&id], |r| r.get::<_, String>(0))
			.ok()
			.and_then(|f| serde_json::from_str::<Vec<String>>(&f).ok())
			.map(|f| json!({ "zone": f.get(3), "subzone": f.get(4) }));
		if let Some((t, map, x, y, flags)) = last {
			let mut p = world_of(&frames, Some(map), Some(x), Some(y));
			p["t"] = json!(t);
			p["flags"] = json!(flags);
			if let Some(z) = zone {
				p["zone"] = z["zone"].clone();
				p["subzone"] = z["subzone"].clone();
			}
			ch["lastPos"] = p;
		}
		out.push(ch);
	}
	Ok(Value::Array(out))
}

#[derive(Serialize)]
pub struct Segment {
	pub c: i64,
	/// Flat wx, wy pairs (MapView's route format).
	pub pts: Vec<f32>,
	/// The time of each kept point.
	pub ts: Vec<f64>,
	/// Whether the character was dead (a ghost run).
	pub ghost: bool,
}

/// Douglas-Peucker on (wx, wy): indices of the points kept.
fn simplify(p: &[(f64, f64)], tol: f64) -> Vec<usize> {
	if p.len() < 3 || tol <= 0.0 {
		return (0..p.len()).collect();
	}
	let mut keep = vec![false; p.len()];
	keep[0] = true;
	keep[p.len() - 1] = true;
	let mut stack = vec![(0, p.len() - 1)];
	while let Some((a, b)) = stack.pop() {
		let (ax, ay) = p[a];
		let (bx, by) = p[b];
		let (dx, dy) = (bx - ax, by - ay);
		let len = (dx * dx + dy * dy).sqrt();
		let mut best = (0.0, 0);
		for i in a + 1..b {
			let (px, py) = p[i];
			let d = if len < 1e-9 { ((px - ax).powi(2) + (py - ay).powi(2)).sqrt() } else { ((px - ax) * dy - (py - ay) * dx).abs() / len };
			if d > best.0 {
				best = (d, i);
			}
		}
		if best.0 > tol {
			keep[best.1] = true;
			stack.push((a, best.1));
			stack.push((best.1, b));
		}
	}
	keep.iter().enumerate().filter(|(_, k)| **k).map(|(i, _)| i).collect()
}

pub fn trail(db: &Connection, char_id: &str, from: f64, to: f64, tol: f64) -> rusqlite::Result<(Vec<Segment>, usize)> {
	let frames = frames(db)?;
	let mut st = db.prepare("SELECT t, map, x, y, flags FROM positions WHERE char_id = ?1 AND t >= ?2 AND t <= ?3 ORDER BY t")?;
	let rows = st.query_map(params![char_id, from, to], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)))?;
	// Runs of points on one continent without long gaps or jumps, split at ghost changes.
	let mut runs: Vec<(i64, bool, Vec<(f64, f64)>, Vec<f64>)> = Vec::new();
	let mut total = 0;
	for row in rows {
		let (t, map, x, y, flags) = row?;
		let Some(f) = frames.get(&map) else { continue };
		total += 1;
		let (wx, wy) = f.world(x, y);
		let ghost = flags & 32 != 0;
		let cont = runs.last().is_some_and(|(c, g, p, ts)| {
			let (lx, ly) = *p.last().unwrap();
			*c == f.c && *g == ghost && t - ts.last().unwrap() <= TRAIL_GAP && ((wx - lx).powi(2) + (wy - ly).powi(2)).sqrt() <= TRAIL_JUMP
		});
		if !cont {
			// A ghost run starts where the body fell: carry the last point over.
			let carry = runs.last().filter(|(c, g, _, ts)| *c == f.c && *g != ghost && t - ts.last().unwrap() <= TRAIL_GAP).map(|(_, _, p, ts)| (*p.last().unwrap(), *ts.last().unwrap()));
			let mut run = (f.c, ghost, Vec::new(), Vec::new());
			if let Some((p, pt)) = carry {
				run.2.push(p);
				run.3.push(pt);
			}
			runs.push(run);
		}
		let r = runs.last_mut().unwrap();
		r.2.push((wx, wy));
		r.3.push(t);
	}
	let segs = runs
		.into_iter()
		.map(|(c, ghost, pts, ts)| {
			let keep = simplify(&pts, tol);
			Segment { c, ghost, pts: keep.iter().flat_map(|&i| [pts[i].0 as f32, pts[i].1 as f32]).collect(), ts: keep.iter().map(|&i| ts[i]).collect() }
		})
		.collect();
	Ok((segs, total))
}

/// A quest's title: as the character saw it (`text` records), else Polestar's reference data.
fn quest_title(db: &Connection, q: &str) -> String {
	db.query_row("SELECT title FROM quests WHERE id = ?1", [q], |r| r.get::<_, String>(0))
		.ok()
		.or_else(|| crate::names::name(db, "quest", q))
		.unwrap_or_else(|| format!("quest {q}"))
}

/// A name from the imported reference data, else "<kind> <id>".
fn named(db: &Connection, kind: &str, id: &str) -> String {
	crate::names::name(db, kind, id).unwrap_or_else(|| format!("{kind} {id}"))
}

/// One line of the journal for an event, or None to leave it out (it still counts).
fn describe(db: &Connection, kind: &str, f: &[String]) -> Option<String> {
	let g = |i: usize| f.get(i).map(String::as_str).unwrap_or("");
	Some(match kind {
		"level" => format!("Reached level {}", g(0)),
		"zone" => {
			if g(4).is_empty() {
				format!("Entered {}", g(3))
			} else {
				format!("{} — {}", g(3), g(4))
			}
		}
		"death" => format!("Died{}", if g(3).is_empty() { String::new() } else { format!(" (killed by {}, level {})", named(db, "npc", g(3)), g(4)) }),
		"revive" => format!("Revived ({})", match g(3) { "s" => "spirit healer", "c" => "at the corpse", "r" => "resurrected", _ => "?" }),
		"mark" => format!("Mark: {}", g(3)),
		"accept" => format!("Accepted “{}”", quest_title(db, g(0))),
		"turnin" => format!("Turned in “{}” (+{} xp)", quest_title(db, g(0)), g(7)),
		"abandon" => format!("Abandoned “{}”", quest_title(db, g(0))),
		"fail" => format!("Failed “{}”", quest_title(db, g(0))),
		"taxi" => format!("Took a flight (node {} → {})", g(0), g(1)),
		"land" => format!("Landed after {} s", g(1)),
		"enter" => format!("Entered {}", named(db, "map", g(0))),
		"encounter" => format!("Boss encounter {} {}", g(0), if g(1) == "1" { "defeated" } else { "wiped" }),
		"explore" => format!("Discovered {}{}", named(db, "area", g(0)), if g(1).is_empty() || g(1) == "0" { String::new() } else { format!(" (+{} xp)", g(1)) }),
		"learn" => format!("Learned {}", named(db, "spell", g(0))),
		"achieve" => format!("Achievement {}", g(0)),
		"rare" => format!("Spotted {} (rare)", named(db, "npc", g(0))),
		"bind" => "Set hearthstone".into(),
		_ => return None,
	})
}

/// Play sessions, oldest first: chunk spans merged while the gap between them is under SESSION_GAP.
pub fn sessions(db: &Connection, char_id: &str) -> rusqlite::Result<Vec<(f64, f64)>> {
	let mut st = db.prepare("SELECT first_t, last_t FROM chunks WHERE char_id = ?1 ORDER BY first_t")?;
	let spans: Vec<(f64, f64)> = st.query_map([char_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
	let mut sessions: Vec<(f64, f64)> = Vec::new();
	for (a, b) in spans {
		match sessions.last_mut() {
			Some(s) if a - s.1 <= SESSION_GAP => s.1 = s.1.max(b),
			_ => sessions.push((a, b)),
		}
	}
	Ok(sessions)
}

/// Where the character's last `hours` of *playtime* begin (wall-clock time between sessions does
/// not count): the live map's buffer. Everything older stays in the database for the journal.
pub fn playtime_from(sessions: &[(f64, f64)], hours: f64) -> f64 {
	let mut left = hours * 3600.0;
	for &(a, b) in sessions.iter().rev() {
		if b - a >= left {
			return b - left;
		}
		left -= b - a;
	}
	sessions.first().map_or(0.0, |s| s.0)
}

/// Journal events (with a line of text) of one character, or every character, in [from, to].
pub fn events(db: &Connection, char_id: Option<&str>, from: f64, to: f64, kinds: &[&str]) -> rusqlite::Result<Vec<Value>> {
	let frames = frames(db)?;
	let mut st = db.prepare("SELECT char_id, t, kind, map, x, y, fields FROM events WHERE (?1 IS NULL OR char_id = ?1) AND t >= ?2 AND t <= ?3 ORDER BY t")?;
	let rows = st.query_map(params![char_id, from, to], |r| {
		Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, Option<i64>>(5)?, r.get::<_, String>(6)?))
	})?;
	let mut out = Vec::new();
	for row in rows {
		let (ch, t, kind, map, x, y, fields) = row?;
		if !kinds.is_empty() && !kinds.contains(&kind.as_str()) {
			continue;
		}
		let f: Vec<String> = serde_json::from_str(&fields).unwrap_or_default();
		if let Some(text) = describe(db, &kind, &f) {
			out.push(json!({ "char": ch, "t": t, "kind": kind, "text": text, "pos": world_of(&frames, map, x, y) }));
		}
	}
	Ok(out)
}

/// The live map: per character, the last `hours` of playtime as a coarse trail (`tol` yards) and
/// its milestones. Bounded by playtime, so the payload stays small however long the history is.
pub fn overview(db: &Connection, hours: f64, tol: f64) -> rusqlite::Result<Value> {
	let ids: Vec<String> = db.prepare("SELECT char_id FROM characters")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
	let mut out = Vec::new();
	for id in ids {
		let sess = sessions(db, &id)?;
		if sess.is_empty() {
			continue;
		}
		let from = playtime_from(&sess, hours);
		let to = sess.last().unwrap().1;
		let (segs, total) = trail(db, &id, from, to, tol)?;
		let ev = events(db, Some(&id), from, to, &["level", "death", "mark", "encounter", "enter"])?;
		let sess_in: Vec<Value> = sess.iter().filter(|s| s.1 >= from).map(|s| json!([s.0.max(from), s.1])).collect();
		out.push(json!({ "char": id, "from": from, "to": to, "sessions": sess_in, "segments": segs, "points": total, "events": ev }));
	}
	Ok(json!({ "hours": hours, "characters": out }))
}

pub fn journal(db: &Connection, char_id: &str) -> rusqlite::Result<Value> {
	let frames = frames(db)?;
	let sessions = sessions(db, char_id)?;
	let mut out = Vec::new();
	for (start, end) in sessions.into_iter().rev() {
		let mut st = db.prepare("SELECT t, kind, map, x, y, fields FROM events WHERE char_id = ?1 AND t >= ?2 AND t <= ?3 ORDER BY t")?;
		let rows = st.query_map(params![char_id, start, end], |r| {
			Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, String>(5)?))
		})?;
		let mut events = Vec::new();
		let (mut kills, mut kill_xp, mut quests, mut deaths) = (0, 0, 0, 0);
		let mut levels: Vec<i64> = Vec::new();
		let mut zones: Vec<String> = Vec::new();
		let mut last_place = String::new();
		// The place before the last one, and when and where (in `events`) the last change was written.
		let mut before_place = String::new();
		let mut last_change: Option<(f64, usize)> = None;
		for row in rows {
			let (t, kind, map, x, y, fields) = row?;
			let f: Vec<String> = serde_json::from_str(&fields).unwrap_or_default();
			// Zone lines: none while the client has no zone text (loading screens), and only when the
			// place changes (the Recorder also writes one when the map or the text flickers). Standing
			// on a border flips A -> B -> A: a return within BORDER_FLIP seconds takes the detour's
			// line back instead of writing another.
			if kind == "zone" {
				let place = format!("{}\t{}", f.get(3).map_or("", String::as_str), f.get(4).map_or("", String::as_str));
				if f.get(3).is_none_or(|z| z.is_empty()) || place == last_place {
					continue;
				}
				if let Some((at, idx)) = last_change.filter(|(at, _)| place == before_place && t - at <= BORDER_FLIP) {
					let _ = at;
					if idx + 1 == events.len() {
						events.pop();
					}
					std::mem::swap(&mut last_place, &mut before_place);
					last_change = None;
					continue;
				}
				before_place = std::mem::replace(&mut last_place, place);
				last_change = Some((t, events.len()));
			}
			match kind.as_str() {
				"kill" => {
					kills += 1;
					kill_xp += f.get(6).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
				}
				"turnin" => quests += 1,
				"death" => deaths += 1,
				"level" => levels.extend(f.first().and_then(|v| v.parse::<i64>().ok())),
				"zone" => {
					if let Some(z) = f.get(3).filter(|z| !z.is_empty() && !zones.contains(z)) {
						zones.push(z.clone());
					}
				}
				_ => {}
			}
			if let Some(text) = describe(db, &kind, &f) {
				events.push(json!({ "t": t, "kind": kind, "text": text, "pos": world_of(&frames, map, x, y) }));
			}
		}
		let mut nst = db.prepare("SELECT id, t, text FROM notes WHERE char_id = ?1 AND t >= ?2 AND t <= ?3 ORDER BY t")?;
		let notes: Vec<Value> = nst
			.query_map(params![char_id, start, end + SESSION_GAP], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "t": r.get::<_, f64>(1)?, "text": r.get::<_, String>(2)? })))?
			.collect::<Result<_, _>>()?;
		let (dist, _) = distance(db, &frames, char_id, start, end)?;
		out.push(json!({
			"start": start, "end": end, "seconds": end - start, "zones": zones, "kills": kills, "killXp": kill_xp,
			"quests": quests, "deaths": deaths, "levels": levels, "yards": dist.round(), "events": events, "notes": notes,
		}));
	}
	Ok(Value::Array(out))
}

fn distance(db: &Connection, frames: &HashMap<i64, Frame>, char_id: &str, from: f64, to: f64) -> rusqlite::Result<(f64, usize)> {
	let mut st = db.prepare("SELECT map, x, y FROM positions WHERE char_id = ?1 AND t >= ?2 AND t <= ?3 ORDER BY t")?;
	let mut prev: Option<(i64, f64, f64)> = None;
	let (mut d, mut n) = (0.0, 0);
	for row in st.query_map(params![char_id, from, to], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))? {
		let (map, x, y) = row?;
		let Some(f) = frames.get(&map) else { continue };
		let (wx, wy) = f.world(x, y);
		if let Some((c, px, py)) = prev {
			let step = ((wx - px).powi(2) + (wy - py).powi(2)).sqrt();
			if c == f.c && step < TRAIL_JUMP {
				d += step;
			}
		}
		prev = Some((f.c, wx, wy));
		n += 1;
	}
	Ok((d, n))
}

/// Inventory slot names, 0 (ammo) to 19.
const SLOTS: [&str; 20] = [
	"Ammo", "Head", "Neck", "Shoulder", "Shirt", "Chest", "Waist", "Legs", "Feet", "Wrist", "Hands", "Finger", "Finger", "Trinket",
	"Trinket", "Back", "Main hand", "Off hand", "Ranged", "Tabard",
];

/// An item's display facts from the imported names (`forever-dash names`).
fn item(db: &Connection, id: i64) -> Value {
	db.query_row("SELECT name, quality, ilvl, req_level, inv_type, icon FROM items WHERE id = ?1", [id], |r| {
		Ok(json!({ "id": id, "name": r.get::<_, String>(0)?, "quality": r.get::<_, Option<i64>>(1)?, "ilvl": r.get::<_, Option<i64>>(2)?,
			"reqLevel": r.get::<_, Option<i64>>(3)?, "invType": r.get::<_, Option<i64>>(4)?, "icon": r.get::<_, Option<i64>>(5)? }))
	})
	.unwrap_or_else(|_| json!({ "id": id }))
}

/// "itemID:count" -> (id, count).
fn id_count(s: &str) -> Option<(i64, i64)> {
	let (a, b) = s.split_once(':').unwrap_or((s, "1"));
	Some((a.parse().ok()?, b.parse().unwrap_or(1)))
}

fn containers(db: &Connection, v: Option<&Value>) -> Value {
	let Some(Value::Object(bags)) = v else { return Value::Null };
	let mut out: Vec<(i64, Value)> = bags
		.iter()
		.filter_map(|(k, b)| {
			let bag: i64 = k.parse().ok()?;
			let mut slots: Vec<(i64, Value)> = b
				.get("slots")
				.and_then(Value::as_object)
				.map(|o| {
					o.iter()
						.filter_map(|(s, it)| {
							let (id, count) = id_count(it.as_str()?)?;
							let mut i = item(db, id);
							i["count"] = json!(count);
							i["slot"] = json!(s.parse::<i64>().ok()?);
							Some((s.parse().ok()?, i))
						})
						.collect()
				})
				.unwrap_or_default();
			slots.sort_by_key(|(s, _)| *s);
			let bag_item = b.get("item").and_then(Value::as_i64).map(|id| item(db, id));
			Some((bag, json!({ "bag": bag, "size": b.get("size"), "item": bag_item, "slots": slots.into_iter().map(|(_, i)| i).collect::<Vec<_>>() })))
		})
		.collect();
	out.sort_by_key(|(b, _)| *b);
	Value::Array(out.into_iter().map(|(_, b)| b).collect())
}

/// The character's latest snapshot (Polestar_DashSnapshot): gear by slot, bags and bank, with item facts.
pub fn snapshot(db: &Connection, char_id: &str) -> rusqlite::Result<Value> {
	let row: Option<(f64, String)> = db
		.query_row("SELECT saved, json FROM snapshots WHERE char_id = ?1 ORDER BY saved DESC LIMIT 1", [char_id], |r| Ok((r.get(0)?, r.get(1)?)))
		.ok();
	let Some((saved, text)) = row else { return Ok(Value::Null) };
	let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
	let mut equip = Vec::new();
	if let Some(Value::Object(e)) = v.get("equip") {
		for (k, s) in e {
			let (Ok(slot), Some(s)) = (k.parse::<usize>(), s.as_str()) else { continue };
			let Some(id) = s.split(':').nth(1).and_then(|x| x.parse::<i64>().ok()) else { continue };
			let mut i = item(db, id);
			i["slot"] = json!(slot);
			i["slotName"] = json!(SLOTS.get(slot).copied().unwrap_or("?"));
			i["itemString"] = json!(s);
			equip.push((slot, i));
		}
	}
	equip.sort_by_key(|(s, _)| *s);
	Ok(json!({
		"saved": saved, "name": v.get("name"), "realm": v.get("realm"), "money": v.get("money"),
		"stats": v.get("stats"), "statsAt": v.get("statsAt"),
		"equipAt": v.get("equipAt"), "bagsAt": v.get("bagsAt"), "bankAt": v.get("bankAt"),
		"equip": equip.into_iter().map(|(_, i)| i).collect::<Vec<_>>(),
		"bags": containers(db, v.get("bags")),
		"bank": containers(db, v.get("bank")),
	}))
}

/// Every item id the snapshots hold (equipped, carried, banked, the bags themselves): for the icon export.
pub fn item_ids(db: &Connection) -> rusqlite::Result<Vec<i64>> {
	let mut ids = std::collections::BTreeSet::new();
	let mut st = db.prepare("SELECT json FROM snapshots")?;
	for text in st.query_map([], |r| r.get::<_, String>(0))? {
		let v: Value = serde_json::from_str(&text?).unwrap_or(Value::Null);
		if let Some(Value::Object(e)) = v.get("equip") {
			ids.extend(e.values().filter_map(|s| s.as_str()?.split(':').nth(1)?.parse::<i64>().ok()));
		}
		for part in ["bags", "bank"] {
			if let Some(Value::Object(bags)) = v.get(part) {
				for b in bags.values() {
					ids.extend(b.get("item").and_then(Value::as_i64));
					if let Some(Value::Object(slots)) = b.get("slots") {
						ids.extend(slots.values().filter_map(|s| id_count(s.as_str()?).map(|(id, _)| id)));
					}
				}
			}
		}
	}
	Ok(ids.into_iter().collect())
}
