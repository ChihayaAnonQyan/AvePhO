CREATE TABLE committee_roster (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  draft TEXT,
  published_revision INTEGER,
  published TEXT
);

INSERT INTO committee_roster (id) VALUES (1);
