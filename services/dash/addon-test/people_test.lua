-- Tests for overlay/addons/Polestar_DashSnapshot/People.lua under Lua 5.1 with a minimal client stub.
--   lua5.1 services/dash/addon-test/people_test.lua   (from the repository root)

local ADDON = "overlay/addons/Polestar_DashSnapshot/People.lua"

local clock, gametime, timers, frames, secret, units, instance
local function reset()
	clock, gametime, timers, frames, secret = 1793920000, 100, {}, {}, {}
	instance = "none"
	units = {
		player = { guid = "Player-1-0001", name = "Mourning", player = true },
	}
	PolestarDashSnapshotDB = nil
end

local function u(id) return units[id] end
local function rv(v) return v end
function issecretvalue(v) return v ~= nil and secret[v] == true end
function GetServerTime() return clock end
function GetTime() return gametime end
function GetRealmName() return "Realm Nine" end
function IsInInstance() return instance ~= "none", instance end
function IsInRaid() return units.raid1 ~= nil end
function UnitExists(id) return u(id) ~= nil end
function UnitIsPlayer(id) return u(id) ~= nil and u(id).player == true end
function UnitIsUnit(a, b)
	if a:match("target$") and a ~= "target" then
		local owner = u(a:sub(1, -7))
		return owner ~= nil and owner.targets == b
	end
	return u(a) ~= nil and u(a) == u(b)
end
function UnitName(id) local x = u(id); return x and x.name, x and x.realm end
function UnitGUID(id) local x = u(id); return x and x.guid end
function UnitClass(id) local x = u(id); return x and x.class, x and x.class end
function UnitRace(id) local x = u(id); return x and x.race, x and x.race end
function UnitSex(id) local x = u(id); return x and x.sex end
function UnitLevel(id) local x = u(id); return x and x.level end
function GetGuildInfo(id) local x = u(id); return x and x.guild end
function UnitFactionGroup(id) local x = u(id); return x and x.faction end
function UnitCanAttack(_, id) local x = u(id); return x ~= nil and x.hostile == true end
function GetPlayerInfoByGUID(guid)
	for _, x in pairs(units) do
		if x.guid == guid then return x.class, x.class, x.race, x.race, x.sex, x.name, x.realm end
	end
end
C_Map = {
	GetBestMapForUnit = function() return 1429 end,
	GetPlayerMapPosition = function() return { x = 0.4123, y = 0.6577 } end,
}
DUEL_WINNER_KNOCKOUT = "%1$s has defeated %2$s in a duel"
DUEL_WINNER_RETREAT = "%2$s has fled from %1$s in a duel"
C_Timer = { After = function(s, fn) timers[#timers + 1] = { at = gametime + s, fn = fn } end }
function CreateFrame()
	local f = { events = {} }
	function f:RegisterEvent(e) self.events[e] = true end
	function f:SetScript(_, fn) self.handler = fn end
	frames[#frames + 1] = f
	return f
end

local function fire(e, ...)
	for _, f in ipairs(frames) do if f.events[e] and f.handler then f.handler(f, e, ...) end end
end
local function advance(s)
	clock, gametime = clock + s, gametime + s
	local due = {}
	for i = #timers, 1, -1 do if timers[i].at <= gametime then due[#due + 1] = table.remove(timers, i) end end
	for i = #due, 1, -1 do due[i].fn() end
end
local function load(keep)
	local saved = PolestarDashSnapshotDB
	reset()
	if keep then PolestarDashSnapshotDB = saved end
	dofile(ADDON)
	fire("PLAYER_ENTERING_WORLD")
end

local ANA = { guid = "Player-1-00A1", name = "Ana", player = true, class = "PRIEST", race = "Human", sex = 3, level = 12, guild = "Dawn", faction = "Alliance" }
local GRUK = { guid = "Player-1-00B2", name = "Gruk", realm = "OtherRealm", player = true, class = "WARRIOR", race = "Orc", sex = 2, level = 14, faction = "Horde", hostile = true }
local function copy(t) local c = {} for k, v in pairs(t) do c[k] = v end return c end

local failed, passed = 0, 0
local function test(name, fn)
	local ok, err = pcall(fn)
	if ok then passed = passed + 1 else failed = failed + 1; print("FAIL " .. name .. ": " .. tostring(err)) end
end
local function eq(a, b, what) if a ~= b then error((what or "value") .. ": expected " .. tostring(b) .. ", got " .. tostring(a), 2) end end
local function mets(how)
	local out = {}
	for _, m in ipairs(PolestarDashSnapshotDB.met) do if not how or m.how == how then out[#out + 1] = m end end
	return out
end

test("joining a group records each member once, with what they look like and where", function()
	load()
	units.party1 = copy(ANA)
	fire("GROUP_ROSTER_UPDATE")
	fire("GROUP_ROSTER_UPDATE")
	local d = PolestarDashSnapshotDB
	local p = d.people["Ana-Realm Nine"]
	eq(p.class, "PRIEST", "class token"); eq(p.race, "Human", "race"); eq(p.level, 12, "level"); eq(p.guild, "Dawn", "guild")
	eq(p.sex, 3, "sex"); eq(p.realm, "Realm Nine", "home realm filled in")
	eq(#mets("group"), 1, "one group meeting")
	local m = mets("group")[1]
	eq(m.who, "Ana-Realm Nine", "who"); eq(m.map, 1429, "map"); eq(m.x, 4123, "x"); eq(m.y, 6577, "y"); eq(m.note, nil, "a party")
	eq(d.peopleAt, clock, "peopleAt")
end)

test("leaving and joining again within half an hour is one meeting; later it is another", function()
	load()
	units.party1 = copy(ANA); fire("GROUP_ROSTER_UPDATE")
	units.party1 = nil; fire("GROUP_ROSTER_UPDATE")
	advance(600)
	units.party1 = copy(ANA); fire("GROUP_ROSTER_UPDATE")
	eq(#mets("group"), 1, "within the window")
	units.party1 = nil; fire("GROUP_ROSTER_UPDATE")
	advance(1800)
	units.party1 = copy(ANA); fire("GROUP_ROSTER_UPDATE")
	eq(#mets("group"), 2, "after it")
end)

test("a reload doesn't record the group again", function()
	load()
	units.party1 = copy(ANA); fire("GROUP_ROSTER_UPDATE")
	advance(60)
	load(true)
	units.party1 = copy(ANA); fire("GROUP_ROSTER_UPDATE")
	eq(#mets("group"), 1, "still one")
end)

test("a raid is noted", function()
	load()
	units.raid1 = copy(ANA)
	fire("GROUP_ROSTER_UPDATE")
	eq(mets("group")[1].note, "raid", "raid")
end)

test("a target held three seconds is seen; a glance is not", function()
	load()
	units.target = copy(GRUK); units.target.hostile = false
	fire("PLAYER_TARGET_CHANGED")
	advance(1)
	units.target = nil
	advance(3)
	eq(#mets("seen"), 0, "a glance")
	units.target = copy(GRUK); units.target.hostile = false
	fire("PLAYER_TARGET_CHANGED")
	advance(3)
	eq(#mets("seen"), 1, "held")
	eq(mets("seen")[1].who, "Gruk-OtherRealm", "other realm kept")
end)

test("a secret name is left out", function()
	load()
	units.target = copy(ANA)
	secret["Ana"] = true
	fire("PLAYER_TARGET_CHANGED")
	advance(3)
	eq(#mets(), 0, "nothing")
	eq(PolestarDashSnapshotDB.people["Ana-Realm Nine"], nil, "no entry")
end)

test("trades and duels", function()
	load()
	units.npc = copy(ANA)
	fire("TRADE_SHOW")
	eq(#mets("trade"), 1, "trade")
	units.target = copy(ANA)
	fire("CHAT_MSG_SYSTEM", "Mourning has defeated Ana in a duel")
	fire("CHAT_MSG_SYSTEM", "Mourning has fled from Ana in a duel")
	fire("CHAT_MSG_SYSTEM", "Bob has defeated Carl in a duel")
	local d = mets("duel")
	eq(#d, 2, "two duels of ours")
	eq(d[1].note, "won", "won"); eq(d[2].note, "lost", "fled = lost")
	eq(d[1].who, "Ana-Realm Nine", "opponent")
end)

test("a hostile player who had us targeted: fought, and killed by", function()
	load()
	local g = copy(GRUK); g.targets = "player"
	units.nameplate1 = g
	fire("NAME_PLATE_UNIT_ADDED", "nameplate1")
	advance(2)
	fire("PLAYER_REGEN_DISABLED")
	advance(5)
	fire("PLAYER_DEAD")
	eq(#mets("fought"), 1, "fought"); eq(#mets("killedby"), 1, "killed by")
	eq(mets("killedby")[1].who, "Gruk-OtherRealm", "who")
end)

test("an old sighting doesn't count as the attacker", function()
	load()
	local g = copy(GRUK); g.targets = "player"
	units.nameplate1 = g
	fire("NAME_PLATE_UNIT_ADDED", "nameplate1")
	advance(30)
	fire("PLAYER_DEAD")
	eq(#mets("killedby"), 0, "too old")
end)

test("our kill of a player, named after combat when it was secret", function()
	load()
	units.nameplate2 = copy(GRUK)
	secret["Gruk"] = true
	fire("PARTY_KILL", "Player-1-0001", "Player-1-00B2")
	fire("PARTY_KILL", "Player-1-0001", "Creature-0-1-2-3-448-0")
	eq(#mets("killed"), 0, "not yet")
	secret["Gruk"] = nil
	fire("PLAYER_REGEN_ENABLED")
	eq(#mets("killed"), 1, "named after combat")
	eq(mets("killed")[1].who, "Gruk-OtherRealm", "who")
end)

test("nothing in battlegrounds", function()
	load()
	instance = "pvp"
	units.party1 = copy(ANA)
	fire("GROUP_ROSTER_UPDATE")
	units.npc = copy(ANA); fire("TRADE_SHOW")
	eq(#mets(), 0, "nothing")
end)

test("the meeting list is capped, oldest first out", function()
	load()
	for i = 1, 805 do
		units.npc = { guid = "Player-1-" .. i, name = "P" .. i, player = true }
		fire("TRADE_SHOW")
	end
	local m = PolestarDashSnapshotDB.met
	eq(#m, 800, "capped")
	eq(m[1].who, "P6-Realm Nine", "oldest dropped")
end)

test("the snapshot's own fields are kept", function()
	reset()
	PolestarDashSnapshotDB = { schema = 1, money = 5 }
	dofile(ADDON)
	fire("PLAYER_ENTERING_WORLD")
	units.npc = copy(ANA); fire("TRADE_SHOW")
	eq(PolestarDashSnapshotDB.money, 5, "money kept")
end)

print(("%d passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
