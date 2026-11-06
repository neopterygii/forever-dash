# Patches carried on `dash`

What this fork changes in upstream files, and where each change stands upstream. Process:
`~/forever-dash/docs/upstream.md`. New files of our own (`services/dash/`, `overlay/`) are not listed.

| Patch | Kind | Upstream issue/PR | Status | Drop when |
|---|---|---|---|---|
| Client: the dashboard upload (`dash.rs`, hooks in `engine.rs`, `store.rs`, `lib.rs`, Settings) and releases from this fork (`addons.rs` REPO, `tauri.conf.json`) | ours | none (out of upstream's scope) | carried | never |
| Client: addon check every hour (`engine.rs` ADDON_CHECK, upstream 6 h); "Update while the game is running" setting (`store.rs`, `manager.rs`, `commands.rs`, Settings, Addons) | ours | none (a preference) | carried | never |
