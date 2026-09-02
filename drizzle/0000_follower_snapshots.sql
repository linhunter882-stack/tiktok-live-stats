CREATE TABLE IF NOT EXISTS follower_snapshots (
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  follower_count INTEGER NOT NULL CHECK (follower_count >= 0),
  PRIMARY KEY (username, observed_at)
);

CREATE INDEX IF NOT EXISTS follower_snapshots_account_time
  ON follower_snapshots (username, observed_at);
