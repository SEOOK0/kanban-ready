-- Extend status enum: add 'deploy' and 'discarded'.
-- SQLite cannot ALTER a CHECK constraint; rebuild the table.

CREATE TABLE cards_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'done', 'deploy', 'discarded')),
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

INSERT INTO cards_new (id, title, status, body, tags, created, updated)
  SELECT id, title, status, body, tags, created, updated FROM cards;

DROP TABLE cards;

ALTER TABLE cards_new RENAME TO cards;

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards(updated);
