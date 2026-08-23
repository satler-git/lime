PRAGMA foreign_keys = ON;

CREATE TABLE cards (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  word TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  due INTEGER NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL,
  scheduled_days REAL NOT NULL,
  learning_steps INTEGER NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('new', 'learning', 'review', 'relearning')),
  last_review INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX cards_user_due_idx ON cards(user_id, due);
CREATE INDEX cards_user_updated_idx ON cards(user_id, updated_at);

CREATE TABLE review_actions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('again', 'hard', 'good', 'easy')),
  timestamp INTEGER NOT NULL,
  previous_state_json TEXT NOT NULL CHECK (json_valid(previous_state_json)),
  next_state_json TEXT NOT NULL CHECK (json_valid(next_state_json)),
  undone INTEGER NOT NULL CHECK (undone IN (0, 1)),
  undone_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX review_actions_user_session_card_idx ON review_actions(user_id, session_id, card_id, timestamp);
CREATE INDEX review_actions_user_updated_idx ON review_actions(user_id, updated_at);

CREATE TABLE reading_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'reading', 'quiz', 'completed', 'abandoned')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  quiz_started_at INTEGER,
  completed_at INTEGER,
  abandoned_at INTEGER,
  card_ids_json TEXT NOT NULL CHECK (json_valid(card_ids_json)),
  lookup_events_json TEXT NOT NULL CHECK (json_valid(lookup_events_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX reading_sessions_user_created_idx ON reading_sessions(user_id, created_at);
CREATE INDEX reading_sessions_user_updated_idx ON reading_sessions(user_id, updated_at);
