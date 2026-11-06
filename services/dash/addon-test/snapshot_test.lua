-- Tests for overlay/addons/Polestar_DashSnapshot/Snapshot.lua under Lua 5.1 with a minimal client stub.
--   lua5.1 services/dash/addon-test/snapshot_test.lua   (from the repository root)
-- Kept outside the addon folder: the overlay build ships every file in it.

local ADDON = "overlay/addons/Polestar_DashSnapshot/Snapshot.lua"

-- ---- the client stub ------------------------------------------------------
local clock, timers, frames = 1793920000, {}, {}
local secret = {}
local world

local function reset()
	clock, timers, frames, secret = 1793920000, {}, {}, {}
	world = {
		name = "Mourning", realm = "CAMWOW US2 Realm 9 RP PvP", money = 187,
		-- slot -> link
		equip = {
			[1] = "|cffffffff|Hitem:20901:0:0:0:0:0:0:0:5:::::|h[Cap]|h|r",
			[16] = "|cff1eff00|Hitem:2504:0:0:0:0:0:1034:0:5:::::|h[Staff of the Owl]|h|r",
		},
		-- bag -> { size, items = { [slot] = { id, count } } }
		bags = { [0] = { size = 16, items = { [1] = { 6948, 1 }, [3] = { 159, 5 } } }, [1] = { size = 6, items = { [2] = { 2589, 12 } } } },
		bagItems = { [20] = 4496 }, -- inventory slot of bag 1 -> a Small Brown Pouch
		bank = { [-1] = { size = 24, items = { [5] = { 2770, 20 } } } },
	}
	PolestarDashSnapshotDB = nil
end

function issecretvalue(v) return v ~= nil and secret[v] == true end
function GetServerTime() return clock end
function UnitName() return world.name end
function GetRealmName() return world.realm end
function GetMoney() return world.money end
function UnitHealthMax() return 152 end
function UnitPowerMax() return 300 end
function UnitPowerType() return 0, "MANA" end
local STATS = { 20, 22, 21, 30, 28 }
function UnitStat(_, i) return STATS[i], STATS[i] + 1 end
function UnitArmor() return 40, 45 end
function GetInventoryItemLink(_, slot) return world.equip[slot] end
function GetInventoryItemID(_, slot) return world.bagItems[slot] end
NUM_BAG_SLOTS, NUM_BANKBAGSLOTS = 4, 6
local function container(bag) return world.bags[bag] or (world.bankOpen and world.bank[bag]) end
C_Container = {
	GetContainerNumSlots = function(bag) local b = container(bag); return b and b.size or 0 end,
	GetContainerItemInfo = function(bag, slot)
		local b = container(bag); local it = b and b.items[slot]
		return it and { itemID = it[1], stackCount = it[2] } or nil
	end,
	ContainerIDToInventoryID = function(bag) return 19 + bag end,
}
C_Timer = { After = function(s, fn) timers[#timers + 1] = { at = clock + s, fn = fn } end }
function CreateFrame()
	local f = { events = {} }
	function f:RegisterEvent(e) self.events[e] = true end
	function f:RegisterUnitEvent(e) self.events[e] = true end
	function f:SetScript(_, fn) self.handler = fn end
	frames[#frames + 1] = f
	return f
end

local function fire(e, ...)
	for _, f in ipairs(frames) do if f.events[e] and f.handler then f.handler(f, e, ...) end end
end

local function advance(s)
	clock = clock + s
	local due = {}
	for i = #timers, 1, -1 do if timers[i].at <= clock then due[#due + 1] = table.remove(timers, i) end end
	for i = #due, 1, -1 do due[i].fn() end
end

local function load()
	reset()
	dofile(ADDON)
end

-- ---- tests ----------------------------------------------------------------
local failed, passed = 0, 0
local function test(name, fn)
	local ok, err = pcall(fn)
	if ok then passed = passed + 1 else failed = failed + 1; print("FAIL " .. name .. ": " .. tostring(err)) end
end
local function eq(a, b, what) if a ~= b then error((what or "value") .. ": expected " .. tostring(b) .. ", got " .. tostring(a), 2) end end

test("nothing is read before the world, and the login read waits five seconds", function()
	load()
	fire("PLAYER_MONEY")
	advance(2)
	eq(PolestarDashSnapshotDB, nil, "db before PLAYER_ENTERING_WORLD")
	fire("PLAYER_ENTERING_WORLD")
	advance(4)
	eq(PolestarDashSnapshotDB, nil, "db before the login delay")
	advance(2) -- the login delay, then the coalesce second
	advance(1)
	local d = PolestarDashSnapshotDB
	eq(d.schema, 1, "schema")
	eq(d.name, "Mourning", "name")
	eq(d.realm, "CAMWOW US2 Realm 9 RP PvP", "realm")
	eq(d.money, 187, "money")
	eq(d.equip[16], "item:2504:0:0:0:0:0:1034:0:5:::::", "weapon item string with its suffix")
	eq(d.equip[1], "item:20901:0:0:0:0:0:0:0:5:::::", "head")
	eq(d.bags[0].size, 16, "backpack size")
	eq(d.bags[0].slots[1], "6948:1", "hearthstone")
	eq(d.bags[0].slots[3], "159:5", "a stack")
	eq(d.bags[1].item, 4496, "bag 1's own item")
	eq(d.bags[2], nil, "an empty bag slot")
	eq(d.bank, nil, "no bank before it was opened")
	eq(d.equipAt, d.bagsAt, "read together")
	eq(d.stats.health, 152, "max health")
	eq(d.stats.power, 300, "max power")
	eq(d.stats.powerType, "MANA", "power type")
	eq(d.stats.int, 31, "intellect with gear and buffs")
	eq(d.stats.armor, 45, "armor")
end)

test("attributes are read again on a level up, not on bag changes", function()
	load()
	fire("PLAYER_ENTERING_WORLD"); advance(6); advance(1)
	local d = PolestarDashSnapshotDB
	local at = d.statsAt
	advance(10)
	fire("BAG_UPDATE_DELAYED"); advance(1)
	eq(d.statsAt, at, "bags alone leave the attributes")
	STATS[1] = 25
	fire("PLAYER_LEVEL_UP"); advance(1)
	eq(d.stats.str, 26, "strength after the level")
end)

test("changes are coalesced and only the changed part is read again", function()
	load()
	fire("PLAYER_ENTERING_WORLD"); advance(6); advance(1)
	local d = PolestarDashSnapshotDB
	local before = d.equipAt
	world.bags[0].items[4] = { 2589, 3 }
	advance(10)
	fire("BAG_UPDATE_DELAYED"); fire("BAG_UPDATE_DELAYED"); fire("BAG_UPDATE_DELAYED")
	eq(d.bags[0].slots[4], nil, "not read before the coalesce second")
	advance(1)
	eq(d.bags[0].slots[4], "2589:3", "read after it")
	eq(d.equipAt, before, "equipment untouched")
end)

test("the bank is read only while it is open, and kept after it closes", function()
	load()
	fire("PLAYER_ENTERING_WORLD"); advance(6); advance(1)
	world.bankOpen = true
	fire("BANKFRAME_OPENED"); advance(1)
	local d = PolestarDashSnapshotDB
	eq(d.bank[-1].slots[5], "2770:20", "bank slot")
	world.bankOpen = false
	fire("BANKFRAME_CLOSED")
	fire("PLAYERBANKSLOTS_CHANGED"); advance(1)
	eq(d.bank[-1].slots[5], "2770:20", "kept as last seen")
end)

test("nothing is read while the world goes away", function()
	load()
	fire("PLAYER_ENTERING_WORLD"); advance(6); advance(1)
	world.money = 0 -- what the client answers during logout
	fire("PLAYER_MONEY")
	fire("PLAYER_LEAVING_WORLD")
	advance(2)
	eq(PolestarDashSnapshotDB.money, 187, "money kept")
end)

test("secret values are left out", function()
	load()
	secret[world.equip[1]] = true
	fire("PLAYER_ENTERING_WORLD"); advance(6); advance(1)
	eq(PolestarDashSnapshotDB.equip[1], nil, "secret link")
	eq(PolestarDashSnapshotDB.equip[16] ~= nil, true, "the others still read")
end)

test("a db from another schema starts over", function()
	reset()
	PolestarDashSnapshotDB = { schema = 0, junk = true }
	dofile(ADDON)
	fire("PLAYER_ENTERING_WORLD"); advance(6); advance(1)
	eq(PolestarDashSnapshotDB.junk, nil, "old fields gone")
	eq(PolestarDashSnapshotDB.schema, 1, "schema")
end)

print(("%d passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
