CREATE TABLE expense_photo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES chat_group(id),
  expense_id INTEGER NOT NULL REFERENCES expense(id),
  file_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 1600),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 1600),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  added_by_member_id INTEGER NOT NULL REFERENCES member(id),
  created_at TEXT NOT NULL
);
CREATE INDEX expense_photo_expense ON expense_photo(group_id, expense_id, id);
CREATE TRIGGER expense_photo_group BEFORE INSERT ON expense_photo
WHEN NOT EXISTS (
  SELECT 1 FROM expense e JOIN trip t ON t.id = e.trip_id
  WHERE e.id = NEW.expense_id AND t.group_id = NEW.group_id
) OR NOT EXISTS (
  SELECT 1 FROM member WHERE id = NEW.added_by_member_id AND group_id = NEW.group_id
)
BEGIN
  SELECT RAISE(ABORT, 'photo expense and member must belong to group');
END;
