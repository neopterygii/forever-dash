//! `POST /v1/upload`: upstream ingest's shape (accepted / duplicate / rejected per seq), plus
//! what only our uploader knows: the uiMap frames and charId -> name/realm.

use std::collections::BTreeMap;

use polestar_recording::api::{Rejected, UploadChunk, UploadResponse, MAX_CHUNK_BYTES, MAX_UPLOAD_CHUNKS};
use polestar_recording::record::{decode_chunk, Chunk, Kind};
use polestar_recording::sv::{valid_char_id, valid_install};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Who {
	pub name: String,
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
}

/// Record kinds the journal shows (the rest stay in the raw chunk).
const EVENT_KINDS: &[Kind] = &[
	Kind::Level, Kind::Zone, Kind::Death, Kind::Revive, Kind::Mark, Kind::Accept, Kind::Turnin, Kind::Abandon,
	Kind::Taxi, Kind::Land, Kind::Enter, Kind::Encounter, Kind::Explore, Kind::Learn, Kind::Achieve,
	Kind::Rare, Kind::Bind, Kind::Kill, Kind::Ride, Kind::Afk,
];

fn store_map(tx: &Connection, fields: &str) -> rusqlite::Result<()> {
	let f: Vec<&str> = fields.split('\t').collect();
	if f.len() < 8 {
		return Ok(());
	}
	let n = |i: usize| f[i].parse::<f64>().ok();
	let Some(id) = f[0].parse::<u32>().ok() else { return Ok(()) };
	tx.execute(
		"INSERT INTO maps (id, type, parent, c, top, left, bottom, right) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
		 ON CONFLICT (id) DO UPDATE SET type = ?2, parent = ?3, c = ?4, top = ?5, left = ?6, bottom = ?7, right = ?8",
		params![id, f[1].parse::<i64>().ok(), f[2].parse::<i64>().ok(), f[3].parse::<i64>().ok(), n(4), n(5), n(6), n(7)],
	)?;
	Ok(())
}

/// Derived rows for one newly stored chunk.
fn derive(tx: &Connection, chunk: &Chunk) -> rusqlite::Result<()> {
	let id = &chunk.char_id;
	tx.execute("INSERT INTO characters (char_id) VALUES (?1) ON CONFLICT DO NOTHING", [id])?;
	for r in &chunk.records {
		match r.kind {
			Kind::Session => {
				// Later chunks may arrive first: keep the level of the latest record.
				tx.execute(
					"UPDATE characters SET race = ?2, class = ?3, faction = ?4, level = ?5, level_t = ?6
					 WHERE char_id = ?1 AND (level_t IS NULL OR level_t <= ?6)",
					params![id, r.get("race"), r.get("class"), r.get("faction"), r.int("level"), r.t],
				)?;
			}
			Kind::Level => {
				tx.execute(
					"UPDATE characters SET level = ?2, level_t = ?3 WHERE char_id = ?1 AND (level_t IS NULL OR level_t <= ?3)",
					params![id, r.int("level"), r.t],
				)?;
			}
			Kind::Map => {
				store_map(tx, &r.fields.join("\t"))?;
			}
			Kind::Text => {
				tx.execute("INSERT OR REPLACE INTO quests (id, title) VALUES (?1, ?2)", params![r.int("q"), r.get("title")])?;
			}
			_ => {}
		}
		if r.kind == Kind::Pos {
			if let Some(p) = r.pos() {
				tx.execute(
					"INSERT INTO positions (char_id, t, map, x, y, flags) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
					params![id, r.t, p.map, p.x, p.y, r.int("flags").unwrap_or(0)],
				)?;
			}
		}
		if EVENT_KINDS.contains(&r.kind) {
			let p = r.pos();
			tx.execute(
				"INSERT INTO events (char_id, t, kind, map, x, y, fields) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
				params![id, r.t, r.kind.as_str(), p.map(|p| p.map), p.map(|p| p.x), p.map(|p| p.y), serde_json::to_string(&r.fields).unwrap()],
			)?;
		}
	}
	Ok(())
}

pub fn upload(db: &mut Connection, req: &DashUpload, now: i64) -> Result<UploadResponse, String> {
	if !valid_install(&req.install) {
		return Err("bad install id".into());
	}
	if req.chunks.len() > MAX_UPLOAD_CHUNKS {
		return Err(format!("at most {MAX_UPLOAD_CHUNKS} chunks per upload"));
	}
	let tx = db.transaction().map_err(|e| e.to_string())?;
	let mut out = UploadResponse::default();
	for fields in req.maps.values() {
		store_map(&tx, fields).map_err(|e| e.to_string())?;
	}
	for (char_id, who) in &req.characters {
		if valid_char_id(char_id) {
			tx.execute(
				"INSERT INTO characters (char_id, name, realm) VALUES (?1, ?2, ?3)
				 ON CONFLICT (char_id) DO UPDATE SET name = ?2, realm = ?3",
				params![char_id, who.name, who.realm],
			)
			.map_err(|e| e.to_string())?;
		}
	}
	for c in &req.chunks {
		if c.text.len() > MAX_CHUNK_BYTES {
			out.rejected.push(Rejected { seq: c.seq, reason: "chunk too big".into() });
			continue;
		}
		let exists = tx
			.query_row("SELECT 1 FROM chunks WHERE install = ?1 AND seq = ?2", params![req.install, c.seq], |_| Ok(()))
			.optional()
			.map_err(|e| e.to_string())?
			.is_some();
		if exists {
			out.duplicate.push(c.seq);
			continue;
		}
		let chunk = match decode_chunk(&c.text) {
			Ok(ch) if ch.seq == c.seq => ch,
			Ok(_) => {
				out.rejected.push(Rejected { seq: c.seq, reason: "seq does not match the chunk record".into() });
				continue;
			}
			Err(e) => {
				out.rejected.push(Rejected { seq: c.seq, reason: e.to_string() });
				continue;
			}
		};
		let first = chunk.records.first().map_or(chunk.epoch as f64, |r| r.t);
		let last = chunk.records.last().map_or(chunk.epoch as f64, |r| r.t);
		tx.execute(
			"INSERT INTO chunks (install, seq, char_id, epoch, first_t, last_t, received, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
			params![req.install, c.seq, chunk.char_id, chunk.epoch, first.min(chunk.epoch as f64), last, now, c.text],
		)
		.map_err(|e| e.to_string())?;
		derive(&tx, &chunk).map_err(|e| e.to_string())?;
		out.accepted.push(c.seq);
	}
	tx.commit().map_err(|e| e.to_string())?;
	Ok(out)
}
