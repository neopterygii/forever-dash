# Patches carried on `dash`

What this fork changes in upstream files, and where each change stands upstream. Process:
`~/forever-dash/docs/upstream.md`. New files of our own (`services/dash/`, `overlay/`) are not listed.

| Patch | Kind | Upstream issue/PR | Status | Drop when |
|---|---|---|---|---|
| Client: the dashboard upload (`dash.rs`, hooks in `engine.rs`, `store.rs`, `lib.rs`, Settings) and releases from this fork (`addons.rs` REPO, `tauri.conf.json`, and the links to them: `notices.ts` releaseUrl, Addons RELEASES, `copy.ts` CLIENT_URL) | ours | none (out of upstream's scope) | carried | never |
| Client: addon check every hour (`engine.rs` ADDON_CHECK, upstream 6 h); "Update while the game is running" setting (`store.rs`, `manager.rs`, `commands.rs`, Settings, Addons) | ours | none (a preference) | carried | never |
| Client releases publish themselves: `client.yml` "Publish (forever-dash)" step after the draft; `dash-client-sync.yml` merges each upstream `client-v*` into dash and tags ours | ours | none (our release process) | carried | never |
| Addon: Nav API minor 1 (`Polestar.Nav.API.Target`, `Follow`, `Unfollow`, `Dismiss`), which Naowh Forever's waypoint follow needs. Overlay patch: `overlay/patches/Polestar/` (`Nav/Arrow.lua`, `Bridges.lua`, `Journey.lua`, `Nav.lua`, `UI/Options.lua`), based on upstream 0.3.7.2. Rebase: `git diff up/next...nav-api-target -- addon/` applied with `--3way` onto the new release tag, nav addontests, copy the files, new base hashes in `overlay/manifest.json` | carry | [#1332](https://github.com/fitzforge/polestar/issues/1332), PR [#1329](https://github.com/fitzforge/polestar/pull/1329) | open; maintainer plans it for 0.3.8 | upstream ships it: the build then leaves the patch out by itself (`upstream_has`) and warns; delete the entries and files |
