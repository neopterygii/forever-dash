//! forever-dash: sends each WoW account's recordings to the player's own dashboard server, with who
//! each character is, its Polestar_DashSnapshot save and Polestar's own entry for it
//! (forever-dash-proto). Relaying to Polestar's server stays the upstream uploader's job and is off
//! unless the player turns it on (Settings: `consent`); this fork never turns it on by default.
//!
//! Ack.lua (which makes the Recorder delete chunks) says the highest chunk every enabled destination
//! confirmed: the dashboard's alone, or the lower of it and Polestar's when relaying ([`ack_level`]).
//!
//! State: `dash.json` in the store folder ({ installs: { <install>: { uploaded, acked, extras } } }).
//! The extras (characters, snapshots, Polestar's entries) are read when the Recorder's file changed
//! (the game writes them all at logout and /reload) and sent when their fingerprint changed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use forever_dash_proto::{fingerprint, read_account, DashUpload};
use polestar_recording::{ack, api, sv};
use serde::{Deserialize, Serialize};

use crate::engine::{confirmed_ack, now_ms, Engine};
use crate::store::Settings;

/// This fork never turns relaying to Polestar's server on by itself (engine `default_share`).
pub const NO_DEFAULT_SHARE: bool = true;
const FILE: &str = "dash.json";
const BACKOFF_MIN_S: i64 = 10;
const BACKOFF_MAX_S: i64 = 600;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct InstallState {
	/// Highest chunk sent to the dashboard (accepted, duplicate or rejected: none is sent again).
	pub uploaded: u64,
	/// Highest chunk the dashboard accepted or already had.
	pub acked: u64,
	/// Fingerprint of the extras the dashboard last took.
	pub extras: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DashFile {
	pub installs: BTreeMap<String, InstallState>,
}

impl DashFile {
	pub fn load(dir: &Path) -> DashFile {
		std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
	}

	pub fn save(&self, dir: &Path) -> std::io::Result<()> {
		let tmp = dir.join(format!("{FILE}.tmp"));
		std::fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap_or_default())?;
		std::fs::rename(tmp, dir.join(FILE))
	}
}

/// What the window shows (Settings > Dashboard) and the last outcome.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
	pub url: String,
	pub token_set: bool,
	/// Relaying to Polestar's server (the upstream `consent`).
	pub relay: bool,
	pub paused: bool,
	pub last_at: Option<i64>,
	pub last_error: Option<String>,
	pub retry_at: Option<i64>,
	pub installs: BTreeMap<String, InstallState>,
}

#[derive(Default)]
struct Runtime {
	last_at: Option<i64>,
	last_error: Option<String>,
	attempts: u32,
	retry_at: i64,
	/// Account folder -> the Recorder file hash its extras were last read at, and what was read.
	extras: BTreeMap<PathBuf, ([u8; 32], DashExtras)>,
}

type DashExtras = forever_dash_proto::AccountExtras;

fn runtime() -> &'static Mutex<Runtime> {
	static R: OnceLock<Mutex<Runtime>> = OnceLock::new();
	R.get_or_init(|| Mutex::new(Runtime::default()))
}

pub fn enabled(settings: &Settings) -> bool {
	!settings.dash_url.trim().is_empty()
}

/// The chunk Ack.lua may say: every enabled destination has it.
pub fn ack_level(relay: bool, upstream_acked: u64, dash_acked: Option<u64>) -> u64 {
	match (relay, dash_acked) {
		(true, Some(d)) => upstream_acked.min(d),
		(true, None) => upstream_acked,
		(false, Some(d)) => d,
		(false, None) => 0,
	}
}

/// The engine's ack for `install` after an upstream upload, lowered to what the dashboard has.
pub fn combined_ack(dir: &Path, settings: &Settings, install: &str, upstream_acked: u64) -> u64 {
	let dash = enabled(settings).then(|| DashFile::load(dir).installs.get(install).map_or(0, |s| s.acked));
	ack_level(settings.consent, upstream_acked, dash)
}

/// One account's work: its install, chunks and maps (from the engine's parsed file) and folder.
pub struct AccountWork {
	pub install: String,
	pub vars: Arc<sv::SavedVars>,
	pub extras: DashExtras,
}

/// Why a sync stopped.
#[derive(Debug, PartialEq)]
pub enum SyncError {
	Offline(String),
	Status(u16, String),
}

impl std::fmt::Display for SyncError {
	fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
		match self {
			SyncError::Offline(m) => write!(f, "The dashboard server did not answer: {m}"),
			SyncError::Status(401, _) => write!(f, "The dashboard server does not know this device token."),
			SyncError::Status(s, m) => write!(f, "The dashboard server answered {s}: {m}"),
		}
	}
}

/// Requests for one account: its new chunks in batches under the server's limits; the first
/// carries the maps and the extras when they changed. None when there is nothing to send.
pub fn requests(work: &AccountWork, state: &InstallState) -> Vec<DashUpload> {
	let fp = fingerprint(&serde_json::json!({ "c": work.extras.characters, "s": work.extras.snapshots, "a": work.extras.alts }));
	let chunks: Vec<api::UploadChunk> = work.vars.chunks.range(state.uploaded + 1..).map(|(&seq, text)| api::UploadChunk { seq, text: text.clone() }).filter(|c| c.text.len() <= api::MAX_CHUNK_BYTES).collect();
	if chunks.is_empty() && fp == state.extras {
		return Vec::new();
	}
	let mut batches: Vec<Vec<api::UploadChunk>> = vec![Vec::new()];
	let mut size = 0;
	for c in chunks {
		let n = c.text.len() + 64;
		let full = size + n > api::MAX_UPLOAD_BYTES - 64 * 1024 || batches.last().is_some_and(|b| b.len() >= api::MAX_UPLOAD_CHUNKS);
		if full && batches.last().is_some_and(|b| !b.is_empty()) {
			batches.push(Vec::new());
			size = 0;
		}
		size += n;
		batches.last_mut().unwrap().push(c);
	}
	batches
		.into_iter()
		.enumerate()
		.map(|(i, chunks)| DashUpload {
			uploader: concat!("forever-dash-client/", env!("CARGO_PKG_VERSION")).to_owned(),
			install: work.install.clone(),
			chunks,
			maps: if i == 0 { work.vars.maps.clone() } else { BTreeMap::new() },
			characters: if i == 0 { work.extras.characters.clone() } else { BTreeMap::new() },
			snapshots: if i == 0 { work.extras.snapshots.clone() } else { BTreeMap::new() },
			alts: if i == 0 { work.extras.alts.clone() } else { BTreeMap::new() },
		})
		.collect()
}

/// Sends every account's requests; updates `file` after each answered request. Stops at the first
/// failure (the rest waits for the next try).
pub async fn sync_once(http: &reqwest::Client, url: &str, token: &str, accounts: &[AccountWork], file: &mut DashFile) -> Result<usize, SyncError> {
	let mut sent = 0;
	for work in accounts {
		let state = file.installs.get(&work.install).copied().unwrap_or_default();
		let fp = fingerprint(&serde_json::json!({ "c": work.extras.characters, "s": work.extras.snapshots, "a": work.extras.alts }));
		for req in requests(work, &state) {
			let mut r = http.post(format!("{}/v1/upload", url.trim_end_matches('/'))).json(&req);
			if !token.is_empty() {
				r = r.bearer_auth(token);
			}
			let resp = r.send().await.map_err(|e| SyncError::Offline(e.to_string()))?;
			let status = resp.status();
			if !status.is_success() {
				let text = resp.text().await.unwrap_or_default();
				return Err(SyncError::Status(status.as_u16(), text.chars().take(300).collect()));
			}
			let answer: api::UploadResponse = resp.json().await.map_err(|e| SyncError::Offline(e.to_string()))?;
			let st = file.installs.entry(work.install.clone()).or_default();
			st.uploaded = st.uploaded.max(req.chunks.iter().map(|c| c.seq).max().unwrap_or(0));
			if let Some(c) = confirmed_ack(&req.chunks, &answer.accepted, &answer.duplicate) {
				st.acked = st.acked.max(c);
			}
			st.extras = fp;
			sent += 1;
		}
	}
	Ok(sent)
}

/// The account folder (`WTF/Account/<acct>`) of its Recorder file
/// (`<acct>/SavedVariables/Polestar_Recorder.lua`).
fn account_dir(sv_path: &Path) -> Option<PathBuf> {
	Some(sv_path.parent()?.parent()?.to_path_buf())
}

impl Engine {
	/// One pass: send what is new to the dashboard, then write Ack.lua for what every enabled
	/// destination has. Called by the engine loop after the upstream upload.
	pub async fn dash_sync(&self) {
		let (settings, accounts, addon_dir, upstream) = {
			let state = self.lock();
			let accounts: Vec<(String, PathBuf, [u8; 32], Arc<sv::SavedVars>)> = state
				.accounts
				.iter()
				.filter_map(|a| Some((a.folder_name.clone(), a.sv_path.clone(), a.hash?, a.sv.clone()?)))
				.collect();
			let addon_dir = state.install.as_ref().and_then(|i| i.addon_dir.clone());
			(state.settings.clone(), accounts, addon_dir, state.progress.clone())
		};
		if !enabled(&settings) || settings.paused || accounts.is_empty() || runtime().lock().unwrap().retry_at > now_ms() {
			return;
		}
		// The extras: read again only when the account's Recorder file changed.
		let mut work = Vec::new();
		for (_, sv_path, hash, vars) in accounts {
			let Some(dir) = account_dir(&sv_path) else { continue };
			let cached = runtime().lock().unwrap().extras.get(&dir).filter(|(h, _)| *h == hash).map(|(_, x)| x.clone());
			let extras = match cached {
				Some(x) => x,
				None => {
					let d = dir.clone();
					let x = tauri::async_runtime::spawn_blocking(move || read_account(&d)).await.unwrap_or_default();
					runtime().lock().unwrap().extras.insert(dir.clone(), (hash, x.clone()));
					x
				}
			};
			work.push(AccountWork { install: vars.install.clone(), vars, extras });
		}
		let mut file = DashFile::load(&self.store.dir);
		let before = file.clone();
		let result = sync_once(&self.http, &settings.dash_url, &settings.dash_token, &work, &mut file).await;
		if file != before {
			if let Err(e) = file.save(&self.store.dir) {
				eprintln!("could not save {FILE}: {e}");
			}
		}
		{
			let mut rt = runtime().lock().unwrap();
			match &result {
				Ok(n) => {
					if *n > 0 {
						rt.last_at = Some(now_ms());
					}
					rt.last_error = None;
					rt.attempts = 0;
					rt.retry_at = 0;
				}
				Err(e) => {
					rt.last_error = Some(e.to_string());
					let backoff = (BACKOFF_MIN_S << rt.attempts.min(6)).min(BACKOFF_MAX_S);
					rt.attempts += 1;
					rt.retry_at = now_ms() + backoff * 1000;
				}
			}
		}
		// Ack.lua: what every enabled destination has.
		if let Some(dir) = addon_dir {
			let share = crate::engine::sharing(&settings);
			for (install, st) in &file.installs {
				let upstream_acked = upstream.get(install).map_or(0, |p| p.acked);
				let level = ack_level(settings.consent, upstream_acked, Some(st.acked));
				let current = ack::read(&dir).get(install).copied().unwrap_or(0);
				if level > current {
					if let Err(e) = ack::write(&dir, install, level, share) {
						eprintln!("could not write Ack.lua: {e}");
					}
				}
			}
		}
	}

	pub fn dash_status(&self) -> Status {
		let settings = self.lock().settings.clone();
		let rt = runtime().lock().unwrap();
		Status {
			url: settings.dash_url.clone(),
			token_set: !settings.dash_token.is_empty(),
			relay: settings.consent,
			paused: settings.paused,
			last_at: rt.last_at,
			last_error: rt.last_error.clone(),
			retry_at: (rt.retry_at > now_ms()).then_some(rt.retry_at),
			installs: DashFile::load(&self.store.dir).installs,
		}
	}
}

/// Checks a dashboard address: http(s), no path tricks; returns it without a trailing slash.
pub fn normalize_url(url: &str) -> Result<String, String> {
	let url = url.trim().trim_end_matches('/');
	if url.is_empty() {
		return Ok(String::new());
	}
	if !(url.starts_with("http://") || url.starts_with("https://")) || url.contains(char::is_whitespace) {
		return Err("The dashboard address starts with http:// or https://.".into());
	}
	Ok(url.to_owned())
}

// ---- window commands (lib.rs registers them) -------------------------------------------------

type Engine_<'a> = tauri::State<'a, Arc<Engine>>;

#[tauri::command]
pub fn dash_status(engine: Engine_) -> Status {
	engine.dash_status()
}

/// Sets the dashboard address and, when given, the device token (an empty address turns the
/// dashboard off). Relaying to Polestar is the upstream `set_sharing`.
#[tauri::command]
pub fn set_dash(engine: Engine_, url: String, token: Option<String>) -> Result<Status, String> {
	let url = normalize_url(&url)?;
	let token = token.map(|t| t.trim().to_owned());
	if token.as_deref().is_some_and(|t| t.len() > 512 || t.contains(char::is_whitespace)) {
		return Err("That device token cannot be right (spaces, or far too long).".into());
	}
	engine.save_settings(|s| {
		s.dash_url = url.clone();
		if let Some(t) = token {
			s.dash_token = t;
		}
	})?;
	runtime().lock().unwrap().retry_at = 0;
	engine.wake();
	Ok(engine.dash_status())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn vars(install: &str, chunks: &[(u64, &str)]) -> Arc<sv::SavedVars> {
		Arc::new(sv::SavedVars { schema: 2, install: install.into(), chunks: chunks.iter().map(|(s, t)| (*s, t.to_string())).collect(), ..Default::default() })
	}

	#[test]
	fn the_ack_waits_for_every_enabled_destination() {
		assert_eq!(ack_level(false, 9, Some(4)), 4, "dashboard only");
		assert_eq!(ack_level(true, 9, Some(4)), 4, "relaying: the lower");
		assert_eq!(ack_level(true, 3, Some(4)), 3);
		assert_eq!(ack_level(true, 9, None), 9, "no dashboard: upstream's");
		assert_eq!(ack_level(false, 9, None), 0, "nothing enabled: nothing acked");
	}

	#[test]
	fn requests_send_new_chunks_and_changed_extras_once() {
		let mut x = DashExtras::default();
		x.characters.insert("abcdefghij".into(), forever_dash_proto::Who { name: "A".into(), surname: "B".into(), realm: "91".into() });
		let w = AccountWork { install: "k3j9x0q2m7ab".into(), vars: vars("k3j9x0q2m7ab", &[(1, "c1"), (2, "c2"), (3, "c3")]), extras: x };
		let all = requests(&w, &InstallState::default());
		assert_eq!(all.len(), 1);
		assert_eq!(all[0].chunks.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![1, 2, 3]);
		assert_eq!(all[0].characters.len(), 1);
		let fp = fingerprint(&serde_json::json!({ "c": w.extras.characters, "s": w.extras.snapshots, "a": w.extras.alts }));
		let done = InstallState { uploaded: 3, acked: 3, extras: fp };
		assert!(requests(&w, &done).is_empty(), "nothing new");
		let later = InstallState { uploaded: 2, ..done };
		let r = requests(&w, &later);
		assert_eq!(r[0].chunks.len(), 1, "only chunk 3");
		let changed = InstallState { extras: fp ^ 1, ..done };
		let r = requests(&w, &changed);
		assert_eq!((r.len(), r[0].chunks.len(), r[0].characters.len()), (1, 0, 1), "extras alone");
	}

	#[test]
	fn big_uploads_are_split_and_only_the_first_carries_the_extras() {
		let big = "x".repeat(60 * 1024);
		let chunks: Vec<(u64, &str)> = (1..=40).map(|s| (s, big.as_str())).collect();
		let w = AccountWork { install: "k3j9x0q2m7ab".into(), vars: vars("k3j9x0q2m7ab", &chunks), extras: DashExtras::default() };
		let r = requests(&w, &InstallState::default());
		assert!(r.len() >= 2);
		assert!(r.iter().all(|q| serde_json::to_vec(q).unwrap().len() < api::MAX_UPLOAD_BYTES));
		assert_eq!(r.iter().map(|q| q.chunks.len()).sum::<usize>(), 40);
		assert!(r[1..].iter().all(|q| q.maps.is_empty() && q.characters.is_empty()));
	}

	#[test]
	fn urls() {
		assert_eq!(normalize_url(" http://host:8790/ ").unwrap(), "http://host:8790");
		assert_eq!(normalize_url("").unwrap(), "");
		assert!(normalize_url("host:8790").is_err());
	}

	/// Against a running forever-dash server: DASH_TEST_SERVER=http://... cargo test -- --ignored
	#[test]
	#[ignore]
	fn syncs_with_a_real_server() {
		let Ok(url) = std::env::var("DASH_TEST_SERVER") else { return };
		// As lib.rs does at startup: reqwest is built without a default TLS provider.
		let _ = rustls::crypto::ring::default_provider().install_default();
		let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
		rt.block_on(async {
			let http = reqwest::Client::builder().build().unwrap();
			let chunk = "chunk\t0\t1\t1793920000\tzzzzzzzzz1\npos\t10\t1412\t5000\t5000\t0\t70";
			let w = AccountWork { install: "zzzztestzzz1".into(), vars: vars("zzzztestzzz1", &[(1, chunk)]), extras: DashExtras::default() };
			let mut file = DashFile::default();
			let n = sync_once(&http, &url, &std::env::var("DASH_TEST_TOKEN").unwrap_or_default(), std::slice::from_ref(&w), &mut file).await.unwrap();
			assert_eq!(n, 1);
			assert_eq!(file.installs["zzzztestzzz1"].acked, 1);
			let again = sync_once(&http, &url, "", std::slice::from_ref(&w), &mut file).await.unwrap();
			assert_eq!(again, 0, "nothing new");
		});
	}
}
