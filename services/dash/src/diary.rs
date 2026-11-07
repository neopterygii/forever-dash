//! The diary: each play session told as a short first-person entry, above the journal's log.
//!
//! Every session gets an entry written from templates (here, deterministic, instant, free). When
//! the server is given a model (`serve --ai-url ... --ai-key-file ... --ai-model diary`, an
//! OpenAI-compatible endpoint: the LiteLLM gateway on Unraid), a background worker also asks it to
//! write the closed sessions in prose and keeps the answer; that replaces the template entry. A
//! failed call keeps the template entry and is tried again later: no weaker fallback model, since
//! a small local model was found to invent numbers. Your own edit replaces both and is never
//! overwritten.
//!
//! Only facts from the recording go into an entry or a prompt: the character, places, quests,
//! creatures, levels, deaths, discoveries, spells, flights, instances and marks of that session.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{TimeZone, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::read::{quest_title, sessions, SESSION_GAP};

pub const SCHEMA: &str = "
-- A session's entry: `ai` (the model's prose, for the session as it ended at `end`) or `you`
-- (your own edit). Template entries are written on the fly and not stored.
CREATE TABLE IF NOT EXISTS diary (
	char_id TEXT NOT NULL,
	start REAL NOT NULL,
	source TEXT NOT NULL,
	end REAL NOT NULL,
	text TEXT NOT NULL,
	model TEXT,
	at INTEGER NOT NULL,
	PRIMARY KEY (char_id, start, source)
);
";

/// A session is told by the model once it is over: nothing recorded for this long after its end.
const CLOSED_AFTER: f64 = SESSION_GAP + 15.0 * 60.0;

/// What happened in one session, from the recording (the input of both the template and the prompt).
#[derive(Serialize, Default, Debug)]
pub struct Facts {
	pub name: String,
	pub race: String,
	pub class: String,
	pub sex: String,
	/// Local time the session began and ended ("evening", "21:40").
	pub began: String,
	pub ended: String,
	pub time_of_day: String,
	pub minutes: i64,
	/// Zones in the order first visited.
	pub zones: Vec<String>,
	/// Places (zone — subzone) in order, repeats dropped.
	pub places: Vec<String>,
	pub first_place: String,
	pub last_place: String,
	pub level_from: Option<i64>,
	pub level_to: Option<i64>,
	pub quests_done: Vec<String>,
	pub quests_taken: Vec<String>,
	pub quests_abandoned: Vec<String>,
	/// Quests that failed (a timer ran out, an escort died).
	pub quests_failed: Vec<String>,
	pub kills: i64,
	/// The creatures killed most: (name, count), most first.
	pub foes: Vec<(String, i64)>,
	pub elites_or_bosses: Vec<String>,
	/// Deaths: the killer's name when known.
	pub deaths: Vec<Option<String>>,
	pub rares_seen: Vec<String>,
	pub discovered: Vec<String>,
	pub learned: Vec<String>,
	pub flights: i64,
	pub instances: Vec<String>,
	pub bosses_defeated: i64,
	pub hearth_set_at: Option<String>,
	pub marks: Vec<String>,
	/// The session's milestones, as verb phrases after "I" (milestones.rs).
	pub firsts: Vec<String>,
	pub yards_walked: i64,
	/// Gathering: herbs, ore veins, creatures skinned, fish caught, locks picked.
	pub herbs: i64,
	pub ore: i64,
	pub skins: i64,
	pub fish: i64,
	pub locks: i64,
	/// Minutes spent in a group, the biggest party (other members) and raid (with me).
	pub grouped_minutes: i64,
	pub party: i64,
	pub raid: i64,
	/// The dashboard's other characters grouped with me at the same time.
	pub played_with: Vec<String>,
}

fn local_tz() -> chrono_tz::Tz {
	std::env::var("TZ").ok().and_then(|z| z.parse().ok()).unwrap_or(chrono_tz::UTC)
}

fn name_of(db: &Connection, kind: &str, id: &str) -> Option<String> {
	crate::names::name(db, kind, id)
}

/// A creature as a sentence names it: "Hogger", or "a Scarlet Initiate" (one of many).
pub(crate) fn npc_label(db: &Connection, id: &str) -> Option<String> {
	let name = name_of(db, "npc", id)?;
	let named: bool = id.parse::<i64>().ok().and_then(|i| db.query_row("SELECT 1 FROM npc_named WHERE id = ?1", [i], |_| Ok(true)).optional().ok().flatten()).unwrap_or(false);
	Some(if named { name } else { with_article(&name) })
}

pub(crate) fn with_article(name: &str) -> String {
	let vowel = name.chars().next().is_some_and(|c| "AEIOUaeiou".contains(c));
	format!("{} {name}", if vowel { "an" } else { "a" })
}

/// The zone a uiMap belongs to (itself when it is a zone, else its nearest zone parent), by name.
pub(crate) fn zone_of(db: &Connection, cache: &mut HashMap<i64, Option<String>>, map: i64) -> Option<String> {
	if let Some(z) = cache.get(&map) {
		return z.clone();
	}
	let mut id = map;
	let mut out = None;
	for _ in 0..6 {
		let Ok(Some((ty, parent))) = db.query_row("SELECT type, parent FROM maps WHERE id = ?1", [id], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?))).optional() else { break };
		if ty == Some(3) {
			out = name_of(db, "uimap", &id.to_string());
			break;
		}
		match parent {
			Some(p) if p > 0 => id = p,
			_ => break,
		}
	}
	cache.insert(map, out.clone());
	out
}

fn push_unique(v: &mut Vec<String>, s: String) {
	if !s.is_empty() && !v.contains(&s) {
		v.push(s);
	}
}

/// The facts of `char_id`'s session [start, end].
pub fn facts(db: &Connection, char_id: &str, start: f64, end: f64) -> rusqlite::Result<Facts> {
	let mut f = Facts::default();
	let who: Option<(Option<String>, Option<String>, Option<String>, Option<i64>)> = db
		.query_row("SELECT name, race, class, sex FROM characters WHERE char_id = ?1", [char_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
		.optional()?;
	if let Some((name, race, class, sex)) = who {
		f.name = name.unwrap_or_default();
		f.race = crate::read::pretty_token(&race.unwrap_or_default());
		f.class = crate::read::pretty_token(&class.unwrap_or_default());
		f.sex = match sex {
			Some(3) => "female",
			Some(2) => "male",
			_ => "",
		}
		.into();
	}
	let tz = local_tz();
	let at = |t: f64| tz.timestamp_opt(t as i64, 0).single();
	if let (Some(a), Some(b)) = (at(start), at(end)) {
		f.began = a.format("%H:%M").to_string();
		f.ended = b.format("%H:%M").to_string();
		f.time_of_day = match a.hour() {
			5..=11 => "morning",
			12..=16 => "afternoon",
			17..=21 => "evening",
			_ => "night",
		}
		.into();
	}
	f.minutes = ((end - start) / 60.0).round() as i64;

	let mut foes: HashMap<String, i64> = HashMap::new();
	let mut zones: HashMap<i64, Option<String>> = HashMap::new();
	let mut st = db.prepare("SELECT kind, fields, map FROM events WHERE char_id = ?1 AND t >= ?2 AND t <= ?3 ORDER BY t")?;
	let rows = st.query_map(params![char_id, start, end], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?)))?;
	for row in rows {
		let (kind, fields, map) = row?;
		let v: Vec<String> = serde_json::from_str(&fields).unwrap_or_default();
		let g = |i: usize| v.get(i).map(String::as_str).unwrap_or("");
		match kind.as_str() {
			"zone" => {
				// The zone from the map (the zone text is sometimes a subzone's); the client's texts for the place.
				let (text, sub) = (g(3), g(4));
				if text.is_empty() {
					continue;
				}
				let zone_name = map.and_then(|m| zone_of(db, &mut zones, m)).unwrap_or_else(|| text.to_string());
				let zone = zone_name.as_str();
				let sub = if sub.is_empty() && text != zone { text } else { sub };
				push_unique(&mut f.zones, zone.to_string());
				// "Subzone in Zone"; the template drops the zone when it is the session's only one.
				let place = if sub.is_empty() || sub == zone { zone.to_string() } else { format!("{sub} in {zone}") };
				if f.first_place.is_empty() {
					f.first_place = place.clone();
				}
				if f.places.last() != Some(&place) {
					f.places.push(place.clone());
				}
				f.last_place = place;
			}
			"level" => {
				if let Ok(l) = g(0).parse::<i64>() {
					f.level_from.get_or_insert(l - 1);
					f.level_to = Some(l);
				}
			}
			"accept" => push_unique(&mut f.quests_taken, quest_title(db, g(0))),
			"turnin" => push_unique(&mut f.quests_done, quest_title(db, g(0))),
			"abandon" => push_unique(&mut f.quests_abandoned, quest_title(db, g(0))),
			"fail" => push_unique(&mut f.quests_failed, quest_title(db, g(0))),
			"kill" => {
				f.kills += 1;
				if let Some(n) = name_of(db, "npc", g(0)) {
					if matches!(g(2), "e" | "R" | "b") {
						push_unique(&mut f.elites_or_bosses, n.clone());
					}
					*foes.entry(n).or_default() += 1;
				}
			}
			"death" => f.deaths.push(npc_label(db, g(3))),
			"rare" => push_unique(&mut f.rares_seen, name_of(db, "npc", g(0)).unwrap_or_default()),
			"explore" => push_unique(&mut f.discovered, name_of(db, "area", g(0)).unwrap_or_default()),
			"learn" => push_unique(&mut f.learned, name_of(db, "spell", g(0)).unwrap_or_default()),
			"taxi" => f.flights += 1,
			"enter" => push_unique(&mut f.instances, name_of(db, "map", g(0)).unwrap_or_default()),
			"encounter" => {
				if g(1) == "1" {
					f.bosses_defeated += 1;
				}
			}
			// Where: the subzone (an inn's), else the innkeeper.
			"bind" => {
				f.hearth_set_at = Some(f.last_place.clone())
					.filter(|p| p.contains(" in "))
					.or_else(|| npc_label(db, g(0)).map(|k| format!("{k}'s inn")))
			}
			"mark" => push_unique(&mut f.marks, g(3).to_string()),
			_ => {}
		}
		match crate::milestones::gathered(&kind, &v) {
			Some("herb") => f.herbs += 1,
			Some("ore") => f.ore += 1,
			Some("skin") => f.skins += 1,
			Some("fish") => f.fish += 1,
			Some("lock") => f.locks += 1,
			_ => {}
		}
	}
	let gs = crate::group::summary(&crate::group::spans(db, char_id)?, &crate::group::others(db, char_id)?, start, end);
	f.grouped_minutes = (gs.seconds / 60.0).round() as i64;
	f.party = gs.party;
	f.raid = gs.raid;
	f.played_with = gs.with.into_iter().map(|w| w.1).collect();
	f.firsts = crate::milestones::between(&crate::milestones::all(db, char_id)?, start, end).into_iter().map(|m| m.phrase).collect();
	// A quest both taken and handed in is told once, as done.
	f.quests_taken.retain(|q| !f.quests_done.contains(q) && !f.quests_failed.contains(q));
	let mut foes: Vec<(String, i64)> = foes.into_iter().collect();
	foes.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
	foes.truncate(5);
	f.foes = foes;
	let frames = crate::read::frames(db)?;
	f.yards_walked = crate::read::distance(db, &frames, char_id, start, end)?.0.round() as i64;
	Ok(f)
}

// ---------------------------------------------------------------------------------------------
// The template entry.

const SMALL: [&str; 21] = [
	"no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
	"sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

fn count(n: i64) -> String {
	usize::try_from(n).ok().and_then(|i| SMALL.get(i)).map_or_else(|| n.to_string(), |s| s.to_string())
}

fn times(n: i64) -> String {
	match n {
		1 => "once".into(),
		2 => "twice".into(),
		_ => format!("{} times", count(n)),
	}
}

/// "A", "A and B", "A, B and C".
fn list(items: &[String]) -> String {
	match items {
		[] => String::new(),
		[a] => a.clone(),
		[rest @ .., last] => format!("{} and {last}", rest.join(", ")),
	}
}

/// Up to `n` items, then "and N more".
fn some(items: &[String], n: usize, quote: bool) -> String {
	let q = |s: &String| if quote { format!("“{s}”") } else { s.clone() };
	if items.len() <= n {
		return list(&items.iter().map(q).collect::<Vec<_>>());
	}
	let shown: Vec<String> = items[..n].iter().map(q).collect();
	format!("{}, and {} more", shown.join(", "), count((items.len() - n) as i64))
}

/// A creature's name in the plural ("Rot Hide Gnoll" -> "Rot Hide Gnolls").
fn plural(name: &str) -> String {
	let (head, last) = name.rsplit_once(' ').map_or(("", name), |(h, l)| (h, l));
	let lower = last.to_lowercase();
	if ["vermin", "sheep", "deer", "fish", "moose", "murloc spawn", "kin"].contains(&lower.as_str()) {
		return name.to_string();
	}
	let irregular = [("wolf", "wolves"), ("man", "men"), ("woman", "women"), ("thief", "thieves"), ("elf", "elves"), ("dwarf", "dwarves"), ("worg", "worgs"), ("mouse", "mice"), ("ox", "oxen"), ("child", "children")];
	let p = if let Some((_, pl)) = irregular.iter().find(|(s, _)| *s == lower) {
		let mut c = last.chars();
		match c.next() {
			Some(f) if f.is_uppercase() => f.to_uppercase().chain(pl.chars().skip(1)).collect(),
			_ => pl.to_string(),
		}
	} else if lower.ends_with('s') || lower.ends_with('x') || lower.ends_with("ch") || lower.ends_with("sh") {
		format!("{last}es")
	} else if lower.ends_with('y') && !lower.ends_with("ay") && !lower.ends_with("ey") && !lower.ends_with("oy") {
		format!("{}ies", &last[..last.len() - 1])
	} else {
		format!("{last}s")
	};
	if head.is_empty() { p } else { format!("{head} {p}") }
}

fn duration(minutes: i64) -> String {
	match minutes {
		0..=4 => "a few minutes".into(),
		5..=44 => format!("{} minutes", count(minutes / 5 * 5)),
		45..=74 => "about an hour".into(),
		75..=104 => "an hour and a half".into(),
		_ => {
			let h = (minutes as f64 / 60.0).round() as i64;
			format!("about {} hours", count(h))
		}
	}
}

/// Picks one of `options` the same way every time for the same session.
fn pick<'a>(seed: u64, salt: u64, options: &[&'a str]) -> &'a str {
	let x = seed.wrapping_mul(6364136223846793005).wrapping_add(salt.wrapping_mul(1442695040888963407));
	options[((x >> 33) % options.len() as u64) as usize]
}

pub fn seed(char_id: &str, start: f64) -> u64 {
	let mut h: u64 = 1469598103934665603;
	for b in char_id.bytes().chain((start as i64).to_le_bytes()) {
		h = (h ^ b as u64).wrapping_mul(1099511628211);
	}
	h
}

/// The session as a short first-person entry, from the facts alone.
pub fn template(f: &Facts, seed: u64) -> String {
	let mut out: Vec<String> = Vec::new();
	// Places name their zone only when the session saw more than one.
	let only = (f.zones.len() == 1).then(|| format!(" in {}", f.zones[0]));
	let place = |p: &str| match &only {
		Some(z) => p.strip_suffix(z.as_str()).unwrap_or(p).to_string(),
		None => p.to_string(),
	};
	let (first_place, last_place) = (place(&f.first_place), place(&f.last_place));
	let hearth = f.hearth_set_at.as_deref().map(place);
	let when = match f.time_of_day.as_str() {
		"morning" => "this morning",
		"afternoon" => "this afternoon",
		"evening" => "this evening",
		_ => "tonight",
	};
	let long = duration(f.minutes);
	// Opening: where and how long.
	if first_place.is_empty() || f.zones.len() == 1 && f.zones[0] == first_place {
		match f.zones.first() {
			Some(z) => out.push(format!("I spent {long} in {z} {when}.")),
			None => out.push(format!("I was out for {long} {when}.")),
		}
	} else if f.zones.len() > 1 {
		out.push(format!("I set out from {first_place} {when} and spent {long} on the road through {}.", list(&f.zones)));
	} else {
		let opener = pick(seed, 1, &["I spent {long} in {zone} {when}, starting from {place}.", "{When} I began at {place} and spent {long} in {zone}.", "{long} in {zone} {when}; I started at {place}."]);
		let zone = f.zones.first().cloned().unwrap_or_default();
		let mut s = opener.replace("{long}", &long).replace("{zone}", &zone).replace("{place}", &first_place).replace("{when}", when);
		s = s.replace("{When}", &capitalize(when));
		out.push(capitalize(&s));
	}
	if let Some(p) = &hearth {
		out.push(format!("I made {p} my home for now and set my hearthstone there."));
	}
	// Errands.
	if !f.quests_done.is_empty() {
		let n = f.quests_done.len() as i64;
		out.push(if n == 1 {
			format!("I saw one errand through: {}.", some(&f.quests_done, 1, true))
		} else {
			let named: Vec<String> = f.quests_done.iter().take(3).map(|q| format!("“{q}”")).collect();
			if n <= 3 {
				format!("I saw {} errands through: {}.", count(n), list(&named))
			} else {
				format!("I saw {} errands through, {} among them.", count(n), list(&named))
			}
		});
	}
	if !f.quests_taken.is_empty() {
		out.push(format!("{} {}.", pick(seed, 2, &["I also agreed to", "And I promised to look into", "There is more to do: I took on"]), some(&f.quests_taken, 3, true)));
	}
	if !f.quests_abandoned.is_empty() {
		out.push(format!("I gave up on {}.", some(&f.quests_abandoned, 2, true)));
	}
	if !f.quests_failed.is_empty() {
		out.push(format!("{} slipped through my fingers.", capitalize(&some(&f.quests_failed, 2, true))));
	}
	if let Some(s) = company(f) {
		out.push(s);
	}
	// Fighting.
	if f.kills > 0 {
		let foes: Vec<String> = f.foes.iter().take(2).map(|(n, c)| if *c > 1 { plural(n) } else { n.clone() }).collect();
		let mut s = match f.kills {
			1 => "One creature fell to me".to_string(),
			2..=20 => format!("{} creatures fell to me", capitalize(&count(f.kills))),
			_ => format!("In all, {} creatures fell to me", f.kills),
		};
		if !foes.is_empty() && f.kills > 1 {
			s.push_str(&format!(", most of them {}", list(&foes)));
		}
		out.push(format!("{s}."));
	}
	if !f.elites_or_bosses.is_empty() {
		out.push(format!("Among them was {}, no ordinary foe.", some(&f.elites_or_bosses, 2, false)));
	}
	if !f.deaths.is_empty() {
		let named: Vec<String> = f.deaths.iter().flatten().cloned().collect();
		out.push(match (f.deaths.len(), named.as_slice()) {
			(1, [k]) => format!("{} killed me, and I had to find my way back.", capitalize(k)),
			(1, _) => "I died once and had to find my way back.".into(),
			(n, []) => format!("I died {}.", times(n as i64)),
			(n, ks) => format!("I died {}, {}.", times(n as i64), if ks.len() == 1 { format!("once to {}", ks[0]) } else { format!("to {}", list(&ks.iter().take(3).cloned().collect::<Vec<_>>())) }),
		});
	}
	// Seeing the world.
	if !f.discovered.is_empty() {
		out.push(format!("I found {} for the first time.", some(&f.discovered, 3, false)));
	}
	if !f.rares_seen.is_empty() {
		out.push(format!("I caught sight of {}, a rare one.", some(&f.rares_seen, 2, false)));
	}
	if !f.instances.is_empty() {
		let b = if f.bosses_defeated > 0 { format!(" and brought down {} of the powers inside", count(f.bosses_defeated)) } else { String::new() };
		out.push(format!("I went into {}{b}.", list(&f.instances)));
	}
	if f.flights > 0 {
		out.push(format!("I flew {}.", times(f.flights)));
	}
	if let Some(s) = gathering(f) {
		out.push(format!("Along the way I {s}."));
	}
	// Growing.
	if !f.learned.is_empty() {
		out.push(format!("I learned {}.", some(&f.learned, 3, false)));
	}
	if let (Some(a), Some(b)) = (f.level_from, f.level_to) {
		out.push(if b - a <= 1 { format!("I reached level {b}.") } else { format!("I grew from level {a} to {b}.") });
	}
	if !f.firsts.is_empty() {
		let shown: Vec<String> = f.firsts.iter().take(4).cloned().collect();
		let more = if f.firsts.len() > 4 { format!(", and {} more firsts besides", count((f.firsts.len() - 4) as i64)) } else { String::new() };
		out.push(format!("{} I {}{more}.", pick(seed, 5, &["A day of firsts, too:", "And some firsts:", "New things, too:"]), list(&shown)));
	}
	for m in f.marks.iter().take(2) {
		out.push(format!("I noted down: “{m}”."));
	}
	// Closing.
	// The last place, when it says more than the zone already named.
	let last_is_zone = only.as_deref().is_some_and(|z| z.trim_start_matches(" in ") == last_place) || f.zones.contains(&last_place);
	if !last_place.is_empty() && last_place != first_place && !last_is_zone {
		let walked = if f.yards_walked >= 1000 { format!(", some {} yards from where I first set foot", round_yards(f.yards_walked)) } else { String::new() };
		out.push(format!("{} {}{walked}.", pick(seed, 3, &["I stopped at", "The day ended at", "I rested at last at"]), last_place));
	} else if f.yards_walked >= 1000 {
		out.push(format!("All told I walked some {} yards.", round_yards(f.yards_walked)));
	}
	if out.len() == 1 && f.quests_done.is_empty() && f.kills == 0 {
		out.push(pick(seed, 4, &["A quiet one.", "Not much else to tell.", "Little else happened."]).to_string());
	}
	out.join(" ")
}

/// Who I was with: "I spent most of it with Rena", "For a while I travelled with a party of three."
fn company(f: &Facts) -> Option<String> {
	if f.grouped_minutes < 3 {
		return None;
	}
	let most = f.grouped_minutes * 3 >= f.minutes * 2;
	let how_long = if most { "most of it" } else { "a while" };
	let group = if f.raid > 0 { format!("a raid of {}", count(f.raid)) } else { format!("a party of {}", count(f.party + 1)) };
	Some(if !f.played_with.is_empty() {
		format!("I spent {how_long} with {}.", list(&f.played_with))
	} else if most {
		format!("I travelled with {group} for most of it.")
	} else {
		format!("For a while I travelled with {group}.")
	})
}

/// "gathered twelve herbs, mined five veins and picked a lock", or None.
fn gathering(f: &Facts) -> Option<String> {
	let one = |n: i64, verb: &str, a: &str, many: &str| match n {
		0 => None,
		1 => Some(format!("{verb} {a}")),
		_ => Some(format!("{verb} {} {many}", count(n))),
	};
	let parts: Vec<String> = [
		one(f.herbs, "gathered", "a herb", "herbs"),
		one(f.ore, "mined", "a vein", "veins"),
		one(f.skins, "skinned", "a creature", "creatures"),
		one(f.fish, "caught", "a fish", "fish"),
		one(f.locks, "picked", "a lock", "locks"),
	]
	.into_iter()
	.flatten()
	.collect();
	(!parts.is_empty()).then(|| list(&parts))
}

fn round_yards(y: i64) -> String {
	let r = if y >= 10000 { (y + 500) / 1000 * 1000 } else { (y + 50) / 100 * 100 };
	let s = r.to_string();
	let mut out = String::new();
	for (i, c) in s.chars().enumerate() {
		if i > 0 && (s.len() - i) % 3 == 0 {
			out.push(',');
		}
		out.push(c);
	}
	out
}

fn capitalize(s: &str) -> String {
	let mut c = s.chars();
	c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

// ---------------------------------------------------------------------------------------------
// The model's entry.

/// Bumped when the prompt or its facts change: entries written with an older one are written again.
const PROMPT_VERSION: u32 = 3;

const SYSTEM: &str = "You write one diary entry for a World of Warcraft character, in their own first-person voice, about one play session. \
Use only the facts given: never invent places, people, quests, items, weather, numbers or outcomes. \
Never give clock times or exact figures; the facts already say how long and how far in words, use those or leave them out. \
Write names exactly as given (quest names in quotes, with their capitals). Do not list everything: tell the session as a small story, \
picking the few moments that matter most. You may describe feelings and atmosphere in keeping with the character's race and class. \
Avoid game jargon such as experience points, 'quest', 'turned in' or 'level 8': say it the way a person in that world would. \
Length: the number of words the facts ask for. Plain prose, no headings, no lists, no title.";

/// What the model is told: the facts in words, trimmed to what an entry can use.
fn prompt_facts(f: &Facts) -> Value {
	let little = f.kills < 10 && f.quests_done.len() + f.quests_taken.len() < 2 && f.discovered.is_empty() && f.deaths.is_empty() && f.level_to.is_none() && f.instances.is_empty();
	let named = |v: &[String], n: usize| -> Value {
		json!({ "count": v.len(), "named": v.iter().take(n).collect::<Vec<_>>() })
	};
	let who = [f.sex.as_str(), f.race.as_str(), f.class.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
	let mut v = json!({
		"who": if who.is_empty() { f.name.clone() } else { format!("{}, a {who}", f.name) },
		"time_of_day": f.time_of_day,
		"how_long": duration(f.minutes),
		"zones": f.zones,
		"began_at": f.first_place,
		"ended_at": f.last_place,
		"words": if little { "40 to 70" } else { "110 to 160" },
	});
	let o = v.as_object_mut().unwrap();
	let mut put = |k: &str, val: Value| {
		o.insert(k.into(), val);
	};
	if !f.quests_done.is_empty() { put("errands_finished", named(&f.quests_done, 3)); }
	if !f.quests_taken.is_empty() { put("errands_taken_on", named(&f.quests_taken, 2)); }
	if !f.quests_abandoned.is_empty() { put("errands_given_up", named(&f.quests_abandoned, 1)); }
	if !f.quests_failed.is_empty() { put("errands_failed", named(&f.quests_failed, 2)); }
	if f.grouped_minutes >= 3 {
		let group = if f.raid > 0 { format!("a raid of {}", f.raid) } else { format!("a party of {}", f.party + 1) };
		let mut c = json!({ "for": duration(f.grouped_minutes), "in": group });
		if !f.played_with.is_empty() { c["with"] = json!(f.played_with); }
		put("had_company", c);
	}
	if let Some(g) = gathering(f) { put("gathered", json!(g)); }
	if f.kills > 0 {
		let foes: Vec<String> = f.foes.iter().take(3).map(|(n, c)| if *c > 1 { plural(n) } else { n.clone() }).collect();
		let many = match f.kills { 1 => "one".to_string(), 2..=20 => count(f.kills), _ => format!("more than {}", f.kills / 10 * 10) };
		put("fought", json!({ "creatures_killed": many, "mostly": foes, "notable_foes": f.elites_or_bosses.iter().take(2).collect::<Vec<_>>() }));
	}
	if !f.deaths.is_empty() { put("died", json!({ "times": times(f.deaths.len() as i64), "killed_by": f.deaths.iter().flatten().take(3).collect::<Vec<_>>() })); }
	if !f.rares_seen.is_empty() { put("rare_creatures_seen", json!(f.rares_seen.iter().take(2).collect::<Vec<_>>())); }
	if !f.discovered.is_empty() { put("places_found", json!(f.discovered.iter().take(3).collect::<Vec<_>>())); }
	if !f.learned.is_empty() { put("learned", named(&f.learned, 3)); }
	if let (Some(a), Some(b)) = (f.level_from, f.level_to) { put("grew_stronger", json!(format!("from level {a} to {b}"))); }
	if f.flights > 0 { put("flew", json!(times(f.flights))); }
	if !f.instances.is_empty() { put("went_into", json!({ "places": f.instances, "powers_defeated_inside": f.bosses_defeated })); }
	if let Some(h) = &f.hearth_set_at { put("made_home_at", json!(h)); }
	if !f.marks.is_empty() { put("own_notes", json!(f.marks.iter().take(2).collect::<Vec<_>>())); }
	if !f.firsts.is_empty() { put("milestones_firsts", json!(f.firsts.iter().take(5).collect::<Vec<_>>())); }
	if f.yards_walked >= 3000 { put("walked", json!(format!("about {} yards", round_yards(f.yards_walked)))); }
	v
}

/// Too little happened for prose: the template entry says it better.
fn worth_prose(f: &Facts) -> bool {
	f.minutes >= 5 || f.kills > 0 || !f.quests_done.is_empty() || f.level_to.is_some()
}

pub struct Ai {
	pub url: String,
	pub key: String,
	pub model: String,
}

impl Ai {
	/// From `serve --ai-url URL --ai-key-file FILE [--ai-model diary]`; None when not set.
	pub fn from_args(args: &[String]) -> Option<Ai> {
		let get = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).cloned();
		let url = get("--ai-url")?;
		let key = get("--ai-key-file").and_then(|f| std::fs::read_to_string(f).ok()).map(|k| k.trim().to_string()).unwrap_or_default();
		Some(Ai { url, key, model: get("--ai-model").unwrap_or_else(|| "diary".into()) })
	}

	fn write(&self, http: &reqwest::blocking::Client, f: &Facts) -> Result<(String, String), String> {
		let body = json!({
			"model": self.model,
			"messages": [
				{ "role": "system", "content": SYSTEM },
				{ "role": "user", "content": format!("Facts:\n{}", serde_json::to_string_pretty(&prompt_facts(f)).unwrap_or_default()) },
			],
			"temperature": 0.8,
			"max_tokens": 600,
		});
		let mut req = http.post(&self.url).json(&body);
		if !self.key.is_empty() {
			req = req.bearer_auth(&self.key);
		}
		let resp = req.send().map_err(|e| e.to_string())?;
		let status = resp.status();
		let v: Value = resp.json().map_err(|e| format!("{status}: {e}"))?;
		if !status.is_success() {
			return Err(format!("{status}: {}", v["error"]["message"].as_str().unwrap_or("")));
		}
		let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
		let model = format!("{} v{PROMPT_VERSION}", v["model"].as_str().unwrap_or(&self.model));
		if text.split_whitespace().count() < 25 {
			return Err(format!("too short an answer ({} words)", text.split_whitespace().count()));
		}
		// Clock times are the one slip the prompt can't fully stop: send it back.
		if text.split_whitespace().any(|w| { let w = w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ':'); w.len() >= 4 && w.contains(':') && w.split(':').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) }) {
			return Err("the answer gave a clock time".into());
		}
		Ok((text, model))
	}
}

/// Sessions to tell with the model: closed, and with no model entry for the session as it ended.
fn pending(db: &Connection, now: f64) -> rusqlite::Result<Vec<(String, f64, f64)>> {
	let ids: Vec<String> = db.prepare("SELECT char_id FROM characters")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
	let mut out = Vec::new();
	for id in ids {
		for (start, end) in sessions(db, &id)? {
			if now - end < CLOSED_AFTER {
				continue;
			}
			let have: Option<(f64, Option<String>)> =
				db.query_row("SELECT end, model FROM diary WHERE char_id = ?1 AND start = ?2 AND source = 'ai'", params![id, start], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
			let current = have.as_ref().is_some_and(|(e, m)| (e - end).abs() <= 1.0 && m.as_deref().is_some_and(|m| m.ends_with(&format!(" v{PROMPT_VERSION}"))));
			if !current {
				out.push((id.clone(), start, end));
			}
		}
	}
	// Newest first: what was just played is what gets read.
	out.sort_by(|a, b| b.1.total_cmp(&a.1));
	Ok(out)
}

/// The worker: every few minutes, writes the pending sessions one at a time, spaced out (the free
/// tier's per-minute limit); on a failure it waits for the next round.
pub fn run(ai: Ai, db_path: String) {
	let http = match reqwest::blocking::Client::builder().timeout(Duration::from_secs(90)).build() {
		Ok(h) => h,
		Err(e) => return eprintln!("diary: {e}"),
	};
	loop {
		match crate::db::open(&db_path) {
			Ok(db) => {
				let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
				let todo = pending(&db, now).unwrap_or_default();
				for (id, start, end) in todo.into_iter().take(20) {
					let f = match facts(&db, &id, start, end) {
						Ok(f) if !worth_prose(&f) => {
							// Kept as the template's: drop an older model entry for it.
							let _ = db.execute("DELETE FROM diary WHERE char_id = ?1 AND start = ?2 AND source = 'ai'", params![id, start]);
							continue;
						}
						Ok(f) => f,
						Err(e) => {
							eprintln!("diary: facts {id} {start}: {e}");
							continue;
						}
					};
					match ai.write(&http, &f) {
						Ok((text, model)) => {
							let _ = db.execute(
								"INSERT OR REPLACE INTO diary (char_id, start, source, end, text, model, at) VALUES (?1, ?2, 'ai', ?3, ?4, ?5, ?6)",
								params![id, start, end, text, model, now as i64],
							);
							println!("diary: wrote {id} {start} ({model})");
						}
						Err(e) => {
							eprintln!("diary: {id} {start}: {e} (template kept; next round)");
							break;
						}
					}
					std::thread::sleep(Duration::from_secs(8));
				}
			}
			Err(e) => eprintln!("diary: {e}"),
		}
		std::thread::sleep(Duration::from_secs(300));
	}
}

/// The entry shown for a session: yours, else the model's for the session as it ended, else the template's.
pub fn entry(db: &Connection, char_id: &str, start: f64, end: f64) -> rusqlite::Result<Value> {
	let mine: Option<(String, i64)> =
		db.query_row("SELECT text, at FROM diary WHERE char_id = ?1 AND start = ?2 AND source = 'you'", params![char_id, start], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
	let ai: Option<(String, Option<String>, f64, i64)> = db
		.query_row("SELECT text, model, end, at FROM diary WHERE char_id = ?1 AND start = ?2 AND source = 'ai'", params![char_id, start], |r| {
			Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
		})
		.optional()?;
	let ai_now = ai.filter(|a| (a.2 - end).abs() <= 1.0 && a.1.as_deref().is_some_and(|m| m.ends_with(&format!(" v{PROMPT_VERSION}"))));
	if let Some((text, at)) = mine {
		return Ok(json!({ "text": text, "source": "you", "at": at, "generated": ai_now.is_some() }));
	}
	if let Some((text, model, _, at)) = ai_now {
		return Ok(json!({ "text": text, "source": "ai", "model": model, "at": at }));
	}
	let f = facts(db, char_id, start, end)?;
	Ok(json!({ "text": template(&f, seed(char_id, start)), "source": "template" }))
}

/// Your own text for a session (empty: back to the written one).
pub fn set_mine(db: &Connection, char_id: &str, start: f64, text: &str) -> rusqlite::Result<()> {
	let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
	if text.trim().is_empty() {
		db.execute("DELETE FROM diary WHERE char_id = ?1 AND start = ?2 AND source = 'you'", params![char_id, start])?;
	} else {
		db.execute(
			"INSERT OR REPLACE INTO diary (char_id, start, source, end, text, model, at) VALUES (?1, ?2, 'you', ?2, ?3, NULL, ?4)",
			params![char_id, start, text.trim(), now],
		)?;
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn meera() -> Facts {
		Facts {
			name: "Meera".into(),
			race: "Undead".into(),
			class: "Warlock".into(),
			sex: "female".into(),
			time_of_day: "night".into(),
			minutes: 124,
			zones: vec!["Tirisfal Glades".into()],
			places: vec![],
			first_place: "Gallows' End Tavern in Tirisfal Glades".into(),
			last_place: "The North Coast in Tirisfal Glades".into(),
			level_from: Some(7),
			level_to: Some(9),
			quests_done: vec!["Gordo's Task".into(), "A Putrid Task".into(), "Sticks and Bones".into(), "Discipline".into()],
			quests_taken: vec!["Doom Weed".into()],
			kills: 167,
			foes: vec![("Rot Hide Gnoll".into(), 40), ("Darkhound".into(), 20)],
			deaths: vec![],
			rares_seen: vec!["Lost Soul".into()],
			discovered: vec!["Ruins of Lordaeron".into(), "Garren's Haunt".into()],
			learned: vec!["Bane of Agony".into(), "Fear".into()],
			hearth_set_at: Some("Gallows' End Tavern in Tirisfal Glades".into()),
			yards_walked: 11280,
			..Default::default()
		}
	}

	#[test]
	fn a_template_entry_reads_as_prose() {
		let t = template(&meera(), 7);
		assert!(t.to_lowercase().contains("about two hours"), "{t}");
		assert!(t.contains("“Gordo's Task”"), "{t}");
		assert!(t.contains("Rot Hide Gnolls and Darkhounds"), "{t}");
		assert!(t.contains("I grew from level 7 to 9."), "{t}");
		assert!(t.contains("11,000 yards"), "{t}");
		assert!(!t.contains("xp"), "{t}");
		assert!(t.contains("I stopped at The North Coast,") || t.contains("at The North Coast,") , "{t}");
		assert_eq!(t.matches("Tirisfal Glades").count(), 1, "{t}");
		// The same session always reads the same.
		assert_eq!(t, template(&meera(), 7));
	}

	#[test]
	fn a_start_in_the_zone_itself_is_not_repeated() {
		let f = Facts { minutes: 2, time_of_day: "morning".into(), zones: vec!["Mulgore".into()], first_place: "Mulgore".into(), last_place: "Mulgore".into(), ..Default::default() };
		let t = template(&f, 1);
		assert!(t.starts_with("I spent a few minutes in Mulgore this morning."), "{t}");
		assert_eq!(t.matches("Mulgore").count(), 1, "{t}");
	}

	#[test]
	fn the_prompt_gets_words_not_figures() {
		let v = prompt_facts(&meera());
		let s = v.to_string();
		assert!(!s.contains("167"), "{s}");
		assert!(s.contains("more than 160"), "{s}");
		assert!(s.contains("about 11,000 yards"), "{s}");
		assert!(s.contains("about two hours"), "{s}");
		assert_eq!(v["errands_finished"]["named"].as_array().unwrap().len(), 3);
		assert_eq!(v["words"], "110 to 160");
	}

	#[test]
	fn plurals_and_counts() {
		assert_eq!(plural("Rot Hide Gnoll"), "Rot Hide Gnolls");
		assert_eq!(plural("Gray Forest Wolf"), "Gray Forest Wolves");
		assert_eq!(plural("Scarlet Zealot"), "Scarlet Zealots");
		assert_eq!(plural("Duskbat"), "Duskbats");
		assert_eq!(plural("Mangy Duskbat"), "Mangy Duskbats");
		assert_eq!(plural("Young Fleshripper"), "Young Fleshrippers");
		assert_eq!(plural("Rattlecage Skeleton"), "Rattlecage Skeletons");
		assert_eq!(plural("Night Web Spider"), "Night Web Spiders");
		assert_eq!(plural("Kobold Laborer"), "Kobold Laborers");
		assert_eq!(plural("Bloodsail Deckhand"), "Bloodsail Deckhands");
		assert_eq!(plural("Fly"), "Flies");
		assert_eq!(plural("Kobold Vermin"), "Kobold Vermin");
		assert_eq!(with_article("Scarlet Initiate"), "a Scarlet Initiate");
		assert_eq!(with_article("Ashenvale Bear"), "an Ashenvale Bear");
		assert_eq!(count(3), "three");
		assert_eq!(count(167), "167");
		assert_eq!(list(&["a".into(), "b".into(), "c".into()]), "a, b and c");
		assert_eq!(round_yards(11280), "11,000");
		assert_eq!(round_yards(3260), "3,300");
	}
}
