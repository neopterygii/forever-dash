# forever-dash server (prototype)

Self-hosted dashboard for Polestar Recorder data: characters, a map with last positions and
trail replay (Polestar's planner MapView), and a play journal with notes. See
`~/forever-dash/docs/plan.md` for the plan this prototypes.

```sh
cargo build --release
node tools/export-media.cjs ui/public      # Polestar glyphs + Nav arrow as static PNGs (gitignored)
node tools/brand.cjs                       # ui/public/brand/*.svg (committed; rerun after changing the mark)
# Map art ("Map art" below) and game icons (Blizzard's art: local only, never committed), from wago.tools, no game client needed:
(cd ../../rust && cargo build --release -p forge && ./target/release/forge data build --no-questie --forever-tables wago)
node ../../tools/polestar.js planner art --out <art dir>   # terrain + zone maps
node tools/dash-art.cjs <art dir>                           # Azeroth world map + layout, zone maps cut to their own land
node tools/export-icons.cjs <art dir>                       # race/sex portraits, class icons
(cd ui && pnpm install && pnpm build)      # the web UI -> ui/dist (pnpm dev: hot reload against a running server)
node tools/gen-sample.mjs ../../../samples/synth --days 2   # synthetic WTF folder (until real recordings exist)
./target/release/forever-dash serve --db dash.db --open [--addr 127.0.0.1:8790] [--art <planner art dir>]   # development: no sign-in
./target/release/forever-dash upload --wtf <WTF dir> [--server http://127.0.0.1:8790]
./target/release/forever-dash dump --wtf <WTF dir>           # what the parser makes of it
./target/release/forever-dash reparse --db dash.db           # rebuild derived tables from the raw chunks
./target/release/forever-dash spoken sync --dir spoken --db dash.db   # newest Spoken quest narration
```

## Running your own

Nobody hosts this for you, and it is not affiliated with Blizzard Entertainment or with Polestar. The
image holds the server and its web page only: no game art, no narration, no keys.

```yaml
services:
  forever-dash:
    image: ghcr.io/neopterygii/forever-dash-server:latest
    restart: unless-stopped
    volumes: ["./data:/data"]
    ports: ["127.0.0.1:8790:8790"]   # behind your reverse proxy
    # environment:
    #   DASH_SPOKEN: "1"             # Spoken's quest narration (about 1.1 GB, fetched by the server)
    #   DASH_AI_URL: "http://litellm:4000/v1/chat/completions"   # diary entries in prose; key in data/ai-key
    #   DASH_AI_MODEL: "diary"
    #   DASH_OPEN: "1"               # no group codes: anyone who reaches the address sees and uploads
```

- **First start:** the server writes `data/groups` with one group code. Read it there (`cat data/groups`):
  it signs you in to the site and is the token the client uploads with. More groups: more lines
  (`docker compose exec forever-dash forever-dash group-code` makes a code), then restart.
- **Reverse proxy:** any that passes the request through (Caddy: `reverse_proxy forever-dash:8790`). Serve
  it over https: the sign-in cookie is `Secure` unless the page itself was opened over plain http. Let
  uploads of 4 MB through.
- **Map art:** without `data/art` the map is a grid and says so. Build it with the commands above (they
  need Node, Rust and this checkout, and fetch the client's files from wago.tools) with `data/art` as the
  art folder. It is Blizzard's art: yours to fetch, not ours to put in the image.
- **Off unless you turn it on:** Spoken's narration (`DASH_SPOKEN`: the audio is generated from Blizzard's
  quest text and Spoken's licence covers its code, not the audio, so it is your call) and the prose
  diary (`DASH_AI_URL`: each finished session's facts, with character and NPC names, go to the address
  you give and nowhere else).
- **Backup:** stop the container and copy `data/dash.db` and `data/groups`. The rest can be fetched or
  built again. **Upgrade:** pull the image and start it again; after a release that stores more,
  `forever-dash reparse --db /data/dash.db` rebuilds the derived tables from the raw recordings.
  The image is also tagged `polestar-<addon release>` (`polestar-0.3.7`): the server reads the Recorder's
  format, so keep it on the tag of the addon your PCs run, or newer.
- **What it collects:** what the client uploads from the PCs you set up, and nothing else: the Polestar
  Recorder's recordings (where the character went, quests, kills, deaths, loot, levels, the quest text it
  read), the snapshot addon's character sheet (gear, bags, money, professions, reputation) and the other
  players the character grouped, traded, duelled or fought with or looked at for a while (name, realm,
  class, race, level, guild). It all stays in `data/dash.db` on your server. The server calls out only
  for what you turned on: Spoken's releases on GitHub, and the diary's address.

- **Groups (`serve --groups FILE`):** who sees what. Each line of the file is a group, `<code> <name>`
  (`forever-dash group-code` makes a code), or `+ <device token> <code>` for an older device token that
  uploads into that group. A client uploads with the group code as its token; its characters belong to
  that group. A character stays with the PC (install) that first uploaded it: that PC moves it by
  uploading with another code, another PC naming it does not take it. The site asks for a group code (`POST /api/signin`, kept in an
  HttpOnly cookie for a year) and every read is limited to the group's characters; player notes are
  per group. No code, no site: there is no registration. A `--groups` file that does not exist is made
  with a first code (mode 600; the log names the file, never the code). The server is closed unless told
  otherwise: without `--groups` it starts only with `--open` (the site and uploads open to anyone who can
  reach the address: development, a LAN you trust) or with `--tokens` (uploads need a token, viewing is
  open).
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
  `POST /api/notes`, `POST /api/notes/edit` (`{ id, text }`, empty text deletes); `GET /api/stats`;
  `GET /api/uploads` (upload health: per PC, when it last uploaded and whose play). The journal also
  takes `q` (words to find in places, log lines, notes and diary entries, through the whole history).
  Everything is kept; only the map is limited to a playtime buffer.
- Map: overview of all characters (default 6 h of play each), or one character in focus (default
  its last session, up to all play), scrubbed over playtime (offline gaps skipped).
  Trails are drawn with their corners rounded (`smooth`, `ui/src/lib/overlay.ts`) through every kept
  point and never more than 3 yards off the straight line between two of them; sharp turns stay corners.
- Replay honesty: trail points are dropped by shape *and* time (`simplify`, `TIME_SLACK`), so a
  long stop on a straight stretch keeps its ends and the pin stands still there. The overlay
  (`ui/src/lib/overlay.ts`) keeps each trail's screen line per view with the time of every point:
  playing only moves where the bright part ends, and the same lines answer hover and clicks.
- Map controls: hover a badge, a pin or the trail for what and when; click the trail to go to that
  moment; badges that would cover each other pile up with a count. Space plays and pauses, the
  arrows step a minute of play (ten with Shift), `[` and `]` go to the previous and next event;
  Follow keeps the selected character in view while playing. The address holds the character,
  buffer, moment and open journal (`#c=&b=&t=&j=1`), so a link opens the same thing. The page asks
  for newer play every minute and when it comes back to the front.
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
- **Milestones** (`src/milestones.rs`): a character's firsts and round numbers, found in its whole
  history when read: first herb, ore, skin and fish, each new kind of herb or ore, professions learned,
  their ranks (Journeyman...) and skill steps, first visit to each zone and dungeon, first flight, death,
  elite, rare and boss, boss encounter won, every 10th level, round numbers of errands and kills, first
  lock picked and round numbers of herbs, veins, skins and catches. They show in their session's log (a
  star) and in its diary entry. Needs `loot` and `skill` events (stored since this change: `reparse` an
  older database).
- **Group play** (`src/group.rs`, from the Recorder's `group` records, 0.3.3+): the log says when the
  character joined, changed or left a group; the session's facts give the time spent grouped and the
  diary tells it. The record never says who: when two characters of this dashboard were grouped at the
  same time (2 min or more), the session says they played together ("20 min with Corwyn").
- **Gathering and failed quests:** each session counts its herbs, veins, skins, catches (`loot`) and
  locks picked (`gather`), in its facts and its diary entry; `fail` records show as "Failed “…”" in the
  log and in the diary. `group`, `gather` and `fail` are stored since this change: `reparse` to fill
  them in from the raw chunks.
- **People met** (`src/people.rs`, from Polestar_DashSnapshot's `People.lua`): players a character
  grouped, traded or duelled with, fought (attacked by, killed, killed by; not in battlegrounds), or
  targeted / moused over long enough to matter, with their class, race, level and guild as last seen
  and where each meeting was. The upload pulls `people` and `met` out of the snapshot into their own
  tables (`people`, `met`, every meeting kept). `GET /api/people?char=`, `GET /api/person?who=`,
  `POST /api/person` (`{ who, rating 1-5 or 0, note }`): your rating and notes per player. The
  journal's log lists meetings (not `seen`) with a button to the player's card; the top bar's People
  opens the list. Unit identity is secret in combat on Forever: fights name a player only when they
  were read before or after (best effort). Ours only, never relayed upstream.
- **Map art by zoom** (`ui/src/lib/worldmap.ts`, `tools/dash-art.cjs`): the world painting far out, the
  zones' painted maps at region scale, the minimap terrain close in. The sources, all at the client's
  full size (checked against build 1.60.1.70532: no map uses the larger 3840x2560 art layers): terrain
  at 512 px per 533-yard tile, about one pixel per yard everywhere; every painted map at 1002x668
  whatever it covers, so from 0.10 px per yard (the Barrens) to 1.27 (Ironforge). Each painted map
  therefore gives way to the terrain at its own zoom, when drawn 1.6 to 2.8 times its size, and a city's
  map fades in only once it is 0.3 to 0.5 of its size, so one zoom shows one level of sharpness. `dash-art`
  cuts each zone's map to its own land (where its exploration overlays paint): the maps are overlapping
  rectangles that also sketch their neighbours, and a neighbour's sketch used to cover a zone's own
  detail (a map without overlays gives up the ground other zones own instead; a city's stays whole).
  Re-run `dash-art` on the art folder after changing it (it rebuilds `zones-soft/` when its
  `SOFT_VERSION` changes, and the index names the files with `?v=<version>` so browsers fetch them again;
  the server sends `index.json` with `no-cache`; the client files it needs are cached under `data/sources/casc`). Check with
  `node tools/map-check.cjs http://127.0.0.1:8799 <out dir>`: screenshots of four places at nine zooms
  (it moves the map through `window.__dashView`).
- **Phone pass** (`tools/phone-check.cjs`): after any change to the site, build the UI, run a server with
  sample data and run `node tools/phone-check.cjs http://127.0.0.1:8799 <out dir>`. It opens every view
  (overview, a character, both journals with a quest card, diary editing, gear, bags and stats, people,
  a person's card and a log with a meeting) at 390x844
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
