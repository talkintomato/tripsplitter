-- Defaults are implicit: group on, personal off.
CREATE TABLE notification_setting (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES chat_group(id),
  member_id INTEGER REFERENCES member(id),
  kind TEXT NOT NULL CHECK (kind IN ('group', 'personal')),
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'group' AND member_id IS NULL AND enabled = 0 AND type IN
    ('expense_added','expense_changed','expense_removed','payment','exchange_rate','trip','member_joined')) OR
    (kind = 'personal' AND member_id IS NOT NULL AND enabled = 1 AND type IN
    ('added_me','changed_mine','payments_me','exchange_rate','draft_waiting')))
);
CREATE UNIQUE INDEX notification_setting_group ON notification_setting(group_id, kind, type) WHERE member_id IS NULL;
CREATE UNIQUE INDEX notification_setting_personal ON notification_setting(group_id, member_id, kind, type) WHERE member_id IS NOT NULL;
CREATE TRIGGER notification_setting_member BEFORE INSERT ON notification_setting
WHEN NEW.member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM member WHERE id = NEW.member_id AND group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'notification member must belong to group');
END;
