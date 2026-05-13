-- Append-only event log for cards: every mutation (create / update / move /
-- delete) writes one row here in the same D1 batch as the cards-table change.
-- Per docs/multi-agent-design.md §4–§5 (Tier 2): the cards row keeps the
-- "current owner" cache; the truth of "who did what when" lives here.
--
-- ON DELETE CASCADE means deleteCard() does not need a separate events delete.

CREATE TABLE card_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,                -- ISO timestamp
  agent       TEXT,                          -- 'cc' | 'codex' | null
  session_id  TEXT,
  action      TEXT NOT NULL CHECK (action IN
                ('claim','release','status_change','update','complete','comment')),
  from_status TEXT,                          -- for status_change / claim / release / complete
  to_status   TEXT,                          -- for status_change / claim / release / complete
  summary     TEXT,                          -- short human-readable description
  metadata    TEXT                           -- JSON, action-specific extras
);

CREATE INDEX idx_events_card    ON card_events(card_id, at DESC);
CREATE INDEX idx_events_session ON card_events(session_id);
CREATE INDEX idx_events_agent   ON card_events(agent);
