//! Group play, from the Recorder's `group` records (size, raid; written at login and whenever
//! the group changes). The record never says who is in the group, by design. What we can tell:
//! how long a session was spent grouped and how big the group was, and when two of the
//! characters on this dashboard were grouped at the same time, that they played together (the
//! household's own characters: two strangers' groups overlapping by chance is unlikely enough).

use rusqlite::{params, Connection};

use crate::read::{sessions, SESSION_GAP};

/// Overlap needed before two characters count as having played together.
pub const TOGETHER_MIN: f64 = 120.0;

/// A stretch of time spent in a group.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Span {
	pub from: f64,
	pub to: f64,
	/// The other party members (1-4), or the raid's size with the player.
	pub size: i64,
	pub raid: bool,
}

/// The `group` records of `char_id`: (t, size, raid), oldest first.
pub fn records(db: &Connection, char_id: &str) -> rusqlite::Result<Vec<(f64, i64, bool)>> {
	let mut st = db.prepare("SELECT t, fields FROM events WHERE char_id = ?1 AND kind = 'group' ORDER BY t")?;
	let rows = st.query_map([char_id], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?)))?;
	let mut out = Vec::new();
	for row in rows {
		let (t, fields) = row?;
		let f: Vec<String> = serde_json::from_str(&fields).unwrap_or_default();
		let size = f.first().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
		out.push((t, size, f.get(1).is_some_and(|r| r == "1")));
	}
	Ok(out)
}

/// The grouped spans of `char_id`: each `group` record with a size holds until the next one or
/// the end of its play session, whichever comes first (a new login writes a fresh record).
pub fn spans(db: &Connection, char_id: &str) -> rusqlite::Result<Vec<Span>> {
	Ok(spans_of(&records(db, char_id)?, &sessions(db, char_id)?))
}

fn spans_of(recs: &[(f64, i64, bool)], sess: &[(f64, f64)]) -> Vec<Span> {
	let mut out = Vec::new();
	for (i, &(t, size, raid)) in recs.iter().enumerate() {
		if size <= 0 {
			continue;
		}
		let session_end = sess.iter().find(|s| t >= s.0 - SESSION_GAP && t <= s.1).map_or(t, |s| s.1);
		let next = recs.get(i + 1).map_or(f64::INFINITY, |r| r.0);
		let to = session_end.min(next);
		if to > t {
			out.push(Span { from: t, to, size, raid });
		}
	}
	out
}

/// Seconds of `spans` within [from, to].
pub fn seconds_in(spans: &[Span], from: f64, to: f64) -> f64 {
	spans.iter().map(|s| (s.to.min(to) - s.from.max(from)).max(0.0)).sum()
}

/// The group at `t`, if any.
pub fn at(spans: &[Span], t: f64) -> Option<Span> {
	spans.iter().find(|s| t >= s.from && t < s.to).copied()
}

/// What a session's group play comes to.
#[derive(Default, Debug, PartialEq)]
pub struct Summary {
	pub seconds: f64,
	/// The biggest party (other members) or raid (with the player) of the session.
	pub party: i64,
	pub raid: i64,
	/// The other characters of this dashboard grouped at the same time: (char_id, name).
	pub with: Vec<(String, String)>,
}

/// `char_id`'s group play in [from, to]. `others` is every other character's spans.
pub fn summary(spans: &[Span], others: &[(String, String, Vec<Span>)], from: f64, to: f64) -> Summary {
	let mut s = Summary { seconds: seconds_in(spans, from, to), ..Default::default() };
	for sp in spans.iter().filter(|sp| sp.to > from && sp.from < to) {
		if sp.raid {
			s.raid = s.raid.max(sp.size);
		} else {
			s.party = s.party.max(sp.size);
		}
	}
	for (id, name, theirs) in others {
		let both: f64 = spans
			.iter()
			.filter(|sp| sp.to > from && sp.from < to)
			.map(|sp| seconds_in(theirs, sp.from.max(from), sp.to.min(to)))
			.sum();
		if both >= TOGETHER_MIN {
			s.with.push((id.clone(), name.clone()));
		}
	}
	s
}

/// Every character but `char_id`, with its name and grouped spans.
pub fn others(db: &Connection, char_id: &str) -> rusqlite::Result<Vec<(String, String, Vec<Span>)>> {
	let ids: Vec<(String, Option<String>)> = db
		.prepare("SELECT char_id, name FROM characters WHERE char_id != ?1 ORDER BY char_id")?
		.query_map(params![char_id], |r| Ok((r.get(0)?, r.get(1)?)))?
		.collect::<Result<_, _>>()?;
	let mut out = Vec::new();
	for (id, name) in ids {
		let sp = spans(db, &id)?;
		if !sp.is_empty() {
			let name = name.unwrap_or_else(|| id.clone());
			out.push((id, name, sp));
		}
	}
	Ok(out)
}

/// The log's line for a group change, given the group before it; None when nothing changed
/// (the record a login writes while solo, or the same group again).
pub fn change_line(before: Option<(i64, bool)>, size: i64, raid: bool, with: &[String]) -> Option<String> {
	let was = before.filter(|b| b.0 > 0);
	if size <= 0 {
		return was.map(|_| "Left the group".to_string());
	}
	if was == Some((size, raid)) {
		return None;
	}
	let with = if with.is_empty() { String::new() } else { format!(", with {}", list(with)) };
	Some(match (was, raid) {
		(None, false) => format!("Joined a party ({}){with}", members(size)),
		(None, true) => format!("Joined a raid of {size}{with}"),
		(Some((_, false)), true) => format!("The party became a raid of {size}{with}"),
		(Some((_, true)), false) => format!("The raid became a party ({}){with}", members(size)),
		(Some(_), false) => format!("Party now {}", members(size)),
		(Some(_), true) => format!("Raid now {size}"),
	})
}

fn members(n: i64) -> String {
	if n == 1 { "one other".into() } else { format!("{n} others") }
}

fn list(items: &[String]) -> String {
	match items {
		[] => String::new(),
		[a] => a.clone(),
		[rest @ .., last] => format!("{} and {last}", rest.join(", ")),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn spans_end_at_the_next_record_or_the_session_end() {
		let recs = [(10.0, 1, false), (50.0, 0, false), (100.0, 2, false), (500.0, 12, true)];
		let sess = [(0.0, 300.0), (480.0, 600.0)];
		assert_eq!(
			spans_of(&recs, &sess),
			vec![Span { from: 10.0, to: 50.0, size: 1, raid: false }, Span { from: 100.0, to: 300.0, size: 2, raid: false }, Span { from: 500.0, to: 600.0, size: 12, raid: true }]
		);
	}

	#[test]
	fn played_together_needs_an_overlap() {
		let mine = vec![Span { from: 0.0, to: 1000.0, size: 1, raid: false }];
		let others = vec![
			("b".to_string(), "Rena".to_string(), vec![Span { from: 400.0, to: 2000.0, size: 1, raid: false }]),
			("c".to_string(), "Brief".to_string(), vec![Span { from: 950.0, to: 2000.0, size: 1, raid: false }]),
		];
		let s = summary(&mine, &others, 0.0, 1000.0);
		assert_eq!(s.seconds, 1000.0);
		assert_eq!(s.party, 1);
		assert_eq!(s.with, vec![("b".to_string(), "Rena".to_string())]);
	}

	#[test]
	fn change_lines() {
		assert_eq!(change_line(None, 0, false, &[]), None);
		assert_eq!(change_line(Some((0, false)), 0, false, &[]), None);
		assert_eq!(change_line(None, 1, false, &["Rena".into()]).as_deref(), Some("Joined a party (one other), with Rena"));
		assert_eq!(change_line(Some((1, false)), 2, false, &[]).as_deref(), Some("Party now 2 others"));
		assert_eq!(change_line(Some((2, false)), 8, true, &[]).as_deref(), Some("The party became a raid of 8"));
		assert_eq!(change_line(Some((2, false)), 2, false, &[]), None);
		assert_eq!(change_line(Some((2, false)), 0, false, &[]).as_deref(), Some("Left the group"));
	}
}
