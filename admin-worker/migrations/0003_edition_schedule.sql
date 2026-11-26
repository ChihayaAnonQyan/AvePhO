CREATE TABLE edition_schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draft TEXT NOT NULL,
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  published TEXT,
  published_revision INTEGER,
  release_id TEXT,
  state TEXT CHECK (state IN ('pending', 'live')),
  run_url TEXT
);

INSERT INTO edition_schedule (id, draft)
VALUES (1, '{"number":1,"year":2026,"events":[]}');
