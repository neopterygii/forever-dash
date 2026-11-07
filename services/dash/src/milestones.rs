//! Milestones: a character's firsts and round numbers, found in its whole recorded history (the
//! first mining node, a new kind of herb, Journeyman Mining, the first flight, the first visit to a
//! zone or a dungeon, the 100th creature slain...). Computed from the stored events when read, so a
//! new rule applies to everything already recorded. The journal shows each in its session's log;
//! the diary tells the session's ones.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Milestone {
	pub t: f64,
	/// What kind: gather, profession, place, travel, fight, count, level.
	pub kind: &'static str,
	/// The log's line ("First mining node: Copper Vein").
	pub text: String,
	/// The diary's words for it, a verb phrase after "I" ("mined my first ore, a Copper Vein").
	pub phrase: String,
}

/// Professions by skill line (the client's SkillLine ids, the same on every Classic-era client).
const PROFESSIONS: &[(i64, &str)] = &[
	(171, "Alchemy"),
	(164, "Blacksmithing"),
	(333, "Enchanting"),
	(202, "Engineering"),
	(182, "Herbalism"),
	(165, "Leatherworking"),
	(186, "Mining"),
	(393, "Skinning"),
	(197, "Tailoring"),
	(185, "Cooking"),
	(129, "First Aid"),
	(356, "Fishing"),
];
/// A profession's training ranks, by the skill cap they bring.
const RANKS: &[(i64, &str)] = &[(150, "Journeyman"), (225, "Expert"), (300, "Artisan")];
const SKILL_STEPS: &[i64] = &[75, 150, 225, 300];
const QUEST_COUNTS: &[i64] = &[1, 10, 25, 50, 100, 200, 300, 500, 750, 1000];
const KILL_COUNTS: &[i64] = &[100, 500, 1000, 2500, 5000, 10000, 25000];
const GATHER_COUNTS: &[i64] = &[100, 250, 500, 1000, 2500, 5000];

/// What a gathering record was: `loot` from a herb, a vein, a skinned creature or a catch, or a
/// lock picked (the `gather` record: a lock gives no `loot` gather token). None for anything else.
pub fn gathered(kind: &str, f: &[String]) -> Option<&'static str> {
	let g = |i: usize| f.get(i).map(String::as_str).unwrap_or("");
	match kind {
		// loot: srcKind, srcId, P (2-4), gather
		"loot" => match g(5) {
			"h" => Some("herb"),
			"m" => Some("ore"),
			"s" => Some("skin"),
			"f" => Some("fish"),
			_ => None,
		},
		// gather: objectId, P (1-3), how
		"gather" if g(4) == "l" => Some("lock"),
		_ => None,
	}
}

fn ordinal(n: i64) -> String {
	let suffix = match (n % 10, n % 100) {
		(1, 11) | (2, 12) | (3, 13) => "th",
		(1, _) => "st",
		(2, _) => "nd",
		(3, _) => "rd",
		_ => "th",
	};
	format!("{n}{suffix}")
}

/// Every milestone of `char_id`, oldest first.
pub fn all(db: &Connection, char_id: &str) -> rusqlite::Result<Vec<Milestone>> {
	let name = |kind: &str, id: &str| crate::names::name(db, kind, id);
	let mut out = Vec::new();
	let mut push = |t: f64, kind: &'static str, text: String, phrase: String| out.push(Milestone { t, kind, text, phrase });

	let mut seen_gather: HashSet<&'static str> = HashSet::new();
	let mut seen_nodes: HashSet<String> = HashSet::new();
	let mut seen_zones: HashSet<String> = HashSet::new();
	let mut seen_instances: HashSet<String> = HashSet::new();
	let mut skills: HashMap<i64, (i64, i64)> = HashMap::new(); // line -> (rank, max) last seen
	let (mut quests, mut kills) = (0i64, 0i64);
	let mut gathers: HashMap<&'static str, i64> = HashMap::new();
	let (mut died, mut flew, mut elite, mut rare, mut boss, mut won) = (false, false, false, false, false, false);
	let mut zone_cache = HashMap::new();

	let mut st = db.prepare(
		"SELECT t, kind, fields, map FROM events WHERE char_id = ?1
		 AND kind IN ('loot', 'gather', 'skill', 'zone', 'enter', 'encounter', 'taxi', 'death', 'kill', 'turnin', 'level') ORDER BY t",
	)?;
	let rows = st.query_map(params![char_id], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<i64>>(3)?)))?;
	for row in rows {
		let (t, kind, fields, map) = row?;
		let f: Vec<String> = serde_json::from_str(&fields).unwrap_or_default();
		let g = |i: usize| f.get(i).map(String::as_str).unwrap_or("");
		if let Some(what) = gathered(&kind, &f) {
			let n = gathers.entry(what).or_default();
			*n += 1;
			if GATHER_COUNTS.contains(n) {
				// (the log's words after "100th", the diary's verb and noun)
				let (log, verb, noun) = match what {
					"herb" => ("herb gathered", "gathered", "herb"),
					"ore" => ("ore vein mined", "mined", "vein"),
					"skin" => ("creature skinned", "skinned", "creature"),
					"fish" => ("fish caught", "caught", "fish"),
					_ => ("lock picked", "picked", "lock"),
				};
				let nth = ordinal(*n);
				push(t, "count", format!("{nth} {log}"), format!("{verb} my {nth} {noun}"));
			}
		}
		match kind.as_str() {
			// gather: objectId, P, how ("l" a lock picked; herbs, ore and fish come from loot)
			"gather" if g(4) == "l" && gathers.get("lock") == Some(&1) => {
				push(t, "gather", "First lock picked".into(), "picked my first lock".into());
			}
			// loot: srcKind, srcId, P (3), gather, items, wanted
			"loot" => {
				let gather = g(5);
				// (seen key, log noun, diary verb phrase)
				let (what, noun, did) = match gather {
					"h" => ("herb", "herb gathered", "gathered my first herb"),
					"m" => ("mine", "mining node", "mined my first ore"),
					"s" => ("skin", "creature skinned", "skinned my first creature"),
					"f" => ("fish", "fish caught", "caught my first fish"),
					_ => continue,
				};
				let src = match gather {
					"h" | "m" => name("object", g(1)),
					"s" => name("npc", g(1)),
					_ => g(6).split(';').next().and_then(|it| it.split(':').next()).and_then(|id| crate::names::item_name(db, id)),
				};
				if seen_gather.insert(what) {
					let (text, phrase) = match &src {
						// Parentheses, not commas: the diary lists several phrases in one sentence.
						Some(s) => (format!("First {noun}: {s}"), format!("{did} ({s})")),
						None => (format!("First {noun}"), did.to_string()),
					};
					push(t, "gather", text, phrase);
					if let Some(s) = src.filter(|_| matches!(gather, "h" | "m")) {
						seen_nodes.insert(s);
					}
				} else if let Some(s) = src.filter(|_| matches!(gather, "h" | "m")) {
					// A new kind of herb or ore: the profession moving on.
					if seen_nodes.insert(s.clone()) {
						let label = if gather == "h" { "New herb" } else { "New ore" };
						push(t, "gather", format!("{label}: {s}"), format!("found {} for the first time", crate::diary::with_article(&s)));
					}
				}
			}
			// skill: skillLineId, rank, max
			"skill" => {
				let (Ok(line), Ok(rank), Ok(max)) = (g(0).parse::<i64>(), g(1).parse::<i64>(), g(2).parse::<i64>()) else { continue };
				let Some(&(_, prof)) = PROFESSIONS.iter().find(|(id, _)| *id == line) else { continue };
				match skills.get(&line).copied() {
					None => {
						// The first record of a profession: learned now if it starts low, else known from before recording.
						if rank <= 5 {
							push(t, "profession", format!("Learned {prof}"), format!("took up {prof}"));
						}
					}
					Some((old_rank, old_max)) => {
						for &(cap, title) in RANKS {
							if old_max < cap && max >= cap {
								push(t, "profession", format!("{title} {prof}"), format!("trained as a {title} in {prof}"));
							}
						}
						for &step in SKILL_STEPS {
							if old_rank < step && rank >= step {
								push(t, "profession", format!("{prof} reached {step}"), format!("brought my {prof} to {step}"));
							}
						}
					}
				}
				skills.insert(line, (rank, max));
			}
			"zone" => {
				let zone = map.and_then(|m| crate::diary::zone_of(db, &mut zone_cache, m)).or_else(|| Some(g(3).to_string()).filter(|z| !z.is_empty()));
				if let Some(z) = zone {
					if seen_zones.insert(z.clone()) {
						push(t, "place", format!("First visit to {z}"), format!("set foot in {z} for the first time"));
					}
				}
			}
			"enter" => {
				if let Some(n) = name("map", g(0)) {
					if seen_instances.insert(n.clone()) {
						push(t, "place", format!("First time in {n}"), format!("went into {n} for the first time"));
					}
				}
			}
			"encounter" if g(1) == "1" && !won => {
				won = true;
				push(t, "fight", "First boss encounter won".into(), "won my first boss encounter".into());
			}
			"taxi" if !flew => {
				flew = true;
				push(t, "travel", "First flight".into(), "took my first flight".into());
			}
			// death: P (0-2), killerNpc, killerLevel
			"death" if !died => {
				died = true;
				match crate::diary::npc_label(db, g(3)) {
					Some(k) => push(t, "fight", format!("First death ({})", k), format!("died for the first time ({k})")),
					None => push(t, "fight", "First death".into(), "died for the first time".into()),
				}
			}
			// kill: npcId, level, cls
			"kill" => {
				kills += 1;
				if KILL_COUNTS.contains(&kills) {
					push(t, "count", format!("{} creature slain", ordinal(kills)), format!("slew my {} creature", ordinal(kills)));
				}
				let n = name("npc", g(0));
				let label = n.clone().unwrap_or_else(|| "an unknown foe".into());
				match g(2) {
					"e" if !elite => {
						elite = true;
						push(t, "fight", format!("First elite slain: {label}"), format!("brought down my first elite ({label})"));
					}
					"r" | "R" if !rare => {
						rare = true;
						push(t, "fight", format!("First rare slain: {label}"), format!("slew my first rare ({label})"));
					}
					"b" if !boss => {
						boss = true;
						push(t, "fight", format!("First boss slain: {label}"), format!("slew my first boss ({label})"));
					}
					_ => {}
				}
			}
			"turnin" => {
				quests += 1;
				if QUEST_COUNTS.contains(&quests) {
					if quests == 1 {
						push(t, "count", "First errand done".into(), "saw my first errand through".into());
					} else {
						push(t, "count", format!("{} errands done", quests), format!("saw my {} errand through", ordinal(quests)));
					}
				}
			}
			"level" => {
				if let Ok(l) = g(0).parse::<i64>() {
					if l % 10 == 0 {
						push(t, "level", format!("Level {l}"), format!("reached level {l}"));
					}
				}
			}
			_ => {}
		}
	}
	Ok(out)
}

/// The milestones of `char_id` within [from, to].
pub fn between(all: &[Milestone], from: f64, to: f64) -> Vec<Milestone> {
	all.iter().filter(|m| m.t >= from && m.t <= to).cloned().collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn db_with(events: &[(f64, &str, &str)]) -> Connection {
		let db = crate::db::open(":memory:").unwrap();
		db.execute_batch(
			"INSERT INTO names (kind, id, name) VALUES ('object', 1731, 'Copper Vein'), ('object', 1732, 'Tin Vein'),
			 ('object', 1617, 'Silverleaf'), ('npc', 2955, 'Plainstrider'), ('npc', 448, 'Hogger');
			 INSERT INTO npc_named (id) VALUES (448);
			 INSERT INTO items (id, name) VALUES (6291, 'Raw Brilliant Smallfish');",
		)
		.unwrap();
		for (t, kind, fields) in events {
			db.execute("INSERT INTO events (char_id, t, kind, fields) VALUES ('c', ?1, ?2, ?3)", params![t, kind, fields]).unwrap();
		}
		db
	}

	#[test]
	fn gathering_firsts_new_nodes_and_profession_ranks() {
		let db = db_with(&[
			(1.0, "skill", r#"["186","1","75"]"#),
			(2.0, "loot", r#"["o","1731","1412","10","10","m","2770:1",""]"#),
			(3.0, "loot", r#"["o","1731","1412","10","10","m","2770:1",""]"#),
			(4.0, "loot", r#"["o","1732","1412","10","10","m","2771:1",""]"#),
			(5.0, "loot", r#"["o","1617","1412","10","10","h","765:1",""]"#),
			(6.0, "loot", r#"["c","2955","1412","10","10","s","2318:1",""]"#),
			(7.0, "loot", r#"["","","1412","10","10","f","6291:1",""]"#),
			(8.0, "skill", r#"["186","75","75"]"#),
			(9.0, "skill", r#"["186","75","150"]"#),
			(10.0, "kill", r#"["448","11","e","1412","10","10","","","",""]"#),
		]);
		let got: Vec<(String, String)> = all(&db, "c").unwrap().into_iter().map(|m| (m.text, m.phrase)).collect();
		let texts: Vec<&str> = got.iter().map(|g| g.0.as_str()).collect();
		assert_eq!(
			texts,
			vec![
				"Learned Mining",
				"First mining node: Copper Vein",
				"New ore: Tin Vein",
				"First herb gathered: Silverleaf",
				"First creature skinned: Plainstrider",
				"First fish caught: Raw Brilliant Smallfish",
				"Mining reached 75",
				"Journeyman Mining",
				"First elite slain: Hogger",
			]
		);
		assert_eq!(got[1].1, "mined my first ore (Copper Vein)");
		assert_eq!(got[2].1, "found a Tin Vein for the first time");
		assert_eq!(got[8].1, "brought down my first elite (Hogger)");
	}

	#[test]
	fn locks_and_gathering_counts() {
		let mut ev: Vec<(f64, &str, String)> = vec![(0.5, "gather", r#"["1","1412","10","10","l","633","40"]"#.into())];
		for i in 0..100 {
			ev.push((1.0 + i as f64, "loot", r#"["o","1617","1412","10","10","h","765:1",""]"#.into()));
		}
		let db = db_with(&ev.iter().map(|(t, k, f)| (*t, *k, f.as_str())).collect::<Vec<_>>());
		let got: Vec<(String, String)> = all(&db, "c").unwrap().into_iter().map(|m| (m.text, m.phrase)).collect();
		assert_eq!(got[0], ("First lock picked".into(), "picked my first lock".into()));
		assert_eq!(got[1].0, "First herb gathered: Silverleaf");
		assert_eq!(got.last().unwrap(), &("100th herb gathered".into(), "gathered my 100th herb".into()));
	}

	#[test]
	fn a_profession_known_before_recording_is_not_learned_again() {
		let db = db_with(&[(1.0, "skill", r#"["393","81","150"]"#), (2.0, "skill", r#"["393","82","150"]"#)]);
		assert!(all(&db, "c").unwrap().is_empty());
	}

	#[test]
	fn ordinals() {
		assert_eq!(ordinal(1), "1st");
		assert_eq!(ordinal(2), "2nd");
		assert_eq!(ordinal(11), "11th");
		assert_eq!(ordinal(22), "22nd");
		assert_eq!(ordinal(100), "100th");
		assert_eq!(ordinal(113), "113th");
	}
}
