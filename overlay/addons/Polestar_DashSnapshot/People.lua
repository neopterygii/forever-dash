-- Polestar_DashSnapshot (forever-dash): the players this character meets, for the dashboard's
-- "People met". The Recorder never records other players by design; this is ours only and is never
-- relayed upstream. Saved in PolestarDashSnapshotDB (schema 1, the same save as Snapshot.lua):
--
--   people = { ["Name-Realm"] = { name, realm, class, race, sex, level, guild, faction, seen } }
--            what the player looked like when last read (class and race are the client's tokens:
--            WARRIOR, Scourge...; sex is UnitSex's 2/3; seen = server time of that read).
--            At most MAX_PEOPLE: the longest unseen go first.
--   met    = { { t, who = "Name-Realm", how, map, x, y, note }, ... } oldest first, at most MAX_MET
--            (the server keeps every one it was sent). map is the uiMapID and x, y hundredths of a
--            percent, as the Recorder writes positions. how is one of:
--              group    joined a group with them (party or raid; note "raid")
--              trade    opened a trade window with them
--              duel     a duel ended (note "won" or "lost")
--              seen     targeted for TARGET_HOLD or moused over for MOUSE_HOLD seconds
--              fought   a hostile player had us targeted when combat began
--              killedby a hostile player had us targeted when we died
--              killed   we (or our pet) killed this player
--   peopleAt                        server time of the last change
--
-- Nothing in battlegrounds and arenas. One `met` per player and kind per REPEAT[how] seconds (a
-- reload doesn't repeat them: the window is read back from `met`). Unit identity is secret in
-- combat and in instances on this client: a secret reads as unknown and is left out, so fights
-- only name players read before or after them (best effort). APIs: UnitName, UnitClass, UnitRace,
-- UnitSex, UnitLevel, GetGuildInfo, UnitFactionGroup, GetPlayerInfoByGUID, IsInInstance,
-- TRADE_SHOW (the "npc" unit is the trader), GROUP_ROSTER_UPDATE, CHAT_MSG_SYSTEM with the
-- DUEL_WINNER_KNOCKOUT / DUEL_WINNER_RETREAT strings, PARTY_KILL (attacker, target GUIDs).

local SCHEMA = 1
local MAX_PEOPLE, MAX_MET = 1500, 800
local TARGET_HOLD, MOUSE_HOLD = 3, 2
local FOE_WINDOW = 10 -- seconds a hostile player who targeted us stays the likely attacker
local REPEAT = { group = 1800, trade = 1800, seen = 6 * 3600, fought = 300, killedby = 0, killed = 0, duel = 0 }

local inWorld = false
local recent = {} -- "who\thow" -> server time of the last `met`
local byGuid = {} -- GUID -> "Name-Realm" (this session)
local roster = {} -- "Name-Realm" -> true: the group as last seen
local foe = { who = nil, at = -math.huge }
local unresolved = {} -- player GUIDs we killed but could not name yet

local function readable(v)
	if v ~= nil and issecretvalue and issecretvalue(v) then return nil end
	return v
end
local function str(v)
	v = readable(v)
	return type(v) == "string" and v ~= "" and v or nil
end
local function call(fn, ...)
	if not fn then return nil end
	local ok, a, b, c, d, e, f, g = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g end
end
local function now() return GetServerTime and GetServerTime() or time() end

local function db()
	if type(PolestarDashSnapshotDB) ~= "table" or PolestarDashSnapshotDB.schema ~= SCHEMA then
		PolestarDashSnapshotDB = { schema = SCHEMA }
	end
	local d = PolestarDashSnapshotDB
	d.people = type(d.people) == "table" and d.people or {}
	d.met = type(d.met) == "table" and d.met or {}
	return d
end

local myRealm
local function homeRealm()
	myRealm = myRealm or str(call(GetRealmName)) or ""
	return myRealm
end

-- Battlegrounds and arenas are not "met".
local function pvpInstance()
	local _, kind = call(IsInInstance)
	kind = readable(kind)
	return kind == "pvp" or kind == "arena"
end

-- uiMapID and the position in hundredths of a percent, or nothing.
local function where()
	local map = C_Map and readable(call(C_Map.GetBestMapForUnit, "player"))
	if type(map) ~= "number" then return nil end
	local v = call(C_Map.GetPlayerMapPosition, map, "player")
	local x, y = v and readable(v.x), v and readable(v.y)
	if type(x) ~= "number" or type(y) ~= "number" then return map end
	return map, math.floor(x * 10000 + 0.5), math.floor(y * 10000 + 0.5)
end

local function keyOf(name, realm)
	if not name then return nil end
	realm = realm and realm ~= "" and realm or homeRealm()
	return name .. "-" .. realm, realm
end

local function trim()
	local d = db()
	while #d.met > MAX_MET do table.remove(d.met, 1) end
	local n, oldest, oldKey = 0, math.huge, nil
	for k, p in pairs(d.people) do
		n = n + 1
		if (p.seen or 0) < oldest then oldest, oldKey = p.seen or 0, k end
	end
	if n > MAX_PEOPLE and oldKey then d.people[oldKey] = nil end
end

-- The player behind a unit, read and saved; returns its key. Not ourselves, not NPCs.
local function learn(unit)
	if not (readable(call(UnitExists, unit)) and readable(call(UnitIsPlayer, unit))) then return nil end
	if readable(call(UnitIsUnit, unit, "player")) then return nil end
	local name, realm = call(UnitName, unit)
	local key
	key, realm = keyOf(str(name), str(realm))
	if not key then return nil end
	local d, t = db(), now()
	local p = d.people[key] or { name = str(name) }
	p.realm = realm
	local _, class = call(UnitClass, unit)
	local _, race = call(UnitRace, unit)
	p.class = str(class) or p.class
	p.race = str(race) or p.race
	p.sex = readable(call(UnitSex, unit)) or p.sex
	local level = readable(call(UnitLevel, unit))
	if type(level) == "number" and level > 0 then p.level = level end
	local guild = str(call(GetGuildInfo, unit))
	if guild then p.guild = guild end
	p.faction = str(call(UnitFactionGroup, unit)) or p.faction
	p.seen = t
	d.people[key] = p
	d.peopleAt = t
	local guid = str(call(UnitGUID, unit))
	if guid then byGuid[guid] = key end
	return key
end

-- A player known only by GUID (a kill): GetPlayerInfoByGUID, else what we read this session.
local function learnGuid(guid)
	if byGuid[guid] then return byGuid[guid] end
	local _, class, _, race, sex, name, realm = call(GetPlayerInfoByGUID, guid)
	local key
	key, realm = keyOf(str(name), str(realm))
	if not key then return nil end
	local d, t = db(), now()
	local p = d.people[key] or { name = str(name) }
	p.realm, p.class, p.race = realm, str(class) or p.class, str(race) or p.race
	p.sex = readable(sex) or p.sex
	p.seen = p.seen or t
	d.people[key] = p
	d.peopleAt = t
	byGuid[guid] = key
	return key
end

local function met(who, how, note)
	if not (who and inWorld) or pvpInstance() then return end
	local t = now()
	local id = who .. "\t" .. how
	if recent[id] and t - recent[id] < (REPEAT[how] or 0) then return end
	recent[id] = t
	local d = db()
	local map, x, y = where()
	d.met[#d.met + 1] = { t = t, who = who, how = how, map = map, x = x, y = y, note = note }
	d.peopleAt = t
	trim()
end

-- ---- group ----------------------------------------------------------------
local function groupUnits()
	local units = {}
	if readable(call(IsInRaid)) then
		for i = 1, 40 do units[#units + 1] = "raid" .. i end
	else
		for i = 1, 4 do units[#units + 1] = "party" .. i end
	end
	return units
end

local function onRoster()
	if pvpInstance() then return end
	local raid = readable(call(IsInRaid)) and "raid" or nil
	local current = {}
	for _, u in ipairs(groupUnits()) do
		local key = learn(u)
		if key then
			current[key] = true
			if not roster[key] then met(key, "group", raid) end
		end
	end
	roster = current
end

-- ---- seen: target and mouseover held long enough ------------------------------
local function hold(unit, secs)
	if pvpInstance() then return end
	local guid = str(call(UnitGUID, unit))
	if not (guid and readable(call(UnitIsPlayer, unit))) then return end
	C_Timer.After(secs, function()
		if str(call(UnitGUID, unit)) == guid then met(learn(unit), "seen") end
	end)
end

-- ---- fights: hostile players that have us targeted ---------------------------
local function checkFoe(unit)
	if not readable(call(UnitIsPlayer, unit)) or not readable(call(UnitCanAttack, "player", unit)) then return end
	if not readable(call(UnitIsUnit, unit .. "target", "player")) then return end
	local key = learn(unit)
	if key then foe.who, foe.at = key, GetTime() end
end

local function recentFoe()
	return foe.who and GetTime() - foe.at <= FOE_WINDOW and foe.who or nil
end

local function onKill(attacker, target)
	attacker, target = str(attacker), str(target)
	if not (attacker and target and target:match("^Player%-")) then return end
	local me, pet = str(call(UnitGUID, "player")), str(call(UnitGUID, "pet"))
	if attacker ~= me and attacker ~= pet then return end
	local key = learnGuid(target)
	if key then met(key, "killed") else unresolved[target] = now() end
end

-- ---- duels: the system line "A has defeated B in a duel" ----------------------
-- A global format string ("%1$s has defeated %2$s in a duel") as a pattern, and the order of its
-- captures (1-based argument numbers).
local function formatPattern(fmt)
	if type(fmt) ~= "string" then return nil end
	local order, n = {}, 0
	local pat = fmt:gsub("[%^%$%(%)%.%[%]%*%+%-%?]", "%%%0")
	pat = pat:gsub("%%(%d)%%%$s", function(i) order[#order + 1] = tonumber(i); return "(.+)" end)
	pat = pat:gsub("%%s", function() n = n + 1; order[#order + 1] = n; return "(.+)" end)
	return "^" .. pat .. "$", order
end

local function parse(fmt, text)
	local pat, order = formatPattern(fmt)
	if not pat then return nil end
	local caps = { text:match(pat) }
	if #caps == 0 then return nil end
	local args = {}
	for i, a in ipairs(order) do args[a] = caps[i] end
	return args
end

local function bare(name) return name and (name:match("^([^%-]+)") or name) end

local function onSystem(text)
	text = str(text)
	if not text then return end
	local me = str(call(UnitName, "player"))
	local win = parse(DUEL_WINNER_KNOCKOUT, text) or parse(DUEL_WINNER_RETREAT, text)
	if not (win and me) then return end
	local winner, loser = win[1], win[2]
	local other, note
	if bare(winner) == me then other, note = loser, "won" elseif bare(loser) == me then other, note = winner, "lost" else return end
	-- The opponent is almost always the target; else known by name, else a name-only entry.
	local key = readable(call(UnitIsPlayer, "target")) and bare(str(call(UnitName, "target"))) == bare(other) and learn("target")
	if not key then
		local name, realm = other:match("^([^%-]+)%-(.+)$")
		key = keyOf(name or other, realm)
		local d = db()
		d.people[key] = d.people[key] or { name = name or other, realm = realm or homeRealm(), seen = now() }
	end
	met(key, "duel", note)
end

-- ---- events -----------------------------------------------------------------
local f = CreateFrame("Frame")
f:SetScript("OnEvent", function(_, event, ...)
	if event == "PLAYER_ENTERING_WORLD" then
		inWorld = true
		-- The repeat windows survive a reload: read them back from the save.
		for _, m in ipairs(db().met) do
			local id = (m.who or "") .. "\t" .. (m.how or "")
			if not recent[id] or recent[id] < (m.t or 0) then recent[id] = m.t end
		end
		onRoster()
	elseif event == "PLAYER_LEAVING_WORLD" then
		inWorld = false
	elseif event == "GROUP_ROSTER_UPDATE" then
		onRoster()
	elseif event == "TRADE_SHOW" then
		met(learn("npc"), "trade")
	elseif event == "PLAYER_TARGET_CHANGED" then
		checkFoe("target")
		hold("target", TARGET_HOLD)
	elseif event == "UPDATE_MOUSEOVER_UNIT" then
		hold("mouseover", MOUSE_HOLD)
	elseif event == "UNIT_TARGET" or event == "NAME_PLATE_UNIT_ADDED" then
		local unit = ...
		if str(unit) then checkFoe(unit) end
	elseif event == "PLAYER_REGEN_DISABLED" then
		met(recentFoe(), "fought")
	elseif event == "PLAYER_REGEN_ENABLED" then
		for guid in pairs(unresolved) do
			local key = learnGuid(guid)
			if key then met(key, "killed"); unresolved[guid] = nil end
		end
	elseif event == "PLAYER_DEAD" then
		met(recentFoe(), "killedby")
		foe.who = nil
	elseif event == "PARTY_KILL" then
		onKill(...)
	elseif event == "CHAT_MSG_SYSTEM" then
		onSystem(...)
	end
end)
for _, e in ipairs({ "PLAYER_ENTERING_WORLD", "PLAYER_LEAVING_WORLD", "GROUP_ROSTER_UPDATE", "TRADE_SHOW", "PLAYER_TARGET_CHANGED",
	"UPDATE_MOUSEOVER_UNIT", "UNIT_TARGET", "NAME_PLATE_UNIT_ADDED", "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "PLAYER_DEAD",
	"PARTY_KILL", "CHAT_MSG_SYSTEM" }) do
	pcall(f.RegisterEvent, f, e)
end
