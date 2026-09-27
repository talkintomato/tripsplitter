-- Agent state is private working state; none of these tables writes activity.
CREATE TABLE agent_proposal (
  id TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES chat_group(id),
  member_id INTEGER NOT NULL REFERENCES member(id),
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  actions TEXT NOT NULL CHECK(json_valid(actions)),
  summary TEXT NOT NULL,
  versions TEXT NOT NULL CHECK(json_valid(versions)),
  status TEXT NOT NULL CHECK(status IN ('pending','done','cancelled','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX agent_proposal_owner ON agent_proposal(member_id, chat_id, status);
CREATE TABLE agent_turn (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES chat_group(id),
  member_id INTEGER NOT NULL REFERENCES member(id),
  chat_id INTEGER NOT NULL,
  -- chosen_group stores only a selection, never conversation text; it does not expire.
  role TEXT NOT NULL CHECK(role IN ('user','assistant','chosen_group')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_turn_conversation ON agent_turn(member_id, chat_id, id);
CREATE TABLE agent_usage (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES chat_group(id),
  day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_usage_group_day ON agent_usage(group_id, day);
CREATE INDEX agent_usage_day ON agent_usage(day);
