CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL DEFAULT 'niao' CHECK (author_id = 'niao'),
  journal_date TEXT UNIQUE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT CHECK (length(description) <= 1000),
  body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 50000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  idempotency_key TEXT UNIQUE,
  creation_hash TEXT NOT NULL,
  CHECK ((status = 'draft' AND published_at IS NULL) OR
         (status = 'published' AND published_at IS NOT NULL))
);
CREATE INDEX articles_publication ON articles(status, published_at DESC, id DESC);
CREATE TABLE article_sources (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('url','observation','message')),
  source_ref TEXT NOT NULL,
  title TEXT,
  url TEXT,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  CHECK (is_public = 0 OR (source_type = 'url' AND url IS NOT NULL)),
  PRIMARY KEY(article_id, position)
);
CREATE TRIGGER published_articles_immutable BEFORE UPDATE ON articles
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published_article_immutable'); END;
CREATE TRIGGER published_articles_no_delete BEFORE DELETE ON articles
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published_article_immutable'); END;
CREATE TRIGGER article_identity_immutable BEFORE UPDATE ON articles
WHEN OLD.id != NEW.id OR OLD.slug != NEW.slug OR OLD.author_id != NEW.author_id
  OR OLD.journal_date IS NOT NEW.journal_date
BEGIN SELECT RAISE(ABORT, 'article_identity_immutable'); END;
CREATE TRIGGER published_sources_no_insert BEFORE INSERT ON article_sources
WHEN (SELECT status FROM articles WHERE id = NEW.article_id) = 'published'
BEGIN SELECT RAISE(ABORT, 'published_article_immutable'); END;
CREATE TRIGGER published_sources_no_update BEFORE UPDATE ON article_sources
WHEN (SELECT status FROM articles WHERE id = OLD.article_id) = 'published'
  OR (SELECT status FROM articles WHERE id = NEW.article_id) = 'published'
BEGIN SELECT RAISE(ABORT, 'published_article_immutable'); END;
CREATE TRIGGER published_sources_no_delete BEFORE DELETE ON article_sources
WHEN (SELECT status FROM articles WHERE id = OLD.article_id) = 'published'
BEGIN SELECT RAISE(ABORT, 'published_article_immutable'); END;
