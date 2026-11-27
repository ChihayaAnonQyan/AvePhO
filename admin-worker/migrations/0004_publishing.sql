ALTER TABLE announcements ADD COLUMN format TEXT NOT NULL DEFAULT 'plain';

CREATE TABLE editorial_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('edition', 'article')),
  edition_number INTEGER UNIQUE,
  revision INTEGER NOT NULL,
  draft TEXT NOT NULL,
  published TEXT,
  published_revision INTEGER,
  published_at TEXT
);
CREATE INDEX editorial_published ON editorial_items(kind, published_at) WHERE published IS NOT NULL;

CREATE TABLE editorial_assets (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE editorial_chunks (
  asset TEXT NOT NULL REFERENCES editorial_assets(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (asset, part)
);

CREATE TABLE editorial_public_files (
  item TEXT NOT NULL REFERENCES editorial_items(id) ON DELETE CASCADE,
  file TEXT NOT NULL REFERENCES editorial_assets(id),
  opens_at INTEGER NOT NULL,
  PRIMARY KEY (item, file),
  UNIQUE (file)
);
CREATE INDEX editorial_files_open ON editorial_public_files(file, opens_at);
