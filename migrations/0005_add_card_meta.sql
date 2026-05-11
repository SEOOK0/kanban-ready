-- Add agent dispatch metadata to cards:
--   depends_on  JSON array of card numbers this card depends on (default '[]')
--   session_id  agent session id, filled when MCP start_agent_work runs
--   agent       which agent ran ('cc' | 'codex'), null until first dispatch
-- SQLite cannot ALTER a CHECK constraint, so we rebuild the table the same way
-- 0004_add_agent_working.sql did.

CREATE TABLE cards_new (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'agent_working', 'ready', 'done', 'deploy', 'discarded')),
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  agent TEXT CHECK (agent IS NULL OR agent IN ('cc', 'codex'))
);

INSERT INTO cards_new (id, number, title, status, body, tags, created, updated, depends_on, session_id, agent)
  SELECT id, number, title, status, body, tags, created, updated, '[]', NULL, NULL FROM cards;

DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards(updated);
CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(number);
