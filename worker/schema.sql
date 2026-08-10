CREATE TABLE users (
  github_id  INTEGER PRIMARY KEY,
  login      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chats (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(github_id),
  title      TEXT,
  messages   TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chats_user ON chats(user_id, updated_at DESC);
