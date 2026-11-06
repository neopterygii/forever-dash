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
./target/release/forever-dash spoken sync --dir spoken --db dash.db   # newest Spoken quest narration
```

- `POST /v1/upload`: upstream ingest's body and answer (accepted / duplicate / rejected per
  seq, de-duplicated on (install, seq)), plus `maps` and `characters` (charId -> name/realm,
  read from `WTF/Account/<acct>/<realm>/<name>/SavedVariables/Polestar_Recorder.lua`: the
  Recorder itself never records names). `upload` stands in for the client fork's `dash` module.
- Reads: `GET /api/characters`; `/api/overview?hours=6&tol=8` (the live map: every character's
  last N hours of *playtime*, coarse); `/api/sessions?char=`; `/api/trail?char=&from=&to=&tol=`
  (Douglas-Peucker, split at gaps, teleports and ghost runs); `/api/events?char=&from=&to=&kinds=`;
  `/api/journal?char=&before=&beforeChar=&limit=10` (sessions split at 30 min gaps, newest first,
  a page at a time: `{ sessions, more }`; without `char`, every character's sessions together;
  `before`/`beforeChar` = the last session shown); `/api/quest?char=&id=` (the quest
  card: Polestar's facts from `names`, the text the character read, giver, rewards, time taken);
  `POST /api/notes`; `GET /api/stats`.
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
- **Diary** (`src/diary.rs`): each session as a short first-person entry above its log, written
  from templates (deterministic, instant). With `serve --ai-url URL --ai-key-file FILE [--ai-model
  diary]` (an OpenAI-compatible endpoint: the LiteLLM gateway on Unraid, Gemini only) a worker
  rewrites closed sessions in prose, newest first, and keeps the answer; a failure keeps the
  template entry until the next round. `POST /api/diary` stores your own entry (empty = back to the
  written one). Only recorded facts go into an entry or a prompt.
- **Phone pass** (`tools/phone-check.cjs`): after any change to the site, build the UI, run a server with
  sample data and run `node tools/phone-check.cjs http://127.0.0.1:8799 <out dir>`. It opens every view
  (overview, a character, both journals with a quest card, diary editing, gear, bags and stats) at 390x844
  and 360x780 as a touch phone, saves a screenshot of each and fails on sideways scrolling, anything past
  the screen's edge and console or request errors (a missing item icon is expected); it lists tap targets
  under 32 px. Then look at the screenshots. Touch sizes come from one rule in `ui/src/app.css`
  (`pointer: coarse` or narrow): about 40 px per control, desktop unchanged.
- **Quest narration** (`serve --spoken <dir>`, `src/spoken.rs`): the journal's accept and turn-in
  lines play the voice-over the Spoken addons play in game (rusty-key/spoken-wow). The server
  follows its `quests-audio/v*` releases (at start, then daily): it downloads
  `SpokenQuestsAudioAll-<v>.zip`, keeps the quest lines and lookup tables (~1.1 GB), imports the
  tables and serves `/spoken/...` from `<dir>/<current>`. Files are resolved as Spoken_Quests does
  (giver's own voice, player's sex) minus what needs a live unit. Spoken's MIT licence covers its
  code, not the generated audio (ElevenLabs/fish.audio from Blizzard's text): data volume only,
  never committed or put in the image. Ogg Vorbis: no play buttons where the browser can't play it.
