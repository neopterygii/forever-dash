//! Names for the ids in recordings, imported from Polestar's reference data (`forge data build`:
//! data/forever/{npcs,quests,objects,items}.json) and the Forever client tables it caches from
//! wago.tools (data/sources/wago/<build>/: AreaTable, SpellName, Map, ItemSparse, Item).
//! Kept in the database so the server needs neither at run time; re-run after a data build.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS names (kind TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE IF NOT EXISTS items (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	quality INTEGER,
	ilvl INTEGER,
	req_level INTEGER,
	inv_type INTEGER,
	icon INTEGER
);
-- NPCs with a name of their own (a rank, or one spawn point: Hogger, Executor Arren), as opposed
-- to one of many (a Scarlet Initiate): the diary writes an article before the others.
CREATE TABLE IF NOT EXISTS npc_named (id INTEGER PRIMARY KEY);
-- Polestar's reference facts per quest (data/forever/quests.json).
CREATE TABLE IF NOT EXISTS quest_ref (
	id INTEGER PRIMARY KEY,
	level INTEGER,
	min_level INTEGER,
	zone INTEGER,
	objective_text TEXT,
	xp INTEGER,
	start_npc INTEGER,
	start_object INTEGER,
	start_item INTEGER,
	end_npc INTEGER,
	end_object INTEGER,
	next INTEGER
);
";

/// A name by kind (`npc`, `quest`, `object`, `area`, `spell`, `map`) and id.
pub fn name(db: &Connection, kind: &str, id: &str) -> Option<String> {
	let id: i64 = id.parse().ok()?;
	db.query_row("SELECT name FROM names WHERE kind = ?1 AND id = ?2", params![kind, id], |r| r.get(0)).optional().ok().flatten()
}

fn json_names(path: &Path, field: &str) -> Result<Vec<(i64, String)>, String> {
	let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
	let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
	let obj = v.as_object().ok_or_else(|| format!("{}: not an object", path.display()))?;
	Ok(obj
		.iter()
		.filter_map(|(k, e)| Some((k.parse().ok()?, e.get(field)?.as_str()?.trim().to_string())))
		.filter(|(_, n)| !n.is_empty())
		.collect())
}

/// Rows of a client table CSV as column -> value maps (only the wanted columns).
fn csv_rows(path: &Path, cols: &[&str]) -> Result<Vec<HashMap<String, String>>, String> {
	let mut r = csv::Reader::from_path(path).map_err(|e| format!("{}: {e}", path.display()))?;
	let headers = r.headers().map_err(|e| e.to_string())?.clone();
	let idx: Vec<(usize, &str)> = cols.iter().filter_map(|c| headers.iter().position(|h| h == *c).map(|i| (i, *c))).collect();
	if idx.len() != cols.len() {
		return Err(format!("{}: missing one of the columns {cols:?}", path.display()));
	}
	let mut out = Vec::new();
	for rec in r.records() {
		let rec = rec.map_err(|e| e.to_string())?;
		out.push(idx.iter().map(|(i, c)| (c.to_string(), rec.get(*i).unwrap_or("").to_string())).collect());
	}
	Ok(out)
}

/// NPCs with a name of their own: a rank (elite, rare, boss) or a single spawn point.
fn named_npcs(tx: &Connection, path: &Path) -> Result<usize, String> {
	let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
	let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
	let obj = v.as_object().ok_or_else(|| format!("{}: not an object", path.display()))?;
	let mut st = tx.prepare_cached("INSERT OR IGNORE INTO npc_named (id) VALUES (?1)").map_err(|e| e.to_string())?;
	let mut n = 0;
	for (k, npc) in obj {
		let Ok(id) = k.parse::<i64>() else { continue };
		let ranked = npc.get("rank").and_then(Value::as_i64).is_some_and(|r| r > 0);
		let points: usize = npc.get("spawns").and_then(Value::as_object).map_or(0, |s| s.values().map(|z| z.get("pts").and_then(Value::as_array).map_or(0, Vec::len)).sum());
		if ranked || points == 1 {
			n += st.execute([id]).map_err(|e| e.to_string())?;
		}
	}
	Ok(n)
}

/// Polestar's per-quest facts: level, zone, objectives, who starts and ends it.
fn quest_refs(tx: &Connection, path: &Path) -> Result<usize, String> {
	let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
	let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
	let obj = v.as_object().ok_or_else(|| format!("{}: not an object", path.display()))?;
	let mut st = tx
		.prepare_cached("INSERT OR REPLACE INTO quest_ref (id, level, min_level, zone, objective_text, xp, start_npc, start_object, start_item, end_npc, end_object, next) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
		.map_err(|e| e.to_string())?;
	let first = |q: &Value, side: &str, kind: &str| q.get(side).and_then(|s| s.get(kind)).and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_i64);
	let mut n = 0;
	for (k, q) in obj {
		let Ok(id) = k.parse::<i64>() else { continue };
		let i = |f: &str| q.get(f).and_then(Value::as_i64);
		let text = q.get("objectiveText").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
		n += st
			.execute(params![
				id, i("level"), i("minLevel"), i("zone"), text, i("xp"),
				first(q, "start", "npc"), first(q, "start", "object"), first(q, "start", "item"),
				first(q, "end", "npc"), first(q, "end", "object"), i("next"),
			])
			.map_err(|e| e.to_string())?;
	}
	Ok(n)
}

/// Imports every name; returns counts per kind.
pub fn import(db: &mut Connection, data: &Path, tables: &Path) -> Result<Vec<(String, usize)>, String> {
	db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
	let tx = db.transaction().map_err(|e| e.to_string())?;
	tx.execute_batch("DELETE FROM names; DELETE FROM items; DELETE FROM quest_ref; DELETE FROM npc_named;").map_err(|e| e.to_string())?;
	let mut counts = Vec::new();
	let mut put = |kind: &str, rows: Vec<(i64, String)>| -> Result<(), String> {
		let mut st = tx.prepare_cached("INSERT OR REPLACE INTO names (kind, id, name) VALUES (?1, ?2, ?3)").map_err(|e| e.to_string())?;
		for (id, n) in &rows {
			st.execute(params![kind, id, n]).map_err(|e| e.to_string())?;
		}
		counts.push((kind.to_string(), rows.len()));
		Ok(())
	};
	put("npc", json_names(&data.join("npcs.json"), "name")?)?;
	put("quest", json_names(&data.join("quests.json"), "title")?)?;
	put("object", json_names(&data.join("objects.json"), "name")?)?;
	let col = |rows: Vec<HashMap<String, String>>, name: &str| -> Vec<(i64, String)> {
		rows.into_iter().filter_map(|r| Some((r.get("ID")?.parse().ok()?, r.get(name)?.clone()))).filter(|(_, n)| !n.is_empty()).collect()
	};
	put("area", col(csv_rows(&tables.join("AreaTable.csv"), &["ID", "AreaName_lang"])?, "AreaName_lang"))?;
	put("spell", col(csv_rows(&tables.join("SpellName.csv"), &["ID", "Name_lang"])?, "Name_lang"))?;
	put("map", col(csv_rows(&tables.join("Map.csv"), &["ID", "MapName_lang"])?, "MapName_lang"))?;
	// uiMap ids (a quest's zone, the Recorder's `map`): the zone's name as the world map shows it.
	put("uimap", col(csv_rows(&tables.join("UiMap.csv"), &["ID", "Name_lang"])?, "Name_lang"))?;
	drop(put);
	counts.push(("quest facts".into(), quest_refs(&tx, &data.join("quests.json"))?));
	counts.push(("named npcs".into(), named_npcs(&tx, &data.join("npcs.json"))?));

	// Items: names, quality, levels and slot from ItemSparse, the icon from Item; Polestar's names
	// for items the sparse table lacks.
	let icons: HashMap<i64, (i64, i64)> = csv_rows(&tables.join("Item.csv"), &["ID", "IconFileDataID", "InventoryType"])?
		.into_iter()
		.filter_map(|r| Some((r["ID"].parse().ok()?, (r["IconFileDataID"].parse().unwrap_or(0), r["InventoryType"].parse().unwrap_or(0)))))
		.collect();
	let n = |r: &HashMap<String, String>, c: &str| r.get(c).and_then(|v| v.parse::<i64>().ok());
	let mut st = tx.prepare_cached("INSERT OR REPLACE INTO items (id, name, quality, ilvl, req_level, inv_type, icon) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").map_err(|e| e.to_string())?;
	let mut items = 0;
	for r in csv_rows(&tables.join("ItemSparse.csv"), &["ID", "Display_lang", "OverallQualityID", "ItemLevel", "RequiredLevel", "InventoryType"])? {
		let Some(id) = n(&r, "ID") else { continue };
		let icon = icons.get(&id).map(|i| i.0).filter(|i| *i > 0);
		st.execute(params![id, r["Display_lang"], n(&r, "OverallQualityID"), n(&r, "ItemLevel"), n(&r, "RequiredLevel"), n(&r, "InventoryType"), icon]).map_err(|e| e.to_string())?;
		items += 1;
	}
	drop(st);
	// Polestar's names for items the client table lacks; never over a row from it.
	let mut st = tx.prepare_cached("INSERT OR IGNORE INTO items (id, name, inv_type, icon) VALUES (?1, ?2, ?3, ?4)").map_err(|e| e.to_string())?;
	for (id, name) in json_names(&data.join("items.json"), "name")? {
		let (icon, inv) = icons.get(&id).copied().unwrap_or((0, 0));
		items += st.execute(params![id, name, inv, (icon > 0).then_some(icon)]).map_err(|e| e.to_string())?;
	}
	drop(st);
	counts.push(("item".into(), items));
	tx.commit().map_err(|e| e.to_string())?;
	Ok(counts)
}
