CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  github_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'live')),
  announcement_id TEXT NOT NULL REFERENCES announcements(id),
  action TEXT NOT NULL CHECK (action IN ('publish', 'withdraw')),
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  run_url TEXT
);
CREATE UNIQUE INDEX one_pending_release ON releases(state) WHERE state = 'pending';
CREATE INDEX live_releases ON releases(state);
