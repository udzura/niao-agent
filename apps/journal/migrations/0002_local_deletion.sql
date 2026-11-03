-- Only the local operator CLI writes deletion receipts; there is no HTTP/MCP adapter.
CREATE TABLE journal_deletions (
  article_id TEXT PRIMARY KEY,
  expected_updated_at TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE TABLE journal_publication_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 1)
);
INSERT INTO journal_publication_state VALUES (1, 1);

DROP TRIGGER published_articles_no_delete;
CREATE TRIGGER published_articles_no_delete BEFORE DELETE ON articles
WHEN OLD.status = 'published' AND NOT EXISTS (
  SELECT 1 FROM journal_deletions WHERE article_id = OLD.id AND expected_updated_at = OLD.updated_at
)
BEGIN SELECT RAISE(ABORT, 'published_article_immutable'); END;

-- Receipt, revision check, cascaded source deletion and cache generation commit together.
CREATE TRIGGER journal_delete_article AFTER INSERT ON journal_deletions
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM articles WHERE id = NEW.article_id AND updated_at = NEW.expected_updated_at
  ) THEN 1 ELSE RAISE(ABORT, 'article_changed_or_missing') END;
  DELETE FROM articles WHERE id = NEW.article_id AND updated_at = NEW.expected_updated_at;
END;
CREATE TRIGGER journal_deleted_publication AFTER DELETE ON articles
WHEN OLD.status = 'published'
BEGIN UPDATE journal_publication_state SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER journal_new_publication AFTER UPDATE OF status ON articles
WHEN OLD.status = 'draft' AND NEW.status = 'published'
BEGIN UPDATE journal_publication_state SET generation = generation + 1 WHERE id = 1; END;
