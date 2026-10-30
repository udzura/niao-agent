CREATE TABLE cosense_discovery (
  project TEXT NOT NULL, page_url TEXT NOT NULL, version TEXT NOT NULL,
  acknowledged_version TEXT, sent_version TEXT, queued_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project,page_url)
);
CREATE TABLE cosense_pages (
  project TEXT NOT NULL, page_id TEXT NOT NULL, document_id TEXT,
  content_hash TEXT, source_updated INTEGER, last_success TEXT, last_error TEXT,
  lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project,page_id)
);
CREATE TABLE cosense_poll (
  project TEXT PRIMARY KEY, last_success TEXT, last_error TEXT,
  entries INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cosense_backfill (
  project TEXT PRIMARY KEY, next_skip INTEGER NOT NULL DEFAULT 0,
  total INTEGER, updated_at TEXT
);
