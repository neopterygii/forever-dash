# forever-dash server: the dashboard API and its web UI. Build from the repository root:
#   docker build -f services/dash/Dockerfile -t forever-dash .
# Map art (--art) and names (forever-dash names) come from the mounted /data volume; the flight
# network's tracks (Polestar's Maps/FlightPaths.lua) are compiled in. The site is private.
FROM node:24-bookworm-slim AS ui
WORKDIR /src
COPY tools tools
COPY addon/Polestar/Media addon/Polestar/Media
COPY services/dash/tools services/dash/tools
COPY services/dash/ui services/dash/ui
# Polestar's own glyphs and Nav textures (generated, not committed), then the UI.
RUN rm -rf services/dash/ui/node_modules services/dash/ui/dist \
 && node services/dash/tools/export-media.cjs services/dash/ui/public \
 && cd services/dash/ui && npx -y pnpm@12.4.1 install --frozen-lockfile && npx -y pnpm@12.4.1 build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY rust/crates/polestar-recording rust/crates/polestar-recording
COPY services/dash/Cargo.toml services/dash/Cargo.lock services/dash/
COPY services/dash/proto services/dash/proto
COPY services/dash/src services/dash/src
COPY addon/Polestar/Maps/FlightPaths.lua addon/Polestar/Maps/FlightPaths.lua
RUN cd services/dash && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/services/dash/target/release/forever-dash /usr/local/bin/forever-dash
COPY --from=ui /src/services/dash/ui/dist /app/web
COPY addon/Polestar/Media/Fonts /app/fonts
VOLUME /data
EXPOSE 8790
# /data: dash.db, art/ (forever-dash art build), spoken/ (Spoken's quest narration, fetched and kept
# current by the server), groups (group codes: sign-in and uploads, see src/groups.rs; absent = an open
# site), tokens (device tokens when there are no groups; absent = open uploads), ai-key (the
# LiteLLM gateway's key: diary entries in prose; absent = template entries only; DASH_AI_URL, DASH_AI_MODEL)
CMD ["sh", "-c", "exec forever-dash serve --db /data/dash.db --addr 0.0.0.0:8790 --web /app/web --fonts /app/fonts --art /data/art --spoken /data/spoken $( [ -f /data/groups ] && echo --groups /data/groups ) $( [ -f /data/tokens ] && echo --tokens /data/tokens ) $( [ -f /data/ai-key ] && echo --ai-url ${DASH_AI_URL:-http://litellm:4000/v1/chat/completions} --ai-key-file /data/ai-key --ai-model ${DASH_AI_MODEL:-diary} )"]
