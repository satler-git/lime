PRAGMA foreign_keys = ON;

CREATE TABLE telemetry_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('cycle_start', 'cycle_end', 'scroll_pos', 'scroll_backward', 'word_lookup', 'rating', 'quiz_answer')),
  occurred_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, client_event_id)
);

CREATE INDEX telemetry_events_user_session_time_idx ON telemetry_events(user_id, session_id, occurred_at);
CREATE INDEX telemetry_events_user_cycle_time_idx ON telemetry_events(user_id, cycle_id, occurred_at);
CREATE INDEX telemetry_events_user_type_time_idx ON telemetry_events(user_id, event_type, occurred_at);
