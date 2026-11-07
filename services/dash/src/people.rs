//! People met: the players our characters grouped, traded, duelled or fought with, or looked at
//! long enough to matter, from Polestar_DashSnapshot's `people` and `met` (People.lua). The
//! Recorder never records other players; this is ours and never relayed upstream. The dashboard
//! adds a rating and notes per player.
//!
//! Kept apart from the snapshot rows (which keep every save): every meeting the addon sent is kept
//! (it holds only its newest few hundred), and a player's facts are the latest read.

use std::collections::{BTreeMap, HashMap};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub const SCHEMA: &str = "
-- A player as last read in game: \"Name-Realm\" -> facts.
CREATE TABLE IF NOT EXISTS people (
	who TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	realm TEXT,
	class TEXT,
	race TEXT,
	sex INTEGER,
	level INTEGER,
	guild TEXT,
	faction TEXT,
	seen REAL
);
-- Each meeting: which of our characters, when, how (group, trade, duel, seen, fought, killedby,
-- killed), where (uiMap and hundredths of a percent) and a note (raid, won, lost).
CREATE TABLE IF NOT EXISTS met (
	char_id TEXT NOT NULL,
	t REAL NOT NULL,
	who TEXT NOT NULL,
	how TEXT NOT NULL,
	map INTEGER,
	x INTEGER,
	y INTEGER,
	note TEXT,
	PRIMARY KEY (char_id, t, who, how)
);
CREATE INDEX IF NOT EXISTS met_who ON met (who, t);
-- Yours: a rating (1-5) and notes per player, per group (groups.rs; '' on a site without groups).
CREATE TABLE IF NOT EXISTS person_notes (
	who TEXT PRIMARY KEY,
	rating INTEGER,
	note TEXT,
	at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_person_notes (
	grp TEXT NOT NULL,
	who TEXT NOT NULL,
	rating INTEGER,
	note TEXT,
	at INTEGER NOT NULL,
	PRIMARY KEY (grp, who)
);
-- Notes from before groups: moved over (groups.rs gives them to the first group).
INSERT OR IGNORE INTO group_person_notes (grp, who, rating, note, at) SELECT '', who, rating, note, at FROM person_notes;
DELETE FROM person_notes;
";

pub const HOWS: &[&str] = &["group", "trade", "duel", "seen", "fought", "killedby", "killed"];
const MAX_NOTE: usize = 4000;

/// Takes `people`, `met` and `peopleAt` out of a snapshot (they are stored here, not with it).
pub fn split(snap: &Value) -> (Value, Option<Value>, Option<Value>) {
	let mut rest = snap.clone();
	let Some(o) = rest.as_object_mut() else { return (rest, None, None) };
	let people = o.remove("people");
	let met = o.remove("met");
	o.remove("peopleAt");
	(rest, people, met)
}

fn s(v: &Value, k: &str) -> Option<String> {
	v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}
fn n(v: &Value, k: &str) -> Option<i64> {
	v.get(k).and_then(Value::as_i64)
}

/// Stores what one character's save says about the people it met.
pub fn store(tx: &Connection, char_id: &str, people: Option<&Value>, met: Option<&Value>) -> rusqlite::Result<()> {
	if let Some(Value::Object(people)) = people {
		for (who, p) in people {
			let Some(name) = s(p, "name") else { continue };
			if who.len() > 120 {
				continue;
			}
			let seen = p.get("seen").and_then(Value::as_f64).unwrap_or(0.0);
			tx.execute(
				"INSERT INTO people (who, name, realm, class, race, sex, level, guild, faction, seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
				 ON CONFLICT (who) DO UPDATE SET name = ?2, realm = ?3, class = COALESCE(?4, class), race = COALESCE(?5, race), sex = COALESCE(?6, sex),
				   level = COALESCE(?7, level), guild = COALESCE(?8, guild), faction = COALESCE(?9, faction), seen = ?10
				 WHERE seen IS NULL OR seen <= ?10",
				params![who, name, s(p, "realm"), s(p, "class"), s(p, "race"), n(p, "sex"), n(p, "level"), s(p, "guild"), s(p, "faction"), seen],
			)?;
		}
	}
	// `met` is a Lua array: an object keyed "1", "2"... after lua_json.
	let list: Vec<&Value> = match met {
		Some(Value::Object(o)) => o.values().collect(),
		Some(Value::Array(a)) => a.iter().collect(),
		_ => Vec::new(),
	};
	for m in list {
		let (Some(t), Some(who), Some(how)) = (m.get("t").and_then(Value::as_f64), s(m, "who"), s(m, "how")) else { continue };
		if !HOWS.contains(&how.as_str()) {
			continue;
		}
		tx.execute(
			"INSERT OR IGNORE INTO met (char_id, t, who, how, map, x, y, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
			params![char_id, t, who, how, n(m, "map"), n(m, "x"), n(m, "y"), s(m, "note")],
		)?;
	}
	Ok(())
}

/// A meeting as the journal and the person card read it.
#[derive(Clone, Debug)]
pub struct Met {
	pub char_id: String,
	pub t: f64,
	pub who: String,
	pub name: String,
	pub how: String,
	pub map: Option<i64>,
	pub x: Option<i64>,
	pub y: Option<i64>,
	pub note: Option<String>,
}

fn met_rows(db: &Connection, sql: &str, p: impl rusqlite::Params) -> rusqlite::Result<Vec<Met>> {
	let mut st = db.prepare(sql)?;
	let rows = st.query_map(p, |r| {
		let who: String = r.get(2)?;
		let name: Option<String> = r.get(8)?;
		Ok(Met {
			char_id: r.get(0)?,
			t: r.get(1)?,
			name: name.unwrap_or_else(|| who.split('-').next().unwrap_or(&who).to_string()),
			who,
			how: r.get(3)?,
			map: r.get(4)?,
			x: r.get(5)?,
			y: r.get(6)?,
			note: r.get(7)?,
		})
	})?;
	rows.collect()
}

const MET_COLS: &str = "m.char_id, m.t, m.who, m.how, m.map, m.x, m.y, m.note, p.name FROM met m LEFT JOIN people p ON p.who = m.who";

/// `char_id`'s meetings in [from, to], oldest first.
pub fn between(db: &Connection, char_id: &str, from: f64, to: f64) -> rusqlite::Result<Vec<Met>> {
	met_rows(db, &format!("SELECT {MET_COLS} WHERE m.char_id = ?1 AND m.t >= ?2 AND m.t <= ?3 ORDER BY m.t"), params![char_id, from, to])
}

/// The journal's line for a meeting; None for `seen` (too many to list: the People view has them).
pub fn line(m: &Met) -> Option<String> {
	let who = &m.name;
	Some(match m.how.as_str() {
		"group" if m.note.as_deref() == Some("raid") => format!("Joined a raid with {who}"),
		"group" => format!("Grouped with {who}"),
		"trade" => format!("Traded with {who}"),
		"duel" => match m.note.as_deref() {
			Some("won") => format!("Won a duel against {who}"),
			Some("lost") => format!("Lost a duel to {who}"),
			_ => format!("Duelled {who}"),
		},
		"fought" => format!("Attacked by {who}"),
		"killedby" => format!("Killed by {who}"),
		"killed" => format!("Killed {who}"),
		_ => return None,
	})
}

/// Our own characters among the people (a household's characters meet each other): who -> char id.
/// Matched on the name, and on the realm when Polestar gave us the realm's name.
fn ours(db: &Connection) -> rusqlite::Result<HashMap<String, String>> {
	let mut st = db.prepare(
		"SELECT p.who, c.char_id FROM people p JOIN characters c ON c.name = p.name AND (c.realm_name IS NULL OR c.realm_name = p.realm)",
	)?;
	let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
	rows.collect()
}

fn facts_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
	Ok(json!({
		"who": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "realm": r.get::<_, Option<String>>(2)?,
		"class": r.get::<_, Option<String>>(3)?, "race": r.get::<_, Option<String>>(4)?, "sex": r.get::<_, Option<i64>>(5)?,
		"level": r.get::<_, Option<i64>>(6)?, "guild": r.get::<_, Option<String>>(7)?, "faction": r.get::<_, Option<String>>(8)?,
		"seen": r.get::<_, Option<f64>>(9)?, "rating": r.get::<_, Option<i64>>(10)?, "note": r.get::<_, Option<String>>(11)?,
	}))
}

const PERSON_COLS: &str = "p.who, p.name, p.realm, p.class, p.race, p.sex, p.level, p.guild, p.faction, p.seen, n.rating, n.note
	FROM people p LEFT JOIN group_person_notes n ON n.who = p.who AND n.grp = ?1";

/// Everyone met (by one character, or by any), the latest meeting first: facts, your rating and
/// notes, how often and how, and which of our characters met them.
pub fn list(db: &Connection, char_id: Option<&str>, scope: &crate::groups::Scope) -> rusqlite::Result<Value> {
	let ours = ours(db)?;
	// who -> (first, last, count per how, our characters)
	type Seen = (f64, f64, BTreeMap<String, i64>, Vec<String>);
	let mut seen: BTreeMap<String, Seen> = BTreeMap::new();
	let mut st = db.prepare("SELECT who, how, char_id, MIN(t), MAX(t), COUNT(*) FROM met WHERE (?1 IS NULL OR char_id = ?1) GROUP BY who, how, char_id")?;
	let rows = st.query_map([char_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, f64>(3)?, r.get::<_, f64>(4)?, r.get::<_, i64>(5)?)))?;
	for row in rows {
		let (who, how, ch, first, last, count) = row?;
		if !scope.has(&ch) {
			continue;
		}
		let e = seen.entry(who).or_insert((f64::MAX, 0.0, BTreeMap::new(), Vec::new()));
		e.0 = e.0.min(first);
		e.1 = e.1.max(last);
		*e.2.entry(how).or_default() += count;
		if !e.3.contains(&ch) {
			e.3.push(ch);
		}
	}
	let mut st = db.prepare(&format!("SELECT {PERSON_COLS}"))?;
	let mut out: Vec<Value> = Vec::new();
	let rows = st.query_map([&scope.grp], facts_json)?;
	for row in rows {
		let mut p = row?;
		let who = p["who"].as_str().unwrap_or_default().to_string();
		// A player with no meeting by this character (only read, or met by another) is left out.
		let Some((first, last, hows, chars)) = seen.remove(&who) else { continue };
		p["first"] = json!(first);
		p["last"] = json!(last);
		p["count"] = json!(hows.values().sum::<i64>());
		p["hows"] = json!(hows);
		p["chars"] = json!(chars);
		p["ours"] = json!(ours.get(&who));
		out.push(p);
	}
	out.sort_by(|a, b| b["last"].as_f64().unwrap_or(0.0).total_cmp(&a["last"].as_f64().unwrap_or(0.0)));
	Ok(Value::Array(out))
}

/// One player: facts, your rating and notes, and every meeting (newest first) with its place.
pub fn person(db: &Connection, who: &str, scope: &crate::groups::Scope) -> rusqlite::Result<Value> {
	let Some(mut p) = db.query_row(&format!("SELECT {PERSON_COLS} WHERE p.who = ?2"), [&scope.grp, who], facts_json).optional()? else { return Ok(Value::Null) };
	p["ours"] = json!(ours(db)?.get(who));
	let frames = crate::read::frames(db)?;
	let mut zones = HashMap::new();
	let meetings: Vec<Value> = met_rows(db, &format!("SELECT {MET_COLS} WHERE m.who = ?1 ORDER BY m.t DESC LIMIT 500"), [who])?
		.into_iter()
		.filter(|m| scope.has(&m.char_id))
		.map(|m| {
			let zone = m.map.and_then(|map| crate::diary::zone_of(db, &mut zones, map));
			json!({ "char": m.char_id, "t": m.t, "how": m.how, "note": m.note, "text": line(&m).unwrap_or_else(|| format!("Saw {}", m.name)),
				"zone": zone, "pos": crate::read::world_of(&frames, m.map, m.x, m.y) })
		})
		.collect();
	// Only someone the group's characters met.
	if meetings.is_empty() {
		return Ok(Value::Null);
	}
	p["met"] = json!(meetings);
	Ok(p)
}

/// Your rating (1-5; 0 or none clears it) and notes for a player.
pub fn set_note(db: &Connection, grp: &str, who: &str, rating: Option<i64>, note: &str) -> Result<(), String> {
	if note.len() > MAX_NOTE {
		return Err("note too long".into());
	}
	let rating = rating.filter(|r| (1..=5).contains(r));
	let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
	let note = note.trim();
	if rating.is_none() && note.is_empty() {
		db.execute("DELETE FROM group_person_notes WHERE grp = ?1 AND who = ?2", [grp, who]).map_err(|e| e.to_string())?;
	} else {
		db.execute(
			"INSERT INTO group_person_notes (who, rating, note, at, grp) VALUES (?1, ?2, NULLIF(?3, ''), ?4, ?5)
			 ON CONFLICT (grp, who) DO UPDATE SET rating = ?2, note = NULLIF(?3, ''), at = ?4",
			params![who, rating, note, now, grp],
		)
		.map_err(|e| e.to_string())?;
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn db() -> Connection {
		crate::db::open(":memory:").unwrap()
	}

	fn save() -> Value {
		json!({
			"schema": 1, "money": 5, "equipAt": 100.0, "peopleAt": 200.0,
			"people": {
				"Ana-Realm Nine": { "name": "Ana", "realm": "Realm Nine", "class": "PRIEST", "race": "Human", "sex": 3, "level": 12, "guild": "Dawn", "seen": 150.0 },
				"Gruk-Other": { "name": "Gruk", "realm": "Other", "class": "WARRIOR", "seen": 160.0 }
			},
			"met": {
				"1": { "t": 120.0, "who": "Ana-Realm Nine", "how": "group" },
				"2": { "t": 130.0, "who": "Ana-Realm Nine", "how": "duel", "note": "won", "map": 1429, "x": 4000, "y": 5000 },
				"3": { "t": 140.0, "who": "Gruk-Other", "how": "seen" },
				"4": { "t": 141.0, "who": "Gruk-Other", "how": "dance" }
			}
		})
	}

	#[test]
	fn the_snapshot_keeps_its_own_fields_only() {
		let (rest, people, met) = split(&save());
		assert!(rest.get("people").is_none() && rest.get("met").is_none() && rest.get("peopleAt").is_none());
		assert_eq!(rest["money"], 5);
		assert!(people.is_some() && met.is_some());
	}

	#[test]
	fn meetings_are_kept_once_and_facts_only_get_newer() {
		let db = db();
		let (_, people, met) = split(&save());
		store(&db, "c1", people.as_ref(), met.as_ref()).unwrap();
		store(&db, "c1", people.as_ref(), met.as_ref()).unwrap();
		let n: i64 = db.query_row("SELECT COUNT(*) FROM met", [], |r| r.get(0)).unwrap();
		assert_eq!(n, 3, "sent twice, kept once; unknown kinds dropped");
		// An older read doesn't overwrite a newer one.
		let old = json!({ "Ana-Realm Nine": { "name": "Ana", "realm": "Realm Nine", "level": 9, "seen": 10.0 } });
		store(&db, "c2", Some(&old), None).unwrap();
		let level: i64 = db.query_row("SELECT level FROM people WHERE who = 'Ana-Realm Nine'", [], |r| r.get(0)).unwrap();
		assert_eq!(level, 12);
	}

	#[test]
	fn the_list_counts_meetings_per_kind_and_carries_your_notes() {
		let db = db();
		let (_, people, met) = split(&save());
		store(&db, "c1", people.as_ref(), met.as_ref()).unwrap();
		let us = crate::groups::Scope { grp: "g1".into(), name: None, chars: ["c1".to_string(), "c2".to_string()].into() };
		let them = crate::groups::Scope { grp: "g2".into(), name: None, chars: ["c9".to_string()].into() };
		set_note(&db, "g1", "Ana-Realm Nine", Some(5), " kind healer ").unwrap();
		let l = list(&db, None, &us).unwrap();
		let ana = l.as_array().unwrap().iter().find(|p| p["who"] == "Ana-Realm Nine").unwrap();
		assert_eq!(ana["count"], 2);
		assert_eq!(ana["hows"]["duel"], 1);
		assert_eq!(ana["rating"], 5);
		assert_eq!(ana["note"], "kind healer");
		assert_eq!(list(&db, Some("c2"), &us).unwrap().as_array().unwrap().len(), 0, "met by another character only");
		// Another group sees neither the meetings nor the notes.
		assert_eq!(list(&db, None, &them).unwrap().as_array().unwrap().len(), 0);
		assert_eq!(person(&db, "Ana-Realm Nine", &them).unwrap(), Value::Null);
		assert_eq!(person(&db, "Ana-Realm Nine", &us).unwrap()["rating"], 5);
		set_note(&db, "g1", "Ana-Realm Nine", Some(0), "").unwrap();
		assert_eq!(list(&db, None, &us).unwrap()[1]["rating"], Value::Null, "cleared");
	}


	#[test]
	fn journal_lines() {
		let m = |how: &str, note: Option<&str>| Met { char_id: "c".into(), t: 0.0, who: "Ana-R".into(), name: "Ana".into(), how: how.into(), map: None, x: None, y: None, note: note.map(str::to_string) };
		assert_eq!(line(&m("duel", Some("lost"))).unwrap(), "Lost a duel to Ana");
		assert_eq!(line(&m("group", Some("raid"))).unwrap(), "Joined a raid with Ana");
		assert_eq!(line(&m("killedby", None)).unwrap(), "Killed by Ana");
		assert!(line(&m("seen", None)).is_none());
	}
}
