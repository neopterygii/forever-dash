# forever-dash server (prototype)

Self-hosted dashboard for Polestar Recorder data: characters, a map with last positions and
trail replay (Polestar's planner MapView), and a play journal with notes. See
`~/forever-dash/docs/plan.md` for the plan this prototypes.

```sh
cargo build --release
node tools/export-media.cjs web            # Polestar glyphs + Nav arrow as static PNGs (gitignored)
node tools/brand.cjs                       # web/brand/*.svg (committed; rerun after changing the mark)
node tools/gen-sample.mjs ../../../samples/synth --days 2   # synthetic WTF folder (until real recordings exist)
./target/release/forever-dash serve --db dash.db [--addr 127.0.0.1:8790] [--art <planner art dir>]
./target/release/forever-dash upload --wtf <WTF dir> [--server http://127.0.0.1:8790]
./target/release/forever-dash dump --wtf <WTF dir>           # what the parser makes of it
```

- `POST /v1/upload`: upstream ingest's body and answer (accepted / duplicate / rejected per
  seq, de-duplicated on (install, seq)), plus `maps` and `characters` (charId -> name/realm,
  read from `WTF/Account/<acct>/<realm>/<name>/SavedVariables/Polestar_Recorder.lua`: the
  Recorder itself never records names). `upload` stands in for the client fork's `dash` module.
- Reads: `GET /api/characters`; `/api/overview?hours=6&tol=8` (the live map: every character's
  last N hours of *playtime*, coarse); `/api/sessions?char=`; `/api/trail?char=&from=&to=&tol=`
  (Douglas-Peucker, split at gaps, teleports and ghost runs); `/api/events?char=&from=&to=&kinds=`;
  `/api/journal?char=` (sessions split at 30 min gaps); `POST /api/notes`; `GET /api/stats`.
  Everything is kept; only the map is limited to a playtime buffer.
- Map: overview of all characters (default 6 h of play each), or one character in focus (default
  its last session, up to all play), scrubbed over playtime (offline gaps skipped).
- Web (`web/`): plain ES modules importing `/planner/map/mapview.js` straight from this fork's
  `tools/planner/public`, so MapView updates with upstream. Without `--art` MapView draws its
  grid; with `planner art` output it draws terrain and zone art.
- Raw chunks are kept, so derived tables can be rebuilt after a Recorder schema change.
