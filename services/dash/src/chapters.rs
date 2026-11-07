//! Zone chapters: a character's story cut where its play moved to another zone. Each session has a
//! main zone (where it spent the most time); a chapter is a run of sessions with the same one.
//! Short sessions (a trip to town to train, a quick login) never start a chapter of their own.
//! Each chapter opens with a "previously" line over the chapter before, and a return to a zone
//! says when the character was last there. Computed from the stored events when read, like the
//! milestones.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::diary::{count, duration};

/// Sessions shorter than this (seconds) join the chapter they fall in instead of starting one.
const SHORT: f64 = 20.0 * 60.0;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
	/// 1 for the first.
	pub n: usize,
	pub zone: String,
	pub start: f64,
	pub end: f64,
	pub sessions: usize,
	/// Playtime (seconds), all the chapter's sessions.
	pub seconds: f64,
	/// The level as the chapter began, when known (a level-up before it, or its first one).
	pub level_from: Option<i64>,
	pub level_to: Option<i64>,
	pub quests: i64,
	pub deaths: i64,
	pub kills: i64,
	/// Where play went next (None for the chapter still going on).
	pub next: Option<String>,
	/// The opening lines: "Previously, in Elwynn Forest: ...", "Back in Westfall ...".
	pub intro: String,
}

/// Every chapter of a character, oldest first, from its sessions (oldest first).
pub fn all(db: &Connection, char_id: &str, sessions: &[(f64, f64)]) -> rusqlite::Result<Vec<Chapter>> {
	let mut st = db.prepare("SELECT t, kind, fields FROM events WHERE char_id = ?1 AND kind IN ('zone', 'level', 'turnin', 'death', 'kill') ORDER BY t")?;
	let rows: Vec<(f64, String, Vec<String>)> = st
		.query_map(params![char_id], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
		.map(|r| r.map(|(t, k, f)| (t, k, serde_json::from_str(&f).unwrap_or_default())))
		.collect::<Result<_, _>>()?;
	Ok(build(&rows, sessions))
}

/// The chapter a session (by its start) belongs to.
pub fn of(chapters: &[Chapter], start: f64) -> Option<&Chapter> {
	chapters.iter().rev().find(|c| c.start <= start + 1e-6)
}

fn build(rows: &[(f64, String, Vec<String>)], sessions: &[(f64, f64)]) -> Vec<Chapter> {
	let level_of = |f: &[String]| f.first().and_then(|v| v.parse::<i64>().ok());
	// Time per zone in each session: the zone holds from its line until the next one (or the end).
	let mut i = 0;
	let mut zone = String::new();
	let mut level: Option<i64> = None;
	struct S {
		start: f64,
		end: f64,
		main: Option<String>,
		level_at_start: Option<i64>,
		first_level_up: Option<i64>,
		level_end: Option<i64>,
		quests: i64,
		deaths: i64,
		kills: i64,
	}
	let mut ss: Vec<S> = Vec::new();
	for &(start, end) in sessions {
		// Everything before the session only moves the zone and level on.
		while i < rows.len() && rows[i].0 < start {
			match rows[i].1.as_str() {
				"zone" => zone = rows[i].2.get(3).filter(|z| !z.is_empty()).cloned().unwrap_or_else(|| zone.clone()),
				"level" => level = level_of(&rows[i].2).or(level),
				_ => {}
			}
			i += 1;
		}
		let mut s = S { start, end, main: None, level_at_start: level, first_level_up: None, level_end: level, quests: 0, deaths: 0, kills: 0 };
		let mut time: HashMap<String, f64> = HashMap::new();
		let mut since = start;
		while i < rows.len() && rows[i].0 <= end {
			let (t, kind, f) = &rows[i];
			match kind.as_str() {
				"zone" => {
					if let Some(z) = f.get(3).filter(|z| !z.is_empty() && **z != zone) {
						if !zone.is_empty() {
							*time.entry(zone.clone()).or_default() += t - since;
						}
						zone = z.clone();
						since = *t;
					}
				}
				"level" => {
					level = level_of(f).or(level);
					s.first_level_up = s.first_level_up.or(level);
					s.level_end = level;
				}
				"turnin" => s.quests += 1,
				"death" => s.deaths += 1,
				"kill" => s.kills += 1,
				_ => {}
			}
			i += 1;
		}
		if !zone.is_empty() {
			*time.entry(zone.clone()).or_default() += end - since;
		}
		// The most time; ties by name, so the same data always gives the same chapters.
		s.main = time.into_iter().max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(&a.0))).map(|(z, _)| z);
		ss.push(s);
	}

	let mut out: Vec<Chapter> = Vec::new();
	for s in &ss {
		let starts_new = match (out.last(), &s.main) {
			(None, _) => true,
			(Some(c), Some(z)) => *z != c.zone && s.end - s.start >= SHORT,
			(Some(_), None) => false,
		};
		// The first chapter may begin with a short session; it takes the zone of its first real one.
		if out.len() == 1 && out[0].zone.is_empty() {
			if let Some(z) = &s.main {
				out[0].zone = z.clone();
			}
		}
		if starts_new {
			let from = s.level_at_start.or(s.first_level_up.map(|l| l - 1));
			out.push(Chapter { n: out.len() + 1, zone: s.main.clone().unwrap_or_default(), start: s.start, level_from: from, level_to: from, ..Default::default() });
		}
		let c = out.last_mut().unwrap();
		c.end = s.end;
		c.sessions += 1;
		c.seconds += s.end - s.start;
		c.level_from = c.level_from.or(s.level_at_start).or(s.first_level_up.map(|l| l - 1));
		c.level_to = s.level_end.or(c.level_to);
		c.quests += s.quests;
		c.deaths += s.deaths;
		c.kills += s.kills;
	}
	out.retain(|c| !c.zone.is_empty());
	for k in 0..out.len() {
		out[k].n = k + 1;
		out[k].next = out.get(k + 1).map(|c| c.zone.clone());
		out[k].intro = intro(&out[..k], &out[k]);
	}
	out
}

/// What the chapter went through, as a clause after "I": "climbed from level 5 to 10 and finished
/// eighteen quests in about three hours".
fn recap(c: &Chapter) -> String {
	let mut parts = Vec::new();
	match (c.level_from, c.level_to) {
		(Some(a), Some(b)) if b > a => parts.push(format!("climbed from level {a} to {b}")),
		_ => {}
	}
	if c.quests > 0 {
		parts.push(format!("finished {} quest{}", count(c.quests), if c.quests == 1 { "" } else { "s" }));
	}
	if parts.is_empty() && c.kills > 0 {
		parts.push(format!("fought {} foe{}", count(c.kills), if c.kills == 1 { "" } else { "s" }));
	}
	if parts.is_empty() {
		return format!("spent {}", duration((c.seconds / 60.0).round() as i64));
	}
	let mut s = crate::diary::list(&parts);
	s.push_str(&format!(" in {}", duration((c.seconds / 60.0).round() as i64)));
	if c.deaths > 0 {
		s.push_str(&format!(", dying {}", match c.deaths {
			1 => "once".to_string(),
			2 => "twice".to_string(),
			n => format!("{} times", count(n)),
		}));
	}
	s
}

fn intro(before: &[Chapter], c: &Chapter) -> String {
	let Some(prev) = before.last() else {
		return format!("Where it begins: {}.", c.zone);
	};
	let mut s = format!("Previously, in {}: I {}.", prev.zone, recap(prev));
	if let Some(last) = before.iter().rev().skip(1).find(|b| b.zone == c.zone) {
		let at = last.level_to.map(|l| format!(" at level {l}")).unwrap_or_default();
		s.push_str(&format!(" Now back in {}, where chapter {} ended{at}.", c.zone, last.n));
	}
	s
}

#[cfg(test)]
mod tests {
	use super::*;

	fn zone(t: f64, z: &str) -> (f64, String, Vec<String>) {
		(t, "zone".into(), vec!["".into(), "".into(), "".into(), z.into(), "".into()])
	}
	fn ev(t: f64, kind: &str, f0: &str) -> (f64, String, Vec<String>) {
		(t, kind.into(), vec![f0.into()])
	}

	#[test]
	fn chapters_follow_the_main_zone_and_skip_short_trips() {
		let h = 3600.0;
		let rows = vec![
			zone(10.0, "Elwynn Forest"),
			ev(100.0, "turnin", "1"),
			ev(200.0, "level", "6"),
			ev(5000.0, "level", "7"),
			// session 2: still Elwynn, then a short trip to Stormwind (own session, 10 min)
			ev(2.0 * h + 50.0, "turnin", "2"),
			zone(4.0 * h, "Stormwind City"),
			// session 4: Westfall for an hour
			zone(6.0 * h + 5.0, "Westfall"),
			ev(6.0 * h + 100.0, "level", "8"),
			ev(6.0 * h + 200.0, "death", ""),
			// session 5: back to Elwynn
			zone(9.0 * h, "Elwynn Forest"),
		];
		let sessions = [(0.0, 1.5 * h), (2.0 * h, 3.0 * h), (4.0 * h, 4.0 * h + 600.0), (6.0 * h, 7.0 * h), (9.0 * h, 10.0 * h)];
		let ch = build(&rows, &sessions);
		let zones: Vec<(&str, usize)> = ch.iter().map(|c| (c.zone.as_str(), c.sessions)).collect();
		assert_eq!(zones, vec![("Elwynn Forest", 3), ("Westfall", 1), ("Elwynn Forest", 1)]);
		assert_eq!((ch[0].level_from, ch[0].level_to, ch[0].quests), (Some(5), Some(7), 2));
		assert_eq!(ch[0].intro, "Where it begins: Elwynn Forest.");
		assert_eq!(ch[1].intro, "Previously, in Elwynn Forest: I climbed from level 5 to 7 and finished two quests in about three hours.");
		assert_eq!(
			ch[2].intro,
			"Previously, in Westfall: I climbed from level 7 to 8 in about an hour, dying once. Now back in Elwynn Forest, where chapter 1 ended at level 7."
		);
		assert_eq!(ch[0].next.as_deref(), Some("Westfall"));
		assert_eq!(of(&ch, 4.0 * h).map(|c| c.n), Some(1));
		assert_eq!(of(&ch, 9.0 * h).map(|c| c.n), Some(3));
	}
}
