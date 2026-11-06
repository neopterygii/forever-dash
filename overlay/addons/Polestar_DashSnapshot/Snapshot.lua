-- Polestar_DashSnapshot (forever-dash): what this character wears and carries, for the self-hosted
-- dashboard. Polestar already keeps level, XP, money, professions and the hearthstone in
-- PolestarDB.alts (Alts/Snapshot.lua); this adds the items. The uploader reads this file from the
-- character's SavedVariables folder.
--
-- Named Polestar_* with Author "Polestar; ..." on purpose: Polestar Client only installs a Polestar
-- zip whose folders are all Polestar_* (addons.rs check()) and manages the folders authored Polestar.
--
-- PolestarDashSnapshotDB (per character), schema 1:
--   name, realm                     who (realm from GetRealmName)
--   equip  = { [slot] = itemString } inventory slots 0 (ammo) to 19; itemString keeps the
--                                   enchant and random suffix ("item:7413:0:0:0:0:0:1034:0...")
--   bags   = { [bag] = { size, item = bagItemID, slots = { [slot] = "itemID:count" } } }
--                                   bags 0-4, and the keyring (-2) when the client has one
--   bank   = same, for the bank (-1) and its bags (5 ...): only read while the bank is open,
--            so it is the bank as last seen
--   money                           copper
--   equipAt, bagsAt, bankAt, moneyAt  server time of each part's last read
--
-- When it reads: in the world, five seconds after entering it; then on equipment, bag, money and
-- bank changes (coalesced, one second). NOTHING on PLAYER_LEAVING_WORLD or PLAYER_LOGOUT: the client
-- answers those reads wrongly while the world goes (Polestar's Alts/Snapshot.lua, same rule).
-- Secret values (Forever has Midnight's addon restrictions) read as unknown and are left out.

local SCHEMA = 1
local LOGIN_DELAY = 5
local COALESCE = 1
local FIRST_SLOT, LAST_SLOT = 0, 19
local BANK, KEYRING = -1, -2

local C = C_Container
local inWorld, bankOpen = false, false
local dirty = {}
local pending = false

local function readable(v)
	if v ~= nil and issecretvalue and issecretvalue(v) then return nil end
	return v
end

local function now() return GetServerTime and GetServerTime() or time() end

local function db()
	if type(PolestarDashSnapshotDB) ~= "table" or PolestarDashSnapshotDB.schema ~= SCHEMA then
		PolestarDashSnapshotDB = { schema = SCHEMA }
	end
	return PolestarDashSnapshotDB
end

-- "item:..." from an item link, or nil.
local function itemString(link)
	link = readable(link)
	return type(link) == "string" and link:match("|H(item:[^|]+)|h") or nil
end

local function readEquip()
	local out = {}
	for slot = FIRST_SLOT, LAST_SLOT do
		local s = itemString(GetInventoryItemLink("player", slot))
		if s then out[slot] = s end
	end
	return out
end

local function numSlots(bag)
	return (C and C.GetContainerNumSlots and readable(C.GetContainerNumSlots(bag))) or 0
end

-- The item a bag slot holds (bags 1-4 and the bank's bags; not the backpack, bank or keyring).
local function bagItem(bag)
	if bag <= 0 or not (C and C.ContainerIDToInventoryID) then return nil end
	local ok, inv = pcall(C.ContainerIDToInventoryID, bag)
	return ok and readable(inv) and readable(GetInventoryItemID("player", inv)) or nil
end

local function readBag(bag)
	local size = numSlots(bag)
	if size <= 0 then return nil end
	local slots = {}
	for slot = 1, size do
		local info = C.GetContainerItemInfo and C.GetContainerItemInfo(bag, slot)
		local id = info and readable(info.itemID)
		if id then slots[slot] = id .. ":" .. (readable(info.stackCount) or 1) end
	end
	return { size = size, item = bagItem(bag), slots = slots }
end

local function readBags()
	local out = {}
	for bag = 0, NUM_BAG_SLOTS or 4 do out[bag] = readBag(bag) end
	out[KEYRING] = readBag(KEYRING)
	return out
end

local function readBank()
	local out = { [BANK] = readBag(BANK) }
	local first = (NUM_BAG_SLOTS or 4) + 1
	for bag = first, first + (NUM_BANKBAGSLOTS or 6) - 1 do out[bag] = readBag(bag) end
	return out
end

local function write()
	pending = false
	if not inWorld then return end
	local d, t = db()
	t = now()
	if not d.name then
		d.name = readable(UnitName("player"))
		d.realm = readable(GetRealmName and GetRealmName())
	end
	if dirty.equip then d.equip, d.equipAt = readEquip(), t end
	if dirty.bags then d.bags, d.bagsAt = readBags(), t end
	if dirty.bank and bankOpen then d.bank, d.bankAt = readBank(), t end
	if dirty.money then
		local m = readable(GetMoney())
		if m then d.money, d.moneyAt = m, t end
	end
	dirty = {}
end

local function mark(...)
	for i = 1, select("#", ...) do dirty[select(i, ...)] = true end
	if not pending and inWorld then
		pending = true
		C_Timer.After(COALESCE, write)
	end
end

local f = CreateFrame("Frame")
f:SetScript("OnEvent", function(_, event)
	if event == "PLAYER_ENTERING_WORLD" then
		inWorld = true
		C_Timer.After(LOGIN_DELAY, function() mark("equip", "bags", "money") end)
	elseif event == "PLAYER_LEAVING_WORLD" then
		inWorld = false -- and nothing is read
	elseif event == "PLAYER_EQUIPMENT_CHANGED" then
		mark("equip")
	elseif event == "BAG_UPDATE_DELAYED" then
		if bankOpen then mark("bags", "bank") else mark("bags") end
	elseif event == "PLAYER_MONEY" then
		mark("money")
	elseif event == "BANKFRAME_OPENED" then
		bankOpen = true
		mark("bank", "bags")
	elseif event == "BANKFRAME_CLOSED" then
		bankOpen = false
	elseif event == "PLAYERBANKSLOTS_CHANGED" or event == "PLAYERBANKBAGSLOTS_CHANGED" then
		mark("bank")
	end
end)
for _, e in ipairs({ "PLAYER_ENTERING_WORLD", "PLAYER_LEAVING_WORLD", "PLAYER_EQUIPMENT_CHANGED", "BAG_UPDATE_DELAYED",
	"PLAYER_MONEY", "BANKFRAME_OPENED", "BANKFRAME_CLOSED", "PLAYERBANKSLOTS_CHANGED", "PLAYERBANKBAGSLOTS_CHANGED" }) do
	pcall(f.RegisterEvent, f, e)
end
