import type { D1Database } from "@cloudflare/workers-types";
import { type Agent, type Status, canTransition, isAgent, isStatus } from "./paths.js";
import { type Card, makeId } from "./card.js";

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

export interface CreateInput {
  title: string;
  body?: string;
  tags?: string[];
  status?: Status;
  depends_on?: number[];
  session_id?: string | null;
  agent?: Agent | null;
}

function normalizeDependsOn(input: number[] | undefined): number[] {
  if (!input) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of input) {
    if (!Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
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
  const inserted = await db
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
    )
    .first<{ number: number }>();
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

  await db
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
    )
    .run();

  return next;
}

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
  await db
    .prepare(
      "UPDATE cards SET status = ?, depends_on = ?, session_id = ?, agent = ?, updated = ? WHERE id = ?",
    )
    .bind(target, JSON.stringify(depends_on), session_id, agent, updated, id)
    .run();

  return { ...current, status: target, depends_on, session_id, agent, updated };
}

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
