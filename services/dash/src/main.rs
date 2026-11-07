//! forever-dash: the self-hosted dashboard server.
//!
//!   forever-dash serve  [--db dash.db] [--addr 127.0.0.1:8790] [--web ui/dist] [--art DIR] [--tokens FILE] [--fonts DIR]
//!   forever-dash upload --wtf <WTF dir> [--server http://127.0.0.1:8790]
//!   forever-dash dump   --wtf <WTF dir>
//!   forever-dash reparse [--db dash.db]   rebuild the derived tables from the raw chunks
//!   forever-dash names --data <data/forever> --tables <data/sources/wago/<build>> [--db dash.db]
//!   forever-dash spoken sync --dir <spoken dir> [--db dash.db]     newest Spoken quest narration release
//!   forever-dash spoken import --dir <unpacked pack folders> [--db dash.db]
//!
//! `serve --ai-url URL --ai-key-file FILE [--ai-model diary]` also has a model write each closed
//! session's diary entry in prose (an OpenAI-compatible endpoint: the LiteLLM gateway); without it
//! every entry is the template's.
//!
//! `serve --spoken <dir>` plays Spoken's quest narration in the journal and keeps it up to date
//! (checks rusty-key/spoken-wow's releases at start and every day).
//!
//! `upload` stands in for the Polestar Client fork's `dash` module: it reads every account's
//! Recorder SavedVariables and the per-character ones (charId -> name/realm) and uploads them.

mod db;
mod diary;
mod group;
mod ingest;
mod milestones;
mod names;
mod read;
mod spoken;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ingest::{DashUpload, Who};
use polestar_recording::{api, record, sv};
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

/// Device tokens (`--tokens <file>`, one per line); none = uploads are open (LAN/Tailscale only).
static TOKENS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

fn authorized(headers: &axum::http::HeaderMap) -> bool {
	let Some(tokens) = TOKENS.get().filter(|t| !t.is_empty()) else { return true };
	let given = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
	tokens.iter().any(|t| t == given)
}

async fn upload(State(db): State<Db>, headers: axum::http::HeaderMap, Json(req): Json<DashUpload>) -> Response {
	if !authorized(&headers) {
		return (StatusCode::UNAUTHORIZED, "unknown token").into_response();
	}
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

#[derive(Deserialize)]
struct JournalQ {
	/// One character's journal; none = every character's sessions together.
	char: Option<String>,
	/// The last session shown (its start and character): the page goes on after it; none = the newest.
	before: Option<f64>,
	#[serde(rename = "beforeChar")]
	before_char: Option<String>,
	limit: Option<usize>,
}

async fn journal(State(db): State<Db>, Query(q): Query<JournalQ>) -> Response {
	let limit = q.limit.unwrap_or(read::JOURNAL_PAGE).clamp(1, 200);
	read::journal(&db.lock().unwrap(), q.char.as_deref().filter(|c| !c.is_empty()), q.before.map(|b| (b, q.before_char.as_deref().unwrap_or(""))), limit).map(Json).map_or_else(err500, IntoResponse::into_response)
}

#[derive(Deserialize)]
struct QuestQ {
	char: String,
	id: i64,
}

async fn quest(State(db): State<Db>, Query(q): Query<QuestQ>) -> Response {
	read::quest(&db.lock().unwrap(), &q.char, q.id).map(Json).map_or_else(err500, IntoResponse::into_response)
}

async fn snapshot(State(db): State<Db>, Query(q): Query<CharQ>) -> Response {
	read::snapshot(&db.lock().unwrap(), &q.char).map(Json).map_or_else(err500, IntoResponse::into_response)
}

async fn item_ids(State(db): State<Db>) -> Response {
	read::item_ids(&db.lock().unwrap()).map(|v| Json(json!(v))).map_or_else(err500, IntoResponse::into_response)
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

#[derive(Deserialize)]
struct DiaryBody {
	char: String,
	start: f64,
	/// Your own entry; empty = back to the written one.
	text: String,
}

async fn set_diary(State(db): State<Db>, Json(d): Json<DiaryBody>) -> Response {
	if d.text.len() > 8000 {
		return (StatusCode::BAD_REQUEST, "too long").into_response();
	}
	let db = db.lock().unwrap();
	match diary::set_mine(&db, &d.char, d.start, &d.text).and_then(|_| diary::entry(&db, &d.char, d.start, d.start)) {
		Ok(_) => Json(json!({ "ok": true })).into_response(),
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
	let fonts = args.iter().position(|a| a == "--fonts").and_then(|i| args.get(i + 1)).map_or_else(|| here.join("../../addon/Polestar/Media/Fonts"), std::path::PathBuf::from);
	let web = arg(args, "--web", &here.join("ui/dist").to_string_lossy());
	let art = arg(args, "--art", "art");
	let db: Db = Arc::new(Mutex::new(db::open(&db_path).expect("open the database")));
	let tokens: Vec<String> = match args.iter().position(|a| a == "--tokens").and_then(|i| args.get(i + 1)) {
		Some(f) => std::fs::read_to_string(f).expect("read --tokens").lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(str::to_string).collect(),
		None => Vec::new(),
	};
	if !tokens.is_empty() {
		println!("uploads need one of {} device tokens", tokens.len());
	}
	let _ = TOKENS.set(tokens);
	// Spoken's narration: served from <dir>/<current version>, followed daily. The static route is
	// resolved per request so a new version is served without a restart.
	let spoken_dir = args.iter().position(|a| a == "--spoken").and_then(|i| args.get(i + 1)).map(PathBuf::from);
	if let Some(dir) = spoken_dir.clone() {
		let db_path = db_path.clone();
		std::thread::spawn(move || loop {
			match spoken::sync(&dir, &db_path) {
				Ok((v, changed)) => println!("spoken: {v}{}", if changed { " installed" } else { " is current" }),
				Err(e) => eprintln!("spoken sync: {e}"),
			}
			std::thread::sleep(std::time::Duration::from_secs(24 * 3600));
		});
	}
	if let Some(ai) = diary::Ai::from_args(args) {
		println!("diary: entries written by {} at {}", ai.model, ai.url);
		let db_path = db_path.clone();
		std::thread::spawn(move || diary::run(ai, db_path));
	}
	let app = Router::new()
		.route("/v1/upload", post(upload))
		.route("/api/characters", get(characters))
		.route("/api/trail", get(trail))
		.route("/api/journal", get(journal))
		.route("/api/quest", get(quest))
		.route("/spoken/{*path}", get(move |p: axum::extract::Path<String>, req: axum::extract::Request| spoken_file(spoken_dir.clone(), p, req)))
		.route("/api/overview", get(overview))
		.route("/api/sessions", get(sessions))
		.route("/api/snapshot", get(snapshot))
		.route("/api/item-ids", get(item_ids))
		.route("/api/events", get(events))
		.route("/api/notes", post(add_note))
		.route("/api/diary", post(set_diary))
		.route("/api/stats", get(stats))
		// `planner art` stores terrain tiles gzipped (x.bc1.gz); MapView asks for x.bc1.
		.nest_service("/art", ServeDir::new(art).precompressed_gzip())
		// Inter and Fira Sans (SIL OFL 1.1), as the addon ships them.
		.nest_service("/fonts", ServeDir::new(fonts))
		.fallback_service(ServeDir::new(web))
		.layer(axum::extract::DefaultBodyLimit::max(api::MAX_UPLOAD_BYTES * 2))
		.with_state(db);
	let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
	println!("forever-dash listening on http://{addr} (db {db_path})");
	axum::serve(listener, app).await.unwrap();
}

/// A file of the Spoken version being served (`/spoken/<Pack>/generated/sounds/quests/<file>.ogg`).
async fn spoken_file(dir: Option<PathBuf>, axum::extract::Path(path): axum::extract::Path<String>, req: axum::extract::Request) -> Response {
	use tower::ServiceExt;
	let Some(dir) = dir else { return StatusCode::NOT_FOUND.into_response() };
	let Some(v) = spoken::current(&dir) else { return StatusCode::NOT_FOUND.into_response() };
	if !path.ends_with(".ogg") || path.split('/').any(|p| p == ".." || p.is_empty()) {
		return StatusCode::NOT_FOUND.into_response();
	}
	let mut res = match tower_http::services::ServeFile::new(dir.join(v).join(&path)).oneshot(req).await {
		Ok(r) => r.into_response(),
		Err(e) => return err500(e),
	};
	res.headers_mut().insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("public, max-age=604800"));
	res
}

struct Found {
	account: String,
	vars: sv::SavedVars,
	characters: BTreeMap<String, Who>,
	/// charId -> PolestarDashSnapshotDB.
	snapshots: BTreeMap<String, Value>,
	/// charId -> Polestar's PolestarDB.alts.chars entry.
	alts: BTreeMap<String, Value>,
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
		let x = forever_dash_proto::read_account(&acct);
		let (characters, snapshots, alts) = (x.characters, x.snapshots, x.alts);
		out.push(Found { account: acct.file_name().unwrap().to_string_lossy().into_owned(), vars, characters, snapshots, alts });
	}
	out
}

fn upload_cmd(args: &[String]) -> Result<(), String> {
	let wtf = PathBuf::from(arg(args, "--wtf", "WTF"));
	let server = arg(args, "--server", "http://127.0.0.1:8790");
	let token = arg(args, "--token", "");
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
				snapshots: if i == 0 { f.snapshots.clone() } else { BTreeMap::new() },
				alts: if i == 0 { f.alts.clone() } else { BTreeMap::new() },
			};
			let mut req = http.post(format!("{server}/v1/upload")).json(&body);
			if !token.is_empty() {
				req = req.bearer_auth(&token);
			}
			let resp = req.send().map_err(|e| e.to_string())?;
			if !resp.status().is_success() {
				return Err(format!("{}: {}", resp.status(), resp.text().unwrap_or_default()));
			}
			let r: api::UploadResponse = resp.json().map_err(|e| e.to_string())?;
			total.accepted.extend(r.accepted);
			total.duplicate.extend(r.duplicate);
			total.rejected.extend(r.rejected);
		}
		println!(
			"{} (install {}, {} characters named, {} snapshots, {} Polestar entries): {} accepted, {} duplicate, {} rejected",
			f.account,
			f.vars.install,
			f.characters.len(),
			f.snapshots.len(),
			f.alts.len(),
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
		Some("names") => {
			let data = PathBuf::from(arg(&args, "--data", "data/forever"));
			let tables = PathBuf::from(arg(&args, "--tables", ""));
			db::open(&arg(&args, "--db", "dash.db"))
				.map_err(|e| e.to_string())
				.and_then(|mut db| names::import(&mut db, &data, &tables))
				.map(|c| println!("imported names: {}", c.iter().map(|(k, n)| format!("{n} {k}")).collect::<Vec<_>>().join(", ")))
		}
		Some("spoken") => {
			let dir = PathBuf::from(arg(&args, "--dir", "spoken"));
			let db_path = arg(&args, "--db", "dash.db");
			match args.get(2).map(String::as_str) {
				Some("sync") => tokio::task::spawn_blocking(move || spoken::sync(&dir, &db_path)).await.unwrap().map(|(v, c)| println!("spoken {v}{}", if c { " installed" } else { " already current" })),
				Some("import") => db::open(&db_path)
					.map_err(|e| e.to_string())
					.and_then(|mut db| spoken::import(&mut db, &dir, "local"))
					.map(|(l, g)| println!("imported {l} quest lines, {g} giver voices")),
				_ => Err("usage: forever-dash spoken sync|import --dir DIR [--db dash.db]".into()),
			}
		}
		Some("reparse") => {
			let mut db = db::open(&arg(&args, "--db", "dash.db")).map_err(|e| e.to_string());
			db.as_mut().map_err(|e| e.clone()).and_then(ingest::reparse).map(|(ok, bad)| println!("reparsed {ok} chunks ({bad} unreadable)"))
		}
		_ => Err("usage: forever-dash serve|upload|dump|reparse|names [options]".into()),
	};
	if let Err(e) = r {
		eprintln!("{e}");
		std::process::exit(1);
	}
}
