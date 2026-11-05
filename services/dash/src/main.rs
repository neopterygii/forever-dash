//! forever-dash: the self-hosted dashboard server.
//!
//!   forever-dash serve  [--db dash.db] [--addr 127.0.0.1:8790] [--web ui/dist] [--art DIR]
//!   forever-dash upload --wtf <WTF dir> [--server http://127.0.0.1:8790]
//!   forever-dash dump   --wtf <WTF dir>
//!
//! `upload` stands in for the Polestar Client fork's `dash` module: it reads every account's
//! Recorder SavedVariables and the per-character ones (charId -> name/realm) and uploads them.

mod db;
mod ingest;
mod read;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ingest::{DashUpload, Who};
use polestar_recording::{api, lua, record, sv};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::ServeDir;

type Db = Arc<Mutex<rusqlite::Connection>>;

fn arg(args: &[String], name: &str, default: &str) -> String {
	args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| default.to_string())
}

fn err500(e: impl std::fmt::Display) -> Response {
	(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
}

async fn upload(State(db): State<Db>, Json(req): Json<DashUpload>) -> Response {
	let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
	let mut db = db.lock().unwrap();
	match ingest::upload(&mut db, &req, now) {
		Ok(r) => Json(r).into_response(),
		Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
	}
}

async fn characters(State(db): State<Db>) -> Response {
	read::characters(&db.lock().unwrap()).map(Json).map_or_else(err500, IntoResponse::into_response)
}

#[derive(Deserialize)]
struct TrailQ {
	char: String,
	from: Option<f64>,
	to: Option<f64>,
	tol: Option<f64>,
}

async fn trail(State(db): State<Db>, Query(q): Query<TrailQ>) -> Response {
	let db = db.lock().unwrap();
	match read::trail(&db, &q.char, q.from.unwrap_or(0.0), q.to.unwrap_or(f64::MAX), q.tol.unwrap_or(1.5)) {
		Ok((segs, total)) => {
			let kept: usize = segs.iter().map(|s| s.ts.len()).sum();
			Json(json!({ "segments": segs, "points": total, "kept": kept })).into_response()
		}
		Err(e) => err500(e),
	}
}

#[derive(Deserialize)]
struct CharQ {
	char: String,
}

async fn journal(State(db): State<Db>, Query(q): Query<CharQ>) -> Response {
	read::journal(&db.lock().unwrap(), &q.char).map(Json).map_or_else(err500, IntoResponse::into_response)
}

async fn sessions(State(db): State<Db>, Query(q): Query<CharQ>) -> Response {
	read::sessions(&db.lock().unwrap(), &q.char).map(|s| Json(json!(s))).map_or_else(err500, IntoResponse::into_response)
}

#[derive(Deserialize)]
struct OverviewQ {
	/// Playtime buffer per character, hours (default 6, at most 200).
	hours: Option<f64>,
	tol: Option<f64>,
}

async fn overview(State(db): State<Db>, Query(q): Query<OverviewQ>) -> Response {
	let hours = q.hours.unwrap_or(6.0).clamp(0.1, 200.0);
	read::overview(&db.lock().unwrap(), hours, q.tol.unwrap_or(8.0).max(0.5)).map(Json).map_or_else(err500, IntoResponse::into_response)
}

#[derive(Deserialize)]
struct EventsQ {
	char: Option<String>,
	from: Option<f64>,
	to: Option<f64>,
	/// Comma-separated kinds; empty = all journal kinds.
	kinds: Option<String>,
}

async fn events(State(db): State<Db>, Query(q): Query<EventsQ>) -> Response {
	let kinds = q.kinds.unwrap_or_default();
	let kinds: Vec<&str> = kinds.split(',').filter(|k| !k.is_empty()).collect();
	read::events(&db.lock().unwrap(), q.char.as_deref(), q.from.unwrap_or(0.0), q.to.unwrap_or(f64::MAX), &kinds)
		.map(|v| Json(Value::Array(v)))
		.map_or_else(err500, IntoResponse::into_response)
}

#[derive(Deserialize)]
struct NoteBody {
	char: String,
	t: f64,
	text: String,
}

async fn add_note(State(db): State<Db>, Json(n): Json<NoteBody>) -> Response {
	if n.text.trim().is_empty() || n.text.len() > 4000 {
		return (StatusCode::BAD_REQUEST, "empty or too long").into_response();
	}
	let db = db.lock().unwrap();
	match db.execute("INSERT INTO notes (char_id, t, text) VALUES (?1, ?2, ?3)", rusqlite::params![n.char, n.t, n.text.trim()]) {
		Ok(_) => Json(json!({ "id": db.last_insert_rowid() })).into_response(),
		Err(e) => err500(e),
	}
}

async fn stats(State(db): State<Db>) -> Response {
	let db = db.lock().unwrap();
	let count = |sql: &str| db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(-1);
	Json(json!({
		"chunks": count("SELECT COUNT(*) FROM chunks"),
		"positions": count("SELECT COUNT(*) FROM positions"),
		"events": count("SELECT COUNT(*) FROM events"),
		"characters": count("SELECT COUNT(*) FROM characters"),
		"maps": count("SELECT COUNT(*) FROM maps"),
	}))
	.into_response()
}

async fn serve(args: &[String]) {
	let here = Path::new(env!("CARGO_MANIFEST_DIR"));
	let db_path = arg(args, "--db", "dash.db");
	let addr = arg(args, "--addr", "127.0.0.1:8790");
	let web = arg(args, "--web", &here.join("ui/dist").to_string_lossy());
	let art = arg(args, "--art", "art");
	let db: Db = Arc::new(Mutex::new(db::open(&db_path).expect("open the database")));
	let app = Router::new()
		.route("/v1/upload", post(upload))
		.route("/api/characters", get(characters))
		.route("/api/trail", get(trail))
		.route("/api/journal", get(journal))
		.route("/api/overview", get(overview))
		.route("/api/sessions", get(sessions))
		.route("/api/events", get(events))
		.route("/api/notes", post(add_note))
		.route("/api/stats", get(stats))
		.nest_service("/art", ServeDir::new(art))
		// Inter and Fira Sans (SIL OFL 1.1), as the addon ships them.
		.nest_service("/fonts", ServeDir::new(here.join("../../addon/Polestar/Media/Fonts")))
		.fallback_service(ServeDir::new(web))
		.layer(axum::extract::DefaultBodyLimit::max(api::MAX_UPLOAD_BYTES * 2))
		.with_state(db);
	let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
	println!("forever-dash listening on http://{addr} (db {db_path})");
	axum::serve(listener, app).await.unwrap();
}

struct Found {
	account: String,
	vars: sv::SavedVars,
	characters: BTreeMap<String, Who>,
}

/// Every account of a WTF folder with Recorder data, and charId -> name/realm from the
/// per-character SavedVariables (`<acct>/<realm>/<name>/SavedVariables/Polestar_Recorder.lua`).
fn scan(wtf: &Path) -> Vec<Found> {
	let mut out = Vec::new();
	let dirs = |p: &Path| -> Vec<PathBuf> {
		let mut v: Vec<PathBuf> = std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
		v.sort();
		v
	};
	for acct in dirs(&wtf.join("Account")) {
		let file = acct.join("SavedVariables").join(sv::FILE_NAME);
		let Ok(text) = std::fs::read_to_string(&file) else { continue };
		let vars = match sv::parse(&text) {
			Ok(v) => v,
			Err(e) => {
				eprintln!("{}: {e}", file.display());
				continue;
			}
		};
		let mut characters = BTreeMap::new();
		for realm in dirs(&acct).into_iter().filter(|p| !p.ends_with("SavedVariables")) {
			for ch in dirs(&realm) {
				let Ok(text) = std::fs::read_to_string(ch.join("SavedVariables").join(sv::FILE_NAME)) else { continue };
				let Ok(vars) = lua::parse_assignments(&text) else { continue };
				let id = vars.iter().rev().find(|(n, _)| n == "PolestarRecorderCharDB").and_then(|(_, v)| v.get("id")).and_then(|v| v.as_str()).map(str::to_string);
				if let Some(id) = id.filter(|i| sv::valid_char_id(i)) {
					let name = |p: &Path| p.file_name().unwrap().to_string_lossy().into_owned();
					// Forever: `<acct>/<number>/<Name-Realm>/`; older clients: `<acct>/<Realm>/<Name>/`.
					let folder = name(&ch);
					let who = match folder.split_once('-') {
						Some((n, r)) if !n.is_empty() && !r.is_empty() => Who { name: n.to_string(), realm: r.to_string() },
						_ => Who { name: folder, realm: name(&realm) },
					};
					characters.insert(id, who);
				}
			}
		}
		out.push(Found { account: acct.file_name().unwrap().to_string_lossy().into_owned(), vars, characters });
	}
	out
}

fn upload_cmd(args: &[String]) -> Result<(), String> {
	let wtf = PathBuf::from(arg(args, "--wtf", "WTF"));
	let server = arg(args, "--server", "http://127.0.0.1:8790");
	let http = reqwest::blocking::Client::new();
	for f in scan(&wtf) {
		let chunks: Vec<api::UploadChunk> = f.vars.chunks.iter().map(|(&seq, text)| api::UploadChunk { seq, text: text.clone() }).collect();
		let mut total = api::UploadResponse::default();
		// Batches under the server's limits (as Polestar Client's pending() does).
		let mut batches: Vec<Vec<api::UploadChunk>> = vec![Vec::new()];
		let mut size = 0;
		for c in chunks {
			let n = c.text.len() + 64;
			if (size + n > api::MAX_UPLOAD_BYTES - 4096 || batches.last().unwrap().len() >= api::MAX_UPLOAD_CHUNKS) && !batches.last().unwrap().is_empty() {
				batches.push(Vec::new());
				size = 0;
			}
			size += n;
			batches.last_mut().unwrap().push(c);
		}
		for (i, batch) in batches.into_iter().enumerate() {
			let body = DashUpload {
				uploader: "forever-dash-upload/0.1".into(),
				install: f.vars.install.clone(),
				chunks: batch,
				maps: if i == 0 { f.vars.maps.clone() } else { BTreeMap::new() },
				characters: if i == 0 { f.characters.clone() } else { BTreeMap::new() },
			};
			let resp = http.post(format!("{server}/v1/upload")).json(&body).send().map_err(|e| e.to_string())?;
			if !resp.status().is_success() {
				return Err(format!("{}: {}", resp.status(), resp.text().unwrap_or_default()));
			}
			let r: api::UploadResponse = resp.json().map_err(|e| e.to_string())?;
			total.accepted.extend(r.accepted);
			total.duplicate.extend(r.duplicate);
			total.rejected.extend(r.rejected);
		}
		println!(
			"{} (install {}, {} characters named): {} accepted, {} duplicate, {} rejected",
			f.account,
			f.vars.install,
			f.characters.len(),
			total.accepted.len(),
			total.duplicate.len(),
			total.rejected.len()
		);
		for r in &total.rejected {
			println!("  rejected {}: {}", r.seq, r.reason);
		}
		// Polestar Client would now write Ack.lua up to the highest seq every destination took.
	}
	Ok(())
}

/// Prototype step 4: what the parser makes of a WTF folder.
fn dump(args: &[String]) -> Result<(), String> {
	let wtf = PathBuf::from(arg(args, "--wtf", "WTF"));
	for f in scan(&wtf) {
		let mut kinds: BTreeMap<&str, u64> = BTreeMap::new();
		let mut bad = Vec::new();
		let mut first = f64::MAX;
		let mut last: f64 = 0.0;
		for (seq, text) in &f.vars.chunks {
			match record::decode_chunk(text) {
				Ok(c) => {
					for r in &c.records {
						*kinds.entry(r.kind.as_str()).or_default() += 1;
						first = first.min(r.t);
						last = last.max(r.t);
					}
				}
				Err(e) => bad.push(json!({ "seq": seq, "error": e.to_string() })),
			}
		}
		let v: Value = json!({
			"account": f.account, "install": f.vars.install, "seq": f.vars.seq, "acked": f.vars.acked,
			"chunks": f.vars.chunks.len(), "maps": f.vars.maps, "characters": f.characters.iter().map(|(k, w)| (k.clone(), format!("{}-{}", w.name, w.realm))).collect::<BTreeMap<_, _>>(),
			"records": kinds, "first": first, "last": last, "invalid": bad,
		});
		println!("{}", serde_json::to_string_pretty(&v).unwrap());
	}
	Ok(())
}

#[tokio::main]
async fn main() {
	let args: Vec<String> = std::env::args().collect();
	let r = match args.get(1).map(String::as_str) {
		Some("serve") => {
			serve(&args).await;
			Ok(())
		}
		Some("upload") => tokio::task::spawn_blocking(move || upload_cmd(&args)).await.unwrap(),
		Some("dump") => dump(&args),
		_ => Err("usage: forever-dash serve|upload|dump [options]".into()),
	};
	if let Err(e) = r {
		eprintln!("{e}");
		std::process::exit(1);
	}
}
