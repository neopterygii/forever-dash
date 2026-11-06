# forever-dash server (prototype)

Self-hosted dashboard for Polestar Recorder data: characters, a map with last positions and
trail replay (Polestar's planner MapView), and a play journal with notes. See
`~/forever-dash/docs/plan.md` for the plan this prototypes.

```sh
cargo build --release
node tools/export-media.cjs ui/public      # Polestar glyphs + Nav arrow as static PNGs (gitignored)
node tools/brand.cjs                       # ui/public/brand/*.svg (committed; rerun after changing the mark)
# Map art and game icons (Blizzard's art: local only, never committed), from wago.tools, no game client needed:
(cd ../../rust && cargo build --release -p forge && ./target/release/forge data build --no-questie --forever-tables wago)
node ../../tools/polestar.js planner art --out <art dir>   # terrain + zone maps
node tools/dash-art.cjs <art dir>                           # Azeroth world map + layout, feathered zone maps
node tools/export-icons.cjs <art dir>                       # race/sex portraits, class icons
(cd ui && pnpm install && pnpm build)      # the web UI -> ui/dist (pnpm dev: hot reload against a running server)
node tools/gen-sample.mjs ../../../samples/synth --days 2   # synthetic WTF folder (until real recordings exist)
./target/release/forever-dash serve --db dash.db [--addr 127.0.0.1:8790] [--art <planner art dir>]
./target/release/forever-dash upload --wtf <WTF dir> [--server http://127.0.0.1:8790]
./target/release/forever-dash dump --wtf <WTF dir>           # what the parser makes of it
./target/release/forever-dash reparse --db dash.db           # rebuild derived tables from the raw chunks
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
- Web (`ui/`): Svelte 5 + TypeScript + Vite, the same stack and versions as Polestar Client
  (`apps/client`). It bundles MapView from this fork's `tools/planner/public/map/` and takes
  Polestar's design tokens and fonts from the planner's stylesheet at build time
  (`vite.config.ts`, `polestarTokens`; only `:root` and `@font-face`, since the planner's own
  layout rules use global class names). Without `--art` MapView draws its grid; with
  `planner art` output it draws terrain and zone art.
- Raw chunks are kept, so derived tables can be rebuilt after a Recorder schema change.
