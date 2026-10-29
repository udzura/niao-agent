ALTER TABLE documents ADD COLUMN semantic_revision TEXT NOT NULL DEFAULT '';

-- Latest desired state, atomically queued alongside every document mutation.
-- Preserve an active lease when another import changes the desired revision.
CREATE TABLE semantic_jobs (
  document_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'submitted')),
  index_version TEXT NOT NULL DEFAULT '',
  next_chunk INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  cleanup_after TEXT NOT NULL DEFAULT '',
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  mutation_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX semantic_jobs_status ON semantic_jobs(status, document_id);
-- IDs/offsets remain as reconciliation records, including retired revisions.
-- No old body text or embedding values are stored here.
CREATE TABLE semantic_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  index_version TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL
);
CREATE INDEX semantic_chunks_document ON semantic_chunks(document_id, revision, index_version);

-- Revision-only updates must not rewrite an unchanged FTS index.
DROP TRIGGER documents_update;
CREATE TRIGGER documents_update AFTER UPDATE OF search_title, search_body ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, search_title, search_body)
    VALUES ('delete', old.rowid, old.search_title, old.search_body);
  INSERT INTO documents_fts(rowid, search_title, search_body)
    VALUES (new.rowid, new.search_title, new.search_body);
END;
UPDATE documents SET semantic_revision = lower(hex(randomblob(16)));

CREATE TRIGGER semantic_insert AFTER INSERT ON documents BEGIN
  UPDATE documents SET semantic_revision = lower(hex(randomblob(16))) WHERE rowid = new.rowid;
  INSERT INTO semantic_jobs(document_id, revision, operation)
    SELECT id, semantic_revision, 'upsert' FROM documents WHERE rowid = new.rowid
    ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision, operation='upsert',
      status='pending', next_chunk=0, chunk_count=0, cleanup_after='', last_error=NULL, mutation_id=NULL,
      updated_at=excluded.updated_at;
END;
CREATE TRIGGER semantic_update AFTER UPDATE OF title, body ON documents
WHEN old.title IS NOT new.title OR old.body IS NOT new.body BEGIN
  UPDATE documents SET semantic_revision = lower(hex(randomblob(16))) WHERE rowid = new.rowid;
  INSERT INTO semantic_jobs(document_id, revision, operation)
    SELECT id, semantic_revision, 'upsert' FROM documents WHERE rowid = new.rowid
    ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision, operation='upsert',
      status='pending', next_chunk=0, chunk_count=0, cleanup_after='', last_error=NULL, mutation_id=NULL,
      updated_at=excluded.updated_at;
END;
CREATE TRIGGER semantic_delete AFTER DELETE ON documents BEGIN
  INSERT INTO semantic_jobs(document_id, revision, operation) VALUES (old.id, lower(hex(randomblob(16))), 'delete')
    ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision, operation='delete',
      status='pending', next_chunk=0, chunk_count=0, cleanup_after='', last_error=NULL, mutation_id=NULL,
      updated_at=excluded.updated_at;
END;

-- Existing archives become pending without needing a source re-import.
INSERT INTO semantic_jobs(document_id, revision, operation)
  SELECT id, semantic_revision, 'upsert' FROM documents;
