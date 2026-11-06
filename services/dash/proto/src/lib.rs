//! forever-dash's upload body and what the uploader reads from a WoW account folder besides the
//! Recorder's chunks: who each character is (the per-character folder), its Polestar_DashSnapshot
//! save, and Polestar's own entry for it (PolestarDB.alts).
//!
//! `POST /v1/upload` takes [`DashUpload`]: upstream ingest's body (uploader, install, chunks) plus
//! `maps`, `characters`, `snapshots` and `alts`, and answers with upstream's
//! `polestar_recording::api::UploadResponse`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use polestar_recording::{api::UploadChunk, lua, sv};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The per-character SavedVariables file of the snapshot addon.
pub const SNAPSHOT_FILE: &str = "Polestar_DashSnapshot.lua";
/// Polestar's account SavedVariables file (PolestarDB).
pub const POLESTAR_FILE: &str = "Polestar.lua";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Who {
	pub name: String,
	/// Forever characters have surnames (the per-character folder is `<Name>-<Surname>`).
	#[serde(default)]
	pub surname: String,
	/// The realm folder's name (a number on Forever).
	pub realm: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DashUpload {
	pub uploader: String,
	pub install: String,
	pub chunks: Vec<UploadChunk>,
	/// `PolestarRecorderDB.maps`: uiMapID -> the `map` record's fields from `id` on.
	#[serde(default)]
	pub maps: BTreeMap<u32, String>,
	/// charId -> name and realm, from `WTF/Account/<acct>/<realm>/<name>/SavedVariables`.
	#[serde(default)]
	pub characters: BTreeMap<String, Who>,
	/// charId -> Polestar_DashSnapshot's PolestarDashSnapshotDB (gear, bags, bank), as JSON.
	#[serde(default)]
	pub snapshots: BTreeMap<String, Value>,
	/// charId -> Polestar's own entry for the character (PolestarDB.alts.chars[...]), as JSON.
	#[serde(default)]
	pub alts: BTreeMap<String, Value>,
}

/// What an account folder holds for the dashboard besides the Recorder's chunks.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountExtras {
	pub characters: BTreeMap<String, Who>,
	pub snapshots: BTreeMap<String, Value>,
	pub alts: BTreeMap<String, Value>,
}

/// A Lua value as JSON: tables become objects keyed by their keys as text (arrays too, so `[0]`,
/// `[-2]` and `[1]` keep their meaning); whole numbers stay integers; nil entries are left out.
pub fn lua_json(v: &lua::Value) -> Value {
	match v {
		lua::Value::Nil => Value::Null,
		lua::Value::Bool(b) => json!(b),
		lua::Value::Num(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => json!(*n as i64),
		lua::Value::Num(n) => json!(n),
		lua::Value::Str(s) => json!(s),
		lua::Value::Table(t) => {
			let key = |k: &lua::Value| match k {
				lua::Value::Str(s) => s.clone(),
				lua::Value::Num(n) if n.fract() == 0.0 => format!("{}", *n as i64),
				lua::Value::Num(n) => n.to_string(),
				lua::Value::Bool(b) => b.to_string(),
				_ => String::new(),
			};
			Value::Object(t.iter().filter(|(_, v)| *v != lua::Value::Nil).map(|(k, v)| (key(k), lua_json(v))).collect())
		}
	}
}

/// The value of global `name` in a SavedVariables file, as JSON (tables only).
pub fn sv_global(path: &Path, name: &str) -> Option<Value> {
	let text = std::fs::read_to_string(path).ok()?;
	let vars = lua::parse_assignments(&text).ok()?;
	vars.iter().rev().find(|(n, _)| n == name).map(|(_, v)| lua_json(v)).filter(Value::is_object)
}

/// Name, surname and realm from a per-character folder: Forever's `<realm>/<Name>-<Surname>`,
/// or `<realm>/<Name>` for a character without a surname.
pub fn who_of(realm_folder: &str, char_folder: &str) -> Who {
	let (name, surname) = char_folder.split_once('-').filter(|(n, s)| !n.is_empty() && !s.is_empty()).unwrap_or((char_folder, ""));
	Who { name: name.to_string(), surname: surname.to_string(), realm: realm_folder.to_string() }
}

fn dirs(p: &Path) -> Vec<PathBuf> {
	let mut v: Vec<PathBuf> = std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
	v.sort();
	v
}

fn file_name(p: &Path) -> String {
	p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Reads an account folder (`WTF/Account/<acct>`): every character with a Recorder id, its snapshot,
/// and Polestar's entry for it (Polestar keys entries "Name-Realm" by the game's name, which has no
/// surname: matched on the name, only when exactly one entry has it).
pub fn read_account(acct: &Path) -> AccountExtras {
	let mut out = AccountExtras::default();
	for realm in dirs(acct).into_iter().filter(|p| !p.ends_with("SavedVariables")) {
		for ch in dirs(&realm) {
			let svd = ch.join("SavedVariables");
			let Some(id) = sv_global(&svd.join(sv::FILE_NAME), "PolestarRecorderCharDB").and_then(|v| v.get("id")?.as_str().map(str::to_string)) else { continue };
			if !sv::valid_char_id(&id) {
				continue;
			}
			if let Some(snap) = sv_global(&svd.join(SNAPSHOT_FILE), "PolestarDashSnapshotDB") {
				out.snapshots.insert(id.clone(), snap);
			}
			out.characters.insert(id, who_of(&file_name(&realm), &file_name(&ch)));
		}
	}
	let entries = sv_global(&acct.join("SavedVariables").join(POLESTAR_FILE), "PolestarDB").and_then(|db| db.get("alts")?.get("chars").cloned());
	if let Some(Value::Object(entries)) = entries {
		for (id, who) in &out.characters {
			let mut hits = entries.values().filter(|e| e.get("name").and_then(Value::as_str) == Some(who.name.as_str()));
			if let (Some(e), None) = (hits.next(), hits.next()) {
				out.alts.insert(id.clone(), e.clone());
			}
		}
	}
	out
}

/// A stable fingerprint of a JSON value (for "changed since last sent"). Keys are taken in sorted
/// order: polestar-recording turns on serde_json's preserve_order, so objects keep insertion order.
pub fn fingerprint(v: &Value) -> u64 {
	fn eat(h: &mut u64, s: &str) {
		for b in s.bytes() {
			*h ^= b as u64;
			*h = h.wrapping_mul(0x0100_0000_01b3);
		}
	}
	fn walk(v: &Value, h: &mut u64) {
		match v {
			Value::Object(o) => {
				let mut keys: Vec<&String> = o.keys().collect();
				keys.sort();
				eat(h, "{");
				for k in keys {
					eat(h, k);
					eat(h, ":");
					walk(&o[k], h);
				}
				eat(h, "}");
			}
			Value::Array(a) => {
				eat(h, "[");
				for x in a {
					walk(x, h);
				}
				eat(h, "]");
			}
			other => eat(h, &other.to_string()),
		}
	}
	let mut h: u64 = 0xcbf2_9ce4_8422_2325;
	walk(v, &mut h);
	h
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tmp(name: &str) -> PathBuf {
		let d = std::env::temp_dir().join(format!("fdp-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(&d).unwrap();
		d
	}

	#[test]
	fn names_from_folders() {
		assert_eq!(who_of("91", "Rumour-Rainhorn"), Who { name: "Rumour".into(), surname: "Rainhorn".into(), realm: "91".into() });
		assert_eq!(who_of("Dashrealm", "Aldric"), Who { name: "Aldric".into(), surname: "".into(), realm: "Dashrealm".into() });
		assert_eq!(who_of("91", "Odd-"), Who { name: "Odd-".into(), surname: "".into(), realm: "91".into() });
	}

	#[test]
	fn reads_an_account() {
		let acct = tmp("acct");
		let ch = acct.join("91").join("Mourning-Ratsworth").join("SavedVariables");
		std::fs::create_dir_all(&ch).unwrap();
		std::fs::write(ch.join("Polestar_Recorder.lua"), "PolestarRecorderCharDB = { [\"id\"] = \"p4y585ui95\" }").unwrap();
		std::fs::write(ch.join(SNAPSHOT_FILE), "PolestarDashSnapshotDB = { schema = 1, money = 218, bags = { [0] = { size = 20, slots = { \"6948:1\" } }, [-2] = { size = 4, slots = {} } }, equip = { nil, nil, [16] = \"item:3277\" } }").unwrap();
		std::fs::create_dir_all(acct.join("SavedVariables")).unwrap();
		std::fs::write(
			acct.join("SavedVariables").join(POLESTAR_FILE),
			"PolestarDB = { alts = { chars = { [\"Mourning-Realm 9\"] = { name = \"Mourning\", realm = \"Realm 9\", money = 187 }, [\"Other-Realm 9\"] = { name = \"Other\" } } } }",
		)
		.unwrap();
		let x = read_account(&acct);
		assert_eq!(x.characters["p4y585ui95"].surname, "Ratsworth");
		let s = &x.snapshots["p4y585ui95"];
		assert_eq!(s["money"], json!(218));
		assert_eq!(s["bags"]["0"]["slots"]["1"], json!("6948:1"));
		assert_eq!(s["bags"]["-2"]["size"], json!(4));
		assert_eq!(s["equip"]["16"], json!("item:3277"));
		assert!(s["equip"].get("1").is_none(), "nil slots left out");
		assert_eq!(x.alts["p4y585ui95"]["realm"], json!("Realm 9"));
		let _ = std::fs::remove_dir_all(&acct);
	}

	#[test]
	fn fingerprints_follow_content() {
		assert_eq!(fingerprint(&json!({"a": 1, "b": [1, 2]})), fingerprint(&json!({"b": [1, 2], "a": 1})));
		assert_ne!(fingerprint(&json!({"a": 1})), fingerprint(&json!({"a": 2})));
	}
}
