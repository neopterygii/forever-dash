//! SQLite storage: raw chunks (kept so everything can be re-parsed after a Recorder schema change)
//! and the tables derived from them.

use rusqlite::Connection;

pub const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Raw chunks, one per (install, seq): the de-duplication key the Recorder's ack relies on.
CREATE TABLE IF NOT EXISTS chunks (
	install TEXT NOT NULL,
	seq INTEGER NOT NULL,
	char_id TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	first_t REAL NOT NULL,
	last_t REAL NOT NULL,
	received INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (install, seq)
);
CREATE INDEX IF NOT EXISTS chunks_char ON chunks (char_id, first_t);

-- charId -> who, from the per-character SavedVariables path the uploader saw, and the latest
-- `session` record.
CREATE TABLE IF NOT EXISTS characters (
	char_id TEXT PRIMARY KEY,
	name TEXT,
	realm TEXT,
	race TEXT,
	class TEXT,
	faction TEXT,
	level INTEGER,
	level_t REAL
);

-- uiMap frames (the `map` record): world bounds, so map % -> world yards.
CREATE TABLE IF NOT EXISTS maps (
	id INTEGER PRIMARY KEY,
	type INTEGER,
	parent INTEGER,
	c INTEGER,
	top REAL, left REAL, bottom REAL, right REAL
);

CREATE TABLE IF NOT EXISTS positions (
	char_id TEXT NOT NULL,
	t REAL NOT NULL,
	map INTEGER NOT NULL,
	x INTEGER NOT NULL,
	y INTEGER NOT NULL,
	flags INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_char_t ON positions (char_id, t);

-- Journal-worthy records, fields as the Recorder wrote them (JSON array after dt).
CREATE TABLE IF NOT EXISTS events (
	char_id TEXT NOT NULL,
	t REAL NOT NULL,
	kind TEXT NOT NULL,
	map INTEGER,
	x INTEGER,
	y INTEGER,
	fields TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_char_t ON events (char_id, t);

CREATE TABLE IF NOT EXISTS quests (id INTEGER PRIMARY KEY, title TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notes (
	id INTEGER PRIMARY KEY,
	char_id TEXT NOT NULL,
	t REAL NOT NULL,
	text TEXT NOT NULL
);
";

/// Columns added after the first schema: (table, column, type). Added when missing.
const ADDED: &[(&str, &str, &str)] = &[
	("characters", "surname", "TEXT"),
	("characters", "sex", "INTEGER"),
	("characters", "xp", "INTEGER"),
	("characters", "xp_max", "INTEGER"),
	("characters", "rested", "INTEGER"),
	("characters", "xp_t", "REAL"),
];

pub fn open(path: &str) -> rusqlite::Result<Connection> {
	let db = Connection::open(path)?;
	db.execute_batch(SCHEMA)?;
	db.execute_batch(crate::names::SCHEMA)?;
	for (table, column, ty) in ADDED {
		let has: bool = db.query_row(&format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"), [column], |r| r.get::<_, i64>(0)).map(|n| n > 0)?;
		if !has {
			db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"))?;
		}
	}
	Ok(db)
}

/// Empties every table derived from the raw chunks (not chunks, the names the uploader sent, or notes).
pub fn clear_derived(db: &Connection) -> rusqlite::Result<()> {
	db.execute_batch(
		"DELETE FROM positions; DELETE FROM events; DELETE FROM quests;
		 UPDATE characters SET race = NULL, class = NULL, faction = NULL, level = NULL, level_t = NULL,
		   sex = NULL, xp = NULL, xp_max = NULL, rested = NULL, xp_t = NULL;",
	)
}
