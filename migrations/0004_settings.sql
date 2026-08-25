PRAGMA foreign_keys = ON;
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_limit INTEGER NOT NULL,
  new_limit INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
