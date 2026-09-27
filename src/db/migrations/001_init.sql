-- TripSplitter schema.
-- Amounts are whole numbers of minor units. Timestamps are ISO 8601 text in UTC.
-- The `currency` table is filled from src/core/currencies.ts each time the database is opened.

CREATE TABLE currency (
  code     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  decimals INTEGER NOT NULL CHECK (decimals >= 0)
);

-- One Telegram chat. Named chat_group because GROUP is a reserved word in SQL.
CREATE TABLE chat_group (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          INTEGER NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  intro_message_id INTEGER,
  -- Links into the Mini App carry this number. Resetting the link adds 1, which stops older links.
  link_version     INTEGER NOT NULL DEFAULT 1 CHECK (link_version >= 1),
  created_at       TEXT NOT NULL
);

-- Earlier chat IDs of a group that Telegram upgraded to a supergroup.
CREATE TABLE chat_alias (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES chat_group (id),
  chat_id  INTEGER NOT NULL UNIQUE
);
CREATE INDEX chat_alias_group ON chat_alias (group_id);

CREATE TABLE member (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id              INTEGER NOT NULL REFERENCES chat_group (id),
  -- Null for a member added by hand.
  telegram_user_id      INTEGER,
  display_name          TEXT NOT NULL CHECK (length(display_name) > 0),
  username              TEXT,
  -- 1: included in new splits by default. 0 after the member left the chat. Has no effect on access.
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- chat: seen in the Telegram chat. link: joined by opening the group's link. manual: added by hand.
  joined_via            TEXT NOT NULL CHECK (joined_via IN ('chat', 'link', 'manual')),
  -- Set when this member was absorbed by a claim. Such a member is hidden and cannot be used.
  merged_into           INTEGER REFERENCES member (id),
  created_at            TEXT NOT NULL,
  CHECK (merged_into IS NULL OR active = 0),
  CHECK ((joined_via = 'manual') = (telegram_user_id IS NULL))
);
CREATE UNIQUE INDEX member_group_telegram_user ON member (group_id, telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;
CREATE INDEX member_group ON member (group_id);

CREATE TABLE trip (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id             INTEGER NOT NULL REFERENCES chat_group (id),
  name                 TEXT NOT NULL CHECK (length(name) > 0),
  home_currency        TEXT NOT NULL REFERENCES currency (code),
  -- Set by the first confirmed expense or settlement and never set back.
  home_currency_locked INTEGER NOT NULL DEFAULT 0 CHECK (home_currency_locked IN (0, 1)),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  setup_done           INTEGER NOT NULL DEFAULT 0 CHECK (setup_done IN (0, 1)),
  created_at           TEXT NOT NULL,
  ended_at             TEXT
);
CREATE UNIQUE INDEX trip_one_active_per_group ON trip (group_id) WHERE status = 'active';
CREATE INDEX trip_group ON trip (group_id);

-- A rate the group has set for the whole trip: units of `currency` per 1 unit of the home currency.
CREATE TABLE trip_fx_rate (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trip (id),
  currency   TEXT NOT NULL REFERENCES currency (code),
  rate       TEXT NOT NULL CHECK (CAST(rate AS REAL) > 0),
  -- suggested: filled in from a rate service and not yet touched by a member. member: set by a member.
  origin     TEXT NOT NULL CHECK (origin IN ('suggested', 'member')),
  -- Null when set with the system actor.
  set_by     INTEGER REFERENCES member (id),
  updated_at TEXT NOT NULL,
  UNIQUE (trip_id, currency)
);

CREATE TABLE expense (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id               INTEGER NOT NULL REFERENCES trip (id),
  created_by            INTEGER NOT NULL REFERENCES member (id),
  payer_id              INTEGER NOT NULL REFERENCES member (id),
  description           TEXT NOT NULL DEFAULT '',
  merchant              TEXT,
  expense_date          TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  total                 INTEGER NOT NULL CHECK (typeof(total) = 'integer' AND total >= 0),
  tax                   INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tax) = 'integer' AND tax >= 0),
  -- 1 when the item prices already include the tax. Set by the receipt reader or a member, never guessed.
  tax_included          INTEGER NOT NULL DEFAULT 0 CHECK (tax_included IN (0, 1)),
  tip                   INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tip) = 'integer' AND tip >= 0),
  service_charge        INTEGER NOT NULL DEFAULT 0 CHECK (typeof(service_charge) = 'integer' AND service_charge >= 0),
  discount              INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount) = 'integer' AND discount >= 0),
  currency              TEXT NOT NULL REFERENCES currency (code),
  -- 1 when the currency was guessed and a member must check it before the expense can be confirmed.
  currency_needs_review INTEGER NOT NULL DEFAULT 0 CHECK (currency_needs_review IN (0, 1)),
  -- Decimal as text, exactly as entered: units of `currency` equal to 1 unit of the trip's home currency
  -- ("112.4" for 1 SGD = 112.4 JPY). Converting to home currency divides by it. Null only when missing.
  fx_rate               TEXT CHECK (fx_rate IS NULL OR CAST(fx_rate AS REAL) > 0),
  fx_rate_source        TEXT NOT NULL CHECK (fx_rate_source IN ('home', 'expense', 'trip', 'missing')),
  split_type            TEXT NOT NULL CHECK (split_type IN ('even', 'portions', 'items')),
  receipt_file_id       TEXT,
  status                TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'discarded', 'deleted')),
  -- The status a discarded or deleted expense had, which restoring returns it to.
  status_before_removal TEXT CHECK (status_before_removal IN ('draft', 'confirmed')),
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK ((fx_rate_source = 'missing') = (fx_rate IS NULL)),
  CHECK (fx_rate_source <> 'home' OR fx_rate = '1'),
  CHECK (NOT (status = 'confirmed' AND (fx_rate_source = 'missing' OR currency_needs_review = 1))),
  CHECK ((status = 'discarded' AND status_before_removal = 'draft')
      OR (status = 'deleted' AND status_before_removal = 'confirmed')
      OR (status IN ('draft', 'confirmed') AND status_before_removal IS NULL))
);
CREATE INDEX expense_trip_status ON expense (trip_id, status);
CREATE INDEX expense_trip_currency ON expense (trip_id, currency);

CREATE TABLE expense_item (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER NOT NULL REFERENCES expense (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  -- Descriptive only. Never multiplied into the amount.
  quantity   REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Line total: "Beer x2 16.00" has amount 1600.
  amount     INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= 0),
  position   INTEGER NOT NULL
);
CREATE INDEX expense_item_expense ON expense_item (expense_id, position);

CREATE TABLE share (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL REFERENCES member (id),
  weight     INTEGER NOT NULL DEFAULT 1 CHECK (typeof(weight) = 'integer' AND weight > 0),
  expense_id INTEGER REFERENCES expense (id) ON DELETE CASCADE,
  item_id    INTEGER REFERENCES expense_item (id) ON DELETE CASCADE,
  CHECK ((expense_id IS NULL) <> (item_id IS NULL))
);
CREATE UNIQUE INDEX share_expense_member ON share (expense_id, member_id) WHERE expense_id IS NOT NULL;
CREATE UNIQUE INDEX share_item_member ON share (item_id, member_id) WHERE item_id IS NOT NULL;
CREATE INDEX share_member ON share (member_id);

CREATE TABLE settlement (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id        INTEGER NOT NULL REFERENCES trip (id),
  created_by     INTEGER NOT NULL REFERENCES member (id),
  from_member_id INTEGER NOT NULL REFERENCES member (id),
  to_member_id   INTEGER NOT NULL REFERENCES member (id),
  -- Home currency of the trip, minor units.
  amount         INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'undone')),
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  -- After a claim a settlement can be from a member to themselves. It is then undone and stays so.
  CHECK (status = 'undone' OR from_member_id <> to_member_id)
);
CREATE INDEX settlement_trip_status ON settlement (trip_id, status);

CREATE TABLE activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES chat_group (id),
  trip_id     INTEGER REFERENCES trip (id),
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('member', 'system')),
  actor_id    INTEGER REFERENCES member (id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  "before"    TEXT,
  "after"     TEXT,
  created_at  TEXT NOT NULL,
  CHECK ((actor_kind = 'system') = (actor_id IS NULL))
);
CREATE INDEX activity_group ON activity (group_id, id);
CREATE INDEX activity_entity ON activity (entity_type, entity_id, id);

-- Activity entries cannot be changed or removed.
CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity
BEGIN
  SELECT RAISE(ABORT, 'activity entries cannot be changed');
END;
CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity
BEGIN
  SELECT RAISE(ABORT, 'activity entries cannot be removed');
END;

-- One row per call to the receipt model, counted against the daily cap.
CREATE TABLE receipt_read (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES chat_group (id),
  -- Singapore date, YYYY-MM-DD.
  day        TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL
);
CREATE INDEX receipt_read_group_day ON receipt_read (group_id, day);
