//! Spoken (rusty-key/spoken-wow) quest narration for the journal: the voice-over the Spoken
//! addons play in game when a quest is accepted or handed in.
//!
//! The quest sound packs (`SpokenQuestsAudio{Alliance,Horde,Shared,Gossip}`) are published as one
//! zip per release (`quests-audio/v<x.y.z>`, asset `SpokenQuestsAudioAll-<x.y.z>.zip`). `sync`
//! follows those releases: it downloads a newer one, keeps only the quest lines and the lookup
//! tables, imports the tables and drops the previous version. The audio is ElevenLabs/fish.audio
//! output from Blizzard's text; Spoken's MIT grant does not cover it (its THIRD_PARTY.md), so it
//! is never committed or put in the image: it lives in the data volume.
//!
//! A quest line's file is resolved as Spoken_Quests' DataModules.lua does it, minus what needs a
//! live unit (the NPC's model body, the wording on screen):
//! line `{questID}-{accept|complete}` -> the giver's own voice where the NPC is split by sex
//! (`QuestFileLookupByNPCSex`, the sex `NPCSexByNPCID` gives it) or voiced apart
//! (`QuestFileLookupByNPCID` / `ByObjectID`) -> the line itself; each tried first with the
//! player's sex (`m-`/`f-`), then plain, in the packs that have it (`SoundLengthLookupByFileName`).

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const SCHEMA: &str = "
-- Every quest-line file a pack holds: its folder (the pack), length in seconds.
CREATE TABLE IF NOT EXISTS spoken_files (file TEXT PRIMARY KEY, pack TEXT NOT NULL, length REAL NOT NULL);
-- A quest line in its giver's own voice: by NPC (sex 0) or by NPC and the sex it is drawn as; by object.
CREATE TABLE IF NOT EXISTS spoken_givers (line TEXT NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL, sex INTEGER NOT NULL, file TEXT NOT NULL, PRIMARY KEY (line, kind, id, sex));
CREATE TABLE IF NOT EXISTS spoken_npc_sex (npc INTEGER PRIMARY KEY, sex INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spoken_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

const REPO: &str = "rusty-key/spoken-wow";
const TAG_PREFIX: &str = "quests-audio/v";

// ---------------------------------------------------------------------------------------------
// The generated lookup files: `if ... then return end` and `<Pack>.<Table> = { ... }`, with
// string or number keys, numbers, strings and nested tables. A small reader for just that.

struct Lua<'a> {
	s: &'a [u8],
	i: usize,
}

impl Lua<'_> {
	fn ws(&mut self) {
		loop {
			while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
				self.i += 1;
			}
			if self.s[self.i..].starts_with(b"--") {
				while self.i < self.s.len() && self.s[self.i] != b'\n' {
					self.i += 1;
				}
			} else {
				return;
			}
		}
	}
	fn eat(&mut self, c: u8) -> bool {
		self.ws();
		if self.s.get(self.i) == Some(&c) {
			self.i += 1;
			true
		} else {
			false
		}
	}
	fn string(&mut self) -> Result<String, String> {
		let q = self.s[self.i];
		self.i += 1;
		let mut out = Vec::new();
		while self.i < self.s.len() && self.s[self.i] != q {
			if self.s[self.i] == b'\\' && self.i + 1 < self.s.len() {
				self.i += 1;
				out.push(match self.s[self.i] {
					b'n' => b'\n',
					b't' => b'\t',
					c => c,
				});
			} else {
				out.push(self.s[self.i]);
			}
			self.i += 1;
		}
		self.i += 1;
		String::from_utf8(out).map_err(|e| e.to_string())
	}
	fn number(&mut self) -> Result<f64, String> {
		let start = self.i;
		while self.i < self.s.len() && matches!(self.s[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
			self.i += 1;
		}
		std::str::from_utf8(&self.s[start..self.i]).ok().and_then(|t| t.parse().ok()).ok_or_else(|| format!("bad number at {start}"))
	}
	fn value(&mut self) -> Result<Value, String> {
		self.ws();
		match self.s.get(self.i) {
			Some(b'{') => self.table(),
			Some(b'"' | b'\'') => Ok(Value::String(self.string()?)),
			Some(b't') if self.s[self.i..].starts_with(b"true") => {
				self.i += 4;
				Ok(Value::Bool(true))
			}
			Some(b'f') if self.s[self.i..].starts_with(b"false") => {
				self.i += 5;
				Ok(Value::Bool(false))
			}
			Some(b'n') if self.s[self.i..].starts_with(b"nil") => {
				self.i += 3;
				Ok(Value::Null)
			}
			Some(_) => Ok(serde_json::json!(self.number()?)),
			None => Err("unexpected end".into()),
		}
	}
	/// A table as an object: `[k] = v` and `name = v` keyed by their text, list items by 1-based index.
	fn table(&mut self) -> Result<Value, String> {
		self.i += 1;
		let mut out = serde_json::Map::new();
		let mut n = 0;
		loop {
			if self.eat(b'}') {
				return Ok(Value::Object(out));
			}
			self.ws();
			let key = if self.s.get(self.i) == Some(&b'[') {
				self.i += 1;
				self.ws();
				let k = match self.s.get(self.i) {
					Some(b'"' | b'\'') => self.string()?,
					_ => {
						let x = self.number()?;
						if x.fract() == 0.0 { format!("{}", x as i64) } else { x.to_string() }
					}
				};
				if !self.eat(b']') || !self.eat(b'=') {
					return Err(format!("bad key at {}", self.i));
				}
				Some(k)
			} else {
				let start = self.i;
				while self.i < self.s.len() && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_') {
					self.i += 1;
				}
				let name = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("").to_string();
				if !name.is_empty() && self.eat(b'=') {
					Some(name)
				} else {
					self.i = start;
					None
				}
			};
			let v = self.value()?;
			let key = key.unwrap_or_else(|| {
				n += 1;
				n.to_string()
			});
			out.insert(key, v);
			if !self.eat(b',') && !self.eat(b';') {
				if self.eat(b'}') {
					return Ok(Value::Object(out));
				}
				return Err(format!("expected , or }} at {}", self.i));
			}
		}
	}
}

/// Every `<Pack>.<Name> = <table>` assignment of a generated lookup file, by name.
fn lua_tables(text: &str) -> Result<BTreeMap<String, Value>, String> {
	let mut out = BTreeMap::new();
	let s = text.as_bytes();
	let mut from = 0;
	while let Some(at) = text[from..].find("= {").map(|p| p + from) {
		// The name: the identifier just before ` = {` (after the last '.').
		let head = text[..at].trim_end();
		let name = head.rsplit(['.', '\n', ' ']).next().unwrap_or("").to_string();
		let mut p = Lua { s, i: at + 2 };
		p.ws();
		let v = p.table()?;
		out.insert(name, v);
		from = p.i;
	}
	Ok(out)
}

// ---------------------------------------------------------------------------------------------

fn is_quest_file(name: &str) -> bool {
	let n = name.strip_prefix("m-").or_else(|| name.strip_prefix("f-")).unwrap_or(name);
	let mut parts = n.splitn(3, '-');
	matches!((parts.next(), parts.next()), (Some(id), Some("accept" | "complete" | "progress")) if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
}

/// Imports the lookup tables of every pack folder under `dir` (`<Pack>/generated/*.lua`) and
/// records `version`. Returns (quest files, giver voices).
pub fn import(db: &mut Connection, dir: &Path, version: &str) -> Result<(usize, usize), String> {
	db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
	let tx = db.transaction().map_err(|e| e.to_string())?;
	tx.execute_batch("DELETE FROM spoken_files; DELETE FROM spoken_givers; DELETE FROM spoken_npc_sex;").map_err(|e| e.to_string())?;
	let (mut files, mut givers) = (0, 0);
	let mut packs: Vec<PathBuf> = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten().map(|e| e.path()).filter(|p| p.join("generated").is_dir()).collect();
	packs.sort();
	for pack in packs {
		let name = pack.file_name().unwrap().to_string_lossy().into_owned();
		let read = |f: &str| -> Result<BTreeMap<String, Value>, String> {
			match std::fs::read_to_string(pack.join("generated").join(f)) {
				Ok(t) => lua_tables(&t).map_err(|e| format!("{name}/{f}: {e}")),
				Err(_) => Ok(BTreeMap::new()),
			}
		};
		let obj = |m: &BTreeMap<String, Value>, k: &str| m.get(k).and_then(Value::as_object).cloned().unwrap_or_default();
		{
			let mut st = tx.prepare_cached("INSERT OR IGNORE INTO spoken_files (file, pack, length) VALUES (?1, ?2, ?3)").map_err(|e| e.to_string())?;
			for (file, len) in obj(&read("sound_length_table.lua")?, "SoundLengthLookupByFileName") {
				// Only lines the pack actually ships (a table can name files of another pack).
				if is_quest_file(&file) && pack.join("generated/sounds/quests").join(format!("{file}.ogg")).is_file() {
					files += st.execute(params![file, name, len.as_f64().unwrap_or(0.0)]).map_err(|e| e.to_string())?;
				}
			}
		}
		let mut put = tx.prepare_cached("INSERT OR IGNORE INTO spoken_givers (line, kind, id, sex, file) VALUES (?1, ?2, ?3, ?4, ?5)").map_err(|e| e.to_string())?;
		for (table, file, kind) in [("QuestFileLookupByNPCID", "npc_quest_file_lookups.lua", "npc"), ("QuestFileLookupByObjectID", "object_quest_file_lookups.lua", "object")] {
			for (line, by) in obj(&read(file)?, table) {
				for (id, f) in by.as_object().into_iter().flatten() {
					if let (Ok(id), Some(f)) = (id.parse::<i64>(), f.as_str()) {
						givers += put.execute(params![line, kind, id, 0, f]).map_err(|e| e.to_string())?;
					}
				}
			}
		}
		for (line, by) in obj(&read("npc_sex_quest_file_lookups.lua")?, "QuestFileLookupByNPCSex") {
			for (id, sexes) in by.as_object().into_iter().flatten() {
				for (sex, f) in sexes.as_object().into_iter().flatten() {
					if let (Ok(id), Ok(sex), Some(f)) = (id.parse::<i64>(), sex.parse::<i64>(), f.as_str()) {
						givers += put.execute(params![line, "npc", id, sex, f]).map_err(|e| e.to_string())?;
					}
				}
			}
		}
		drop(put);
		let mut st = tx.prepare_cached("INSERT OR IGNORE INTO spoken_npc_sex (npc, sex) VALUES (?1, ?2)").map_err(|e| e.to_string())?;
		for (id, sex) in obj(&read("npc_sex_lookups.lua")?, "NPCSexByNPCID") {
			if let (Ok(id), Some(sex)) = (id.parse::<i64>(), sex.as_i64()) {
				st.execute(params![id, sex]).map_err(|e| e.to_string())?;
			}
		}
	}
	tx.execute("INSERT OR REPLACE INTO spoken_meta (key, value) VALUES ('version', ?1)", [version]).map_err(|e| e.to_string())?;
	tx.commit().map_err(|e| e.to_string())?;
	Ok((files, givers))
}

/// A quest line to play: its URL under `/spoken/` and length in seconds.
pub struct Line {
	pub url: String,
	pub length: f64,
}

/// Set by `serve` without `--spoken`: no narration is offered (the files are not served either).
pub static OFF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The narration of quest `q` at `moment` ("accept" or "complete"), given by `giver` (`npc`/`object`
/// and id, when the record has one), for a character of `sex` (UnitSex: 2 male, 3 female).
pub fn resolve(db: &Connection, q: i64, moment: &str, giver: Option<(&str, i64)>, sex: Option<i64>) -> Option<Line> {
	if OFF.load(std::sync::atomic::Ordering::Relaxed) {
		return None;
	}
	let line = format!("{q}-{moment}");
	let mut candidates = Vec::new();
	if let Some((kind, id)) = giver {
		let drawn: i64 = if kind == "npc" { db.query_row("SELECT sex FROM spoken_npc_sex WHERE npc = ?1", [id], |r| r.get(0)).optional().ok().flatten().unwrap_or(2) } else { 0 };
		for s in [drawn, 0] {
			if let Ok(Some(f)) = db.query_row("SELECT file FROM spoken_givers WHERE line = ?1 AND kind = ?2 AND id = ?3 AND sex = ?4", params![line, kind, id, s], |r| r.get::<_, String>(0)).optional() {
				candidates.push(f);
				break;
			}
		}
	}
	candidates.push(line.clone());
	// A line only ever recorded in a giver's voice, reached without that giver (accepted from the
	// quest log after an abandon, shared by a party member): the giver's voice still fits.
	if let Ok(Some(f)) = db.query_row("SELECT file FROM spoken_givers WHERE line = ?1 ORDER BY sex, id LIMIT 1", [&line], |r| r.get::<_, String>(0)).optional() {
		candidates.push(f);
	}
	let prefix = match sex {
		Some(2) => "m-",
		Some(3) => "f-",
		_ => "",
	};
	for c in candidates {
		for name in [format!("{prefix}{c}"), c.clone()] {
			if let Ok(Some((pack, length))) = db.query_row("SELECT pack, length FROM spoken_files WHERE file = ?1", [&name], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))).optional() {
				return Some(Line { url: format!("/spoken/{pack}/generated/sounds/quests/{name}.ogg"), length });
			}
		}
	}
	None
}

// ---------------------------------------------------------------------------------------------
// Following the releases. `dir` holds `<version>/<Pack>/generated/...` and `current` (the version
// the server serves; the static route points at it).

/// The version under `dir` the server serves, if any.
pub fn current(dir: &Path) -> Option<String> {
	std::fs::read_to_string(dir.join("current")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && dir.join(s).is_dir())
}

fn version_key(v: &str) -> Vec<u64> {
	v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// The newest `quests-audio/v*` release: (version, zip URL).
fn latest(http: &reqwest::blocking::Client) -> Result<(String, String), String> {
	let releases: Vec<Value> = http
		.get(format!("https://api.github.com/repos/{REPO}/releases?per_page=100"))
		.send()
		.and_then(|r| r.error_for_status())
		.map_err(|e| e.to_string())?
		.json()
		.map_err(|e| e.to_string())?;
	releases
		.iter()
		.filter(|r| !r["draft"].as_bool().unwrap_or(false) && !r["prerelease"].as_bool().unwrap_or(false))
		.filter_map(|r| {
			let version = r["tag_name"].as_str()?.strip_prefix(TAG_PREFIX)?.to_string();
			// English's packs only (other languages are `quests-audio-<lang>/v*`, not this prefix).
			let url = r["assets"].as_array()?.iter().find(|a| a["name"].as_str().is_some_and(|n| n.starts_with("SpokenQuestsAudioAll-") && n.ends_with(".zip")))?["browser_download_url"].as_str()?.to_string();
			Some((version, url))
		})
		.max_by_key(|(v, _)| version_key(v))
		.ok_or_else(|| format!("no {TAG_PREFIX}* release with a SpokenQuestsAudioAll zip"))
}

/// Unpacks the quest lines and lookup tables of a pack zip into `to` (gossip and follow-up audio
/// left out: the journal plays quest lines only).
fn unpack(zip: &Path, to: &Path) -> Result<usize, String> {
	let f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
	let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
	let mut n = 0;
	for i in 0..z.len() {
		let mut e = z.by_index(i).map_err(|e| e.to_string())?;
		let Some(rel) = e.enclosed_name() else { continue };
		let s = rel.to_string_lossy().replace('\\', "/");
		let keep = (s.contains("/generated/sounds/quests/") && s.ends_with(".ogg")) || (s.contains("/generated/") && !s.contains("/sounds/") && s.ends_with(".lua"));
		if !keep || e.is_dir() {
			continue;
		}
		let out = to.join(&rel);
		std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
		let mut buf = Vec::with_capacity(e.size() as usize);
		e.read_to_end(&mut buf).map_err(|e| e.to_string())?;
		std::fs::write(&out, buf).map_err(|e| e.to_string())?;
		n += 1;
	}
	Ok(n)
}

/// Brings `dir` to the newest release and imports it into `db_path`. Returns the version now
/// served and whether it changed.
pub fn sync(dir: &Path, db_path: &str) -> Result<(String, bool), String> {
	std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
	let http = reqwest::blocking::Client::builder()
		.user_agent("forever-dash")
		.timeout(std::time::Duration::from_secs(3600))
		.build()
		.map_err(|e| e.to_string())?;
	let (version, url) = latest(&http)?;
	let have = current(dir);
	if have.as_deref() == Some(version.as_str()) {
		return Ok((version, false));
	}
	let zip = dir.join(".download.zip");
	let mut resp = http.get(&url).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
	let mut out = std::fs::File::create(&zip).map_err(|e| e.to_string())?;
	resp.copy_to(&mut out).map_err(|e| e.to_string())?;
	drop(out);
	let staging = dir.join(format!(".{version}"));
	let _ = std::fs::remove_dir_all(&staging);
	let files = unpack(&zip, &staging)?;
	let _ = std::fs::remove_file(&zip);
	let target = dir.join(&version);
	let _ = std::fs::remove_dir_all(&target);
	std::fs::rename(&staging, &target).map_err(|e| e.to_string())?;
	let mut db = crate::db::open(db_path).map_err(|e| e.to_string())?;
	let (lines, givers) = import(&mut db, &target, &version)?;
	std::fs::write(dir.join("current"), &version).map_err(|e| e.to_string())?;
	if let Some(old) = have.filter(|o| *o != version) {
		let _ = std::fs::remove_dir_all(dir.join(old));
	}
	println!("spoken: {version} ({files} files unpacked, {lines} quest lines, {givers} giver voices)");
	Ok((version, true))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reads_generated_tables() {
		let t = r#"if not VoiceOver or not VoiceOver.DataModules then return end
SpokenQuestsAudioShared.QuestFileLookupByNPCSex = {
	["1220-accept"] = {
		[4947] = 	{
			[2] = "1220-accept",
			[3] = "1220-accept-human-female-warrior"
		}
	},
}
SpokenQuestsAudioShared.SoundLengthLookupByFileName = {
    ["8052-complete"] = 3.76,
    ["m-2927-accept"] = 12,
}
"#;
		let m = lua_tables(t).unwrap();
		assert_eq!(m["QuestFileLookupByNPCSex"]["1220-accept"]["4947"]["3"], "1220-accept-human-female-warrior");
		assert_eq!(m["SoundLengthLookupByFileName"]["8052-complete"], 3.76);
		assert_eq!(m["SoundLengthLookupByFileName"]["m-2927-accept"], 12.0);
	}

	#[test]
	fn quest_files() {
		assert!(is_quest_file("8052-complete"));
		assert!(is_quest_file("f-2998-accept"));
		assert!(is_quest_file("1919-accept-gnome-male-zany"));
		assert!(!is_quest_file("a1b2c3"));
	}
}
