-- An emoji a person chose for an expense, shown as its picture in lists. Null: a picture is picked from its words.
ALTER TABLE expense ADD COLUMN emoji TEXT;
