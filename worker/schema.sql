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

-- Created on first use by worker/src/userconfig.js as well; kept here so a
-- rebuild from this file gets it. The key is AES-GCM ciphertext, never plaintext.
CREATE TABLE user_llm_config (
  user_id        INTEGER PRIMARY KEY REFERENCES users(github_id),
  base_url       TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv         TEXT NOT NULL,
  key_last4      TEXT NOT NULL,
  model          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
