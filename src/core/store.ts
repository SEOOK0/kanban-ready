import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type Agent, type Status, canTransition, isAgent, isStatus } from "./paths.js";
import { type Card, makeId } from "./card.js";
import { normalizeDependsOn } from "./meta.js";

interface Row {
  id: string;
  number: number;
  title: string;
  status: string;
  body: string;
  tags: string;
  created: string;
  updated: string;
  depends_on: string;
  session_id: string | null;
  agent: string | null;
}

function parseDependsOn(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function rowToCard(row: Row): Card {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch {}
  const status: Status = isStatus(row.status) ? row.status : "draft";
  const agent: Agent | null = row.agent && isAgent(row.agent) ? row.agent : null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status,
    body: row.body,
    created: row.created,
    updated: row.updated,
    tags,
    depends_on: parseDependsOn(row.depends_on),
    session_id: row.session_id ?? null,
    agent,
  };
}

// ---------------------------------------------------------------------------
// card events (append-only audit log; see docs/multi-agent-design.md §4–§5)
// ---------------------------------------------------------------------------

export const EVENT_ACTIONS = [
  "claim",
  "release",
  "status_change",
  "update",
  "complete",
  "comment",
] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

export interface CardEvent {
  id: number;
  card_id: string;
  at: string;
  agent: Agent | null;
  session_id: string | null;
  action: EventAction;
  from_status: Status | null;
  to_status: Status | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
}

interface EventRow {
  id: number;
  card_id: string;
  at: string;
  agent: string | null;
  session_id: string | null;
  action: string;
  from_status: string | null;
  to_status: string | null;
  summary: string | null;
  metadata: string | null;
}

function rowToEvent(row: EventRow): CardEvent {
  const action: EventAction = (EVENT_ACTIONS as readonly string[]).includes(row.action)
    ? (row.action as EventAction)
    : "comment";
  const agent: Agent | null = row.agent && isAgent(row.agent) ? row.agent : null;
  const from_status: Status | null = row.from_status && isStatus(row.from_status) ? row.from_status : null;
  const to_status: Status | null = row.to_status && isStatus(row.to_status) ? row.to_status : null;
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return {
    id: row.id,
    card_id: row.card_id,
    at: row.at,
    agent,
    session_id: row.session_id,
    action,
    from_status,
    to_status,
    summary: row.summary,
    metadata,
  };
}

/**
 * Pure decision rule for `moveCard` events. Exposed for unit testing.
 *
 *   sameStatus  → "update"          (only meta changed, status stayed)
 *   to=agent_working → "claim"
 *   from=agent_working, to=draft → "release"
 *   to=done → "complete"
 *   else → "status_change"
 *
 * Discard / restore go through "status_change".
 */
export function decideMoveAction(
  from: Status,
  to: Status,
  sameStatus: boolean,
): EventAction {
  if (sameStatus) return "update";
  if (to === "agent_working") return "claim";
  if (from === "agent_working" && to === "draft") return "release";
  if (to === "done") return "complete";
  return "status_change";
}

interface EventDraft {
  at: string;
  agent: Agent | null;
  session_id: string | null;
  action: EventAction;
  from_status: Status | null;
  to_status: Status | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
}

function buildEventInsert(
  db: D1Database,
  cardId: string,
  e: EventDraft,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO card_events (card_id, at, agent, session_id, action, from_status, to_status, summary, metadata) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      cardId,
      e.at,
      e.agent,
      e.session_id,
      e.action,
      e.from_status,
      e.to_status,
      e.summary,
      e.metadata ? JSON.stringify(e.metadata) : null,
    );
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function listCards(db: D1Database, status?: Status): Promise<Card[]> {
  const sql = status
    ? "SELECT * FROM cards WHERE status = ? ORDER BY updated DESC"
    : "SELECT * FROM cards ORDER BY updated DESC";
  const stmt = status ? db.prepare(sql).bind(status) : db.prepare(sql);
  const result = await stmt.all<Row>();
  return (result.results ?? []).map(rowToCard);
}

export async function getCard(db: D1Database, id: string): Promise<Card | null> {
  const row = await db
    .prepare("SELECT * FROM cards WHERE id = ?")
    .bind(id)
    .first<Row>();
  return row ? rowToCard(row) : null;
}

export async function listCardEvents(db: D1Database, cardId: string): Promise<CardEvent[]> {
  const result = await db
    .prepare("SELECT * FROM card_events WHERE card_id = ? ORDER BY at ASC, id ASC")
    .bind(cardId)
    .all<EventRow>();
  return (result.results ?? []).map(rowToEvent);
}

// ---------------------------------------------------------------------------
// createCard
// ---------------------------------------------------------------------------

export interface CreateInput {
  title: string;
  body?: string;
  tags?: string[];
  status?: Status;
  depends_on?: number[];
  session_id?: string | null;
  agent?: Agent | null;
}

export async function createCard(db: D1Database, input: CreateInput): Promise<Card> {
  const status: Status = input.status || "draft";
  const now = new Date();
  const iso = now.toISOString();
  const baseId = makeId(input.title, now);

  let id = baseId;
  let suffix = 2;
  while (true) {
    const existing = await db
      .prepare("SELECT 1 FROM cards WHERE id = ?")
      .bind(id)
      .first();
    if (!existing) break;
    id = `${baseId}-${suffix}`;
    suffix++;
  }

  const tags = input.tags || [];
  const depends_on = normalizeDependsOn(input.depends_on);
  const session_id = input.session_id ?? null;
  const agent: Agent | null = input.agent && isAgent(input.agent) ? input.agent : null;

  // Event: if the card lands directly in agent_working with agent/session, log
  // it as a claim. Otherwise it's a plain status_change from null → status.
  const initialAction: EventAction = status === "agent_working" && (agent || session_id)
    ? "claim"
    : "status_change";

  const batchResults = await db.batch<{ number: number }>([
    db
      .prepare(
        "INSERT INTO cards (id, number, title, status, body, tags, created, updated, depends_on, session_id, agent) " +
          "VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM cards), ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "RETURNING number",
      )
      .bind(
        id,
        input.title,
        status,
        input.body || "",
        JSON.stringify(tags),
        iso,
        iso,
        JSON.stringify(depends_on),
        session_id,
        agent,
      ),
    buildEventInsert(db, id, {
      at: iso,
      agent,
      session_id,
      action: initialAction,
      from_status: null,
      to_status: status,
      summary: `created (${status})`,
      metadata: null,
    }),
  ]);

  const inserted = batchResults[0]?.results?.[0];
  if (!inserted) throw new Error("createCard: insert returned no row");

  return {
    id,
    number: inserted.number,
    title: input.title,
    status,
    body: input.body || "",
    created: iso,
    updated: iso,
    tags,
    depends_on,
    session_id,
    agent,
  };
}

// ---------------------------------------------------------------------------
// updateCard
// ---------------------------------------------------------------------------

export interface UpdateInput {
  body?: string;
  title?: string;
  tags?: string[];
  depends_on?: number[];
  session_id?: string | null;
  agent?: Agent | null;
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`Card not found: ${id}`);
    this.name = "NotFoundError";
  }
}

function diffFields(current: Card, next: Card): string[] {
  const changed: string[] = [];
  if (current.title !== next.title) changed.push("title");
  if (current.body !== next.body) changed.push("body");
  if (JSON.stringify(current.tags) !== JSON.stringify(next.tags)) changed.push("tags");
  if (JSON.stringify(current.depends_on) !== JSON.stringify(next.depends_on)) changed.push("depends_on");
  if (current.session_id !== next.session_id) changed.push("session_id");
  if (current.agent !== next.agent) changed.push("agent");
  return changed;
}

export async function updateCard(
  db: D1Database,
  id: string,
  patch: UpdateInput,
): Promise<Card> {
  const current = await getCard(db, id);
  if (!current) throw new NotFoundError(id);

  const depends_on = patch.depends_on !== undefined ? normalizeDependsOn(patch.depends_on) : current.depends_on;
  const session_id = patch.session_id !== undefined ? patch.session_id : current.session_id;
  let agent: Agent | null = current.agent;
  if (patch.agent !== undefined) {
    agent = patch.agent === null ? null : isAgent(patch.agent) ? patch.agent : current.agent;
  }

  const next: Card = {
    ...current,
    body: patch.body ?? current.body,
    title: patch.title ?? current.title,
    tags: patch.tags ?? current.tags,
    depends_on,
    session_id,
    agent,
    updated: new Date().toISOString(),
  };

  const changed = diffFields(current, next);
  if (changed.length === 0) {
    // No-op patch — keep idempotent behaviour and skip writes.
    return current;
  }

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE cards SET title = ?, body = ?, tags = ?, depends_on = ?, session_id = ?, agent = ?, updated = ? WHERE id = ?",
      )
      .bind(
        next.title,
        next.body,
        JSON.stringify(next.tags),
        JSON.stringify(next.depends_on),
        next.session_id,
        next.agent,
        next.updated,
        id,
      ),
    buildEventInsert(db, id, {
      at: next.updated,
      agent: next.agent,
      session_id: next.session_id,
      action: "update",
      from_status: current.status,
      to_status: next.status,
      summary: `updated: ${changed.join(", ")}`,
      metadata: { changed },
    }),
  ];

  await db.batch(stmts);
  return next;
}

// ---------------------------------------------------------------------------
// moveCard
// ---------------------------------------------------------------------------

export class TransitionError extends Error {
  constructor(public from: Status, public to: Status) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

export class SpecRequiredError extends Error {
  constructor() {
    super("Insufficient spec: moving to ready requires a non-empty body. Use update_card to add spec/task first.");
    this.name = "SpecRequiredError";
  }
}

export interface MoveMeta {
  depends_on?: number[];
  session_id?: string | null;
  agent?: Agent | null;
}

export async function moveCard(
  db: D1Database,
  id: string,
  target: Status,
  meta: MoveMeta = {},
): Promise<Card> {
  if (!isStatus(target)) throw new Error(`Invalid status: ${target}`);
  const current = await getCard(db, id);
  if (!current) throw new NotFoundError(id);
  const hasMeta = meta.depends_on !== undefined || meta.session_id !== undefined || meta.agent !== undefined;
  if (current.status === target && !hasMeta) return current;
  if (current.status !== target && !canTransition(current.status, target)) {
    throw new TransitionError(current.status, target);
  }
  if (target === "ready" && !current.body.trim()) {
    throw new SpecRequiredError();
  }

  const depends_on = meta.depends_on !== undefined ? normalizeDependsOn(meta.depends_on) : current.depends_on;
  const session_id = meta.session_id !== undefined ? meta.session_id : current.session_id;
  let agent: Agent | null = current.agent;
  if (meta.agent !== undefined) {
    agent = meta.agent === null ? null : isAgent(meta.agent) ? meta.agent : current.agent;
  }

  const updated = new Date().toISOString();
  const sameStatus = current.status === target;
  const action = decideMoveAction(current.status, target, sameStatus);

  const summary = sameStatus
    ? "meta updated"
    : `${current.status} → ${target}`;

  await db.batch([
    db
      .prepare(
        "UPDATE cards SET status = ?, depends_on = ?, session_id = ?, agent = ?, updated = ? WHERE id = ?",
      )
      .bind(target, JSON.stringify(depends_on), session_id, agent, updated, id),
    buildEventInsert(db, id, {
      at: updated,
      agent,
      session_id,
      action,
      from_status: current.status,
      to_status: target,
      summary,
      metadata: null,
    }),
  ]);

  return { ...current, status: target, depends_on, session_id, agent, updated };
}

// ---------------------------------------------------------------------------
// deleteCard
// (card_events.card_id has ON DELETE CASCADE, so no extra cleanup needed.)
// ---------------------------------------------------------------------------

export async function deleteCard(db: D1Database, id: string): Promise<void> {
  const result = await db
    .prepare("DELETE FROM cards WHERE id = ?")
    .bind(id)
    .run();
  const meta = result.meta as { changes?: number } | undefined;
  if (!meta || meta.changes === 0) {
    throw new NotFoundError(id);
  }
}
