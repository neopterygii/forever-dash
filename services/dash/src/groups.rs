//! Groups: who sees what. A group has a code; a client uploads with it (its device token setting),
//! and the characters it uploads belong to that group. Viewing the site means signing in with the
//! code (kept in a cookie); every read is limited to the group's characters. No code, no site:
//! there is no registration, groups are lines in the `--groups` file.
//!
//! The file, one entry per line (`#` comments):
//! ```text
//! <code> <name...>             a group
//! + <device token> <code>      an older device token that uploads into that group
//! ```
//! The first group also takes every character uploaded before groups existed.
//! Without a groups file the site is open (a LAN or Tailscale server) and uploads follow `--tokens`.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use axum::http::{header, HeaderMap};
use rusqlite::{params, Connection};

pub const COOKIE: &str = "fd_group";

#[derive(Default, Debug)]
pub struct Groups {
	/// code -> name, in file order.
	pub list: Vec<(String, String)>,
	/// Any upload token (a code, or a device token) -> its group's code.
	upload: HashMap<String, String>,
}

static GROUPS: OnceLock<Groups> = OnceLock::new();

pub fn parse(text: &str) -> Result<Groups, String> {
	let mut g = Groups::default();
	let mut aliases = Vec::new();
	for (n, line) in text.lines().enumerate() {
		let line = line.trim();
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		let mut w = line.split_whitespace();
		let first = w.next().unwrap();
		if first == "+" {
			let (Some(token), Some(code)) = (w.next(), w.next()) else { return Err(format!("line {}: + <device token> <code>", n + 1)) };
			aliases.push((token.to_string(), code.to_string()));
			continue;
		}
		if first.len() < 12 {
			return Err(format!("line {}: a group code needs at least 12 characters", n + 1));
		}
		let name = w.collect::<Vec<_>>().join(" ");
		g.upload.insert(first.to_string(), first.to_string());
		g.list.push((first.to_string(), if name.is_empty() { first[..4].to_string() } else { name }));
	}
	for (token, code) in aliases {
		if !g.list.iter().any(|(c, _)| *c == code) {
			return Err(format!("device token for an unknown group code {}…", &code[..code.len().min(4)]));
		}
		g.upload.insert(token, code);
	}
	Ok(g)
}

/// Loads the groups (once, at startup) and gives earlier characters and player notes to the first.
pub fn init(db: &Connection, g: Groups) -> rusqlite::Result<()> {
	if let Some((first, _)) = g.list.first() {
		db.execute("UPDATE characters SET grp = ?1 WHERE grp IS NULL OR grp = ''", [first])?;
		db.execute("UPDATE OR IGNORE group_person_notes SET grp = ?1 WHERE grp = ''", [first])?;
	}
	let _ = GROUPS.set(g);
	Ok(())
}

pub fn get() -> Option<&'static Groups> {
	GROUPS.get().filter(|g| !g.list.is_empty())
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
	headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

/// The group an upload goes to: Ok(None) when the site has no groups.
pub fn upload_group(headers: &HeaderMap) -> Result<Option<String>, ()> {
	let Some(g) = get() else { return Ok(None) };
	bearer(headers).and_then(|t| g.upload.get(t)).cloned().map(Some).ok_or(())
}

/// The group's code and name for a sign-in code (a group code only, never a device token).
pub fn by_code(code: &str) -> Option<(String, String)> {
	get()?.list.iter().find(|(c, _)| c == code.trim()).cloned()
}

fn cookie(headers: &HeaderMap) -> Option<String> {
	headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
		let (k, v) = kv.trim().split_once('=')?;
		(k == COOKIE).then(|| v.to_string())
	})
}

/// What one request may see.
#[derive(Debug, Clone)]
pub struct Scope {
	/// The group's code; "" on a site without groups.
	pub grp: String,
	pub name: Option<String>,
	pub chars: HashSet<String>,
}

impl Scope {
	pub fn has(&self, char_id: &str) -> bool {
		self.chars.contains(char_id)
	}
	pub fn list(&self) -> Vec<String> {
		let mut v: Vec<String> = self.chars.iter().cloned().collect();
		v.sort();
		v
	}
}

/// The request's scope: its group's characters (every character on a site without groups), or None
/// when it is not signed in to a group.
pub fn scope(db: &Connection, headers: &HeaderMap) -> rusqlite::Result<Option<Scope>> {
	let (grp, name) = match get() {
		None => (String::new(), None),
		Some(_) => match cookie(headers).and_then(|c| by_code(&c)) {
			Some((code, name)) => (code, Some(name)),
			None => return Ok(None),
		},
	};
	let mut st = db.prepare("SELECT char_id FROM characters WHERE ?1 = '' OR grp = ?1")?;
	let chars = st.query_map([&grp], |r| r.get::<_, String>(0))?.collect::<Result<HashSet<_>, _>>()?;
	Ok(Some(Scope { grp, name, chars }))
}

/// After an upload: the characters it carried belong to the uploader's group.
pub fn claim(db: &Connection, grp: &str, install: &str, chars: &[&str]) -> rusqlite::Result<()> {
	db.execute("UPDATE characters SET grp = ?1 WHERE char_id IN (SELECT DISTINCT char_id FROM chunks WHERE install = ?2)", params![grp, install])?;
	for c in chars {
		db.execute("UPDATE characters SET grp = ?1 WHERE char_id = ?2", params![grp, c])?;
	}
	Ok(())
}

/// A new group code: 16 characters from an alphabet without look-alikes, in groups of four.
pub fn new_code() -> String {
	const ABC: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
	let mut bytes = [0u8; 16];
	use std::io::Read;
	std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).expect("read /dev/urandom");
	let s: String = bytes.iter().map(|b| ABC[*b as usize % ABC.len()] as char).collect();
	format!("{}-{}-{}-{}", &s[0..4], &s[4..8], &s[8..12], &s[12..16])
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_groups_and_device_tokens() {
		let g = parse("# groups\nabcd-efgh-jkmn-pqrs The Household\n+ old-device-token abcd-efgh-jkmn-pqrs\nzzzz-yyyy-xxxx-wwww Friends\n").unwrap();
		assert_eq!(g.list, vec![("abcd-efgh-jkmn-pqrs".into(), "The Household".into()), ("zzzz-yyyy-xxxx-wwww".into(), "Friends".into())]);
		assert_eq!(g.upload.get("old-device-token").map(String::as_str), Some("abcd-efgh-jkmn-pqrs"));
		assert!(parse("short Name").is_err());
		assert!(parse("+ tok nope-nope-nope").is_err());
		let c = new_code();
		assert_eq!(c.len(), 19);
		assert_ne!(c, new_code());
	}
}
