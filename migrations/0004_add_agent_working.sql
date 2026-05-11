-- Extend status enum: add 'agent_working' between 'draft' and 'ready'.
-- SQLite cannot ALTER a CHECK constraint; rebuild the table.

CREATE TABLE cards_new (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'agent_working', 'ready', 'done', 'deploy', 'discarded')),
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

INSERT INTO cards_new (id, number, title, status, body, tags, created, updated)
  SELECT id, number, title, status, body, tags, created, updated FROM cards;

DROP TABLE cards;

ALTER TABLE cards_new RENAME TO cards;

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards(updated);
CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(number);
