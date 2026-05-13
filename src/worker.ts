import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { type Status, isStatus } from "./core/paths.js";
import {
  createCard,
  deleteCard,
  getCard,
  listCardEvents,
  listCards,
  moveCard,
  type MoveMeta,
  NotFoundError,
  SpecRequiredError,
  TransitionError,
  updateCard,
} from "./core/store.js";
import { buildPrompt } from "./core/prompt.js";
import {
  InputValidationError,
  normalizeAgentInput,
  normalizeDependsOnInput,
  normalizeSessionIdInput,
} from "./core/meta.js";

type Bindings = {
  DB: D1Database;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  ALLOWED_IPS?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => {
  const raw = c.env.ALLOWED_IPS;
  if (!raw) return next();
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return next();
  const ip = c.req.header("cf-connecting-ip") || "";
  if (!allowed.includes(ip)) {
    return c.text("Forbidden", 403);
  }
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/whoami", (c) =>
  c.json({ ip: c.req.header("cf-connecting-ip") || null }),
);

app.get("/api/cards", async (c) => {
  const status = c.req.query("status");
  if (status && !isStatus(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const cards = await listCards(c.env.DB, status as Status | undefined);
  return c.json({ cards });
});

app.get("/api/cards/:id", async (c) => {
  const card = await getCard(c.env.DB, c.req.param("id"));
  if (!card) return c.json({ error: "not found" }, 404);
  return c.json({ card });
});

app.post("/api/cards", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    tags?: string[];
    status?: string;
    depends_on?: unknown;
    session_id?: unknown;
    agent?: unknown;
  };
  if (!body.title || !body.title.trim()) {
    return c.json({ error: "title required" }, 400);
  }
  try {
    const status: Status = body.status && isStatus(body.status) ? body.status : "draft";
    const card = await createCard(c.env.DB, {
      title: body.title.trim(),
      body: body.body || "",
      tags: body.tags || [],
      status,
      depends_on: normalizeDependsOnInput(body.depends_on),
      session_id: normalizeSessionIdInput(body.session_id),
      agent: normalizeAgentInput(body.agent),
    });
    return c.json({ card }, 201);
  } catch (err) {
    if (err instanceof InputValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.patch("/api/cards/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    tags?: string[];
    depends_on?: unknown;
    session_id?: unknown;
    agent?: unknown;
  };
  try {
    const card = await updateCard(c.env.DB, id, {
      title: body.title,
      body: body.body,
      tags: body.tags,
      depends_on: normalizeDependsOnInput(body.depends_on),
      session_id: normalizeSessionIdInput(body.session_id),
      agent: normalizeAgentInput(body.agent),
    });
    return c.json({ card });
  } catch (err) {
    if (err instanceof InputValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

app.post("/api/cards/:id/move", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    status?: string;
    depends_on?: unknown;
    session_id?: unknown;
    agent?: unknown;
  };
  if (!body.status || !isStatus(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  try {
    const meta: MoveMeta = {
      depends_on: normalizeDependsOnInput(body.depends_on),
      session_id: normalizeSessionIdInput(body.session_id),
      agent: normalizeAgentInput(body.agent),
    };
    const card = await moveCard(c.env.DB, id, body.status, meta);
    return c.json({ card });
  } catch (err) {
    if (err instanceof InputValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof TransitionError || err instanceof SpecRequiredError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

app.delete("/api/cards/:id", async (c) => {
  try {
    await deleteCard(c.env.DB, c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

app.get("/api/cards/:id/prompt", async (c) => {
  const card = await getCard(c.env.DB, c.req.param("id"));
  if (!card) return c.json({ error: "not found" }, 404);
  return c.text(buildPrompt(card));
});

app.get("/api/cards/:id/events", async (c) => {
  const card = await getCard(c.env.DB, c.req.param("id"));
  if (!card) return c.json({ error: "not found" }, 404);
  const events = await listCardEvents(c.env.DB, card.id);
  return c.json({ events });
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
