import type { D1Database } from "@cloudflare/workers-types";
import { type Status, canTransition, isStatus } from "./paths.js";
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
}

function rowToCard(row: Row): Card {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch {}
  const status: Status = isStatus(row.status) ? row.status : "draft";
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status,
    body: row.body,
    created: row.created,
    updated: row.updated,
    tags,
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
  const inserted = await db
    .prepare(
      "INSERT INTO cards (id, number, title, status, body, tags, created, updated) " +
        "VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM cards), ?, ?, ?, ?, ?, ?) " +
        "RETURNING number",
    )
    .bind(id, input.title, status, input.body || "", JSON.stringify(tags), iso, iso)
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
  };
}

export interface UpdateInput {
  body?: string;
  title?: string;
  tags?: string[];
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

  const next: Card = {
    ...current,
    body: patch.body ?? current.body,
    title: patch.title ?? current.title,
    tags: patch.tags ?? current.tags,
    updated: new Date().toISOString(),
  };

  await db
    .prepare(
      "UPDATE cards SET title = ?, body = ?, tags = ?, updated = ? WHERE id = ?",
    )
    .bind(next.title, next.body, JSON.stringify(next.tags), next.updated, id)
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
    super("Insufficient spec: draft → ready requires a non-empty body. Use update_card to add spec/task first.");
    this.name = "SpecRequiredError";
  }
}

export async function moveCard(
  db: D1Database,
  id: string,
  target: Status,
): Promise<Card> {
  if (!isStatus(target)) throw new Error(`Invalid status: ${target}`);
  const current = await getCard(db, id);
  if (!current) throw new NotFoundError(id);
  if (current.status === target) return current;
  if (!canTransition(current.status, target)) {
    throw new TransitionError(current.status, target);
  }
  if (current.status === "draft" && target === "ready" && !current.body.trim()) {
    throw new SpecRequiredError();
  }

  const updated = new Date().toISOString();
  await db
    .prepare("UPDATE cards SET status = ?, updated = ? WHERE id = ?")
    .bind(target, updated, id)
    .run();

  return { ...current, status: target, updated };
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
