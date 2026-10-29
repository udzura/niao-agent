CREATE TABLE documents (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('cosense', 'hatena', 'manual')),
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  indexed_at TEXT NOT NULL,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  search_title TEXT NOT NULL,
  search_body TEXT NOT NULL,
  UNIQUE(source, source_id)
);
CREATE INDEX documents_source_date ON documents(source, created_at DESC);
CREATE INDEX documents_indexed_at ON documents(indexed_at);

-- Application-generated ASCII tokens: CJK bigrams/unigrams and Latin words.
-- No custom SQLite extension or tokenizer is required by D1.
CREATE VIRTUAL TABLE documents_fts USING fts5(
  search_title, search_body, content='documents', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER documents_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, search_title, search_body)
    VALUES (new.rowid, new.search_title, new.search_body);
END;
CREATE TRIGGER documents_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, search_title, search_body)
    VALUES ('delete', old.rowid, old.search_title, old.search_body);
END;
CREATE TRIGGER documents_update AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, search_title, search_body)
    VALUES ('delete', old.rowid, old.search_title, old.search_body);
  INSERT INTO documents_fts(rowid, search_title, search_body)
    VALUES (new.rowid, new.search_title, new.search_body);
END;
