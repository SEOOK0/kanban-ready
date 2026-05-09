import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { isStatus, type Status } from "./core/paths.js";
import {
  createCard,
  deleteCard,
  getCard,
  listCards,
  moveCard,
  SpecRequiredError,
  TransitionError,
  updateCard,
} from "./core/store.js";
import { buildPrompt } from "./core/prompt.js";

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
  };
  if (!body.title || !body.title.trim()) {
    return c.json({ error: "title required" }, 400);
  }
  const status: Status = body.status && isStatus(body.status) ? body.status : "draft";
  const card = await createCard(c.env.DB, {
    title: body.title.trim(),
    body: body.body || "",
    tags: body.tags || [],
    status,
  });
  return c.json({ card }, 201);
});

app.patch("/api/cards/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    tags?: string[];
  };
  try {
    const card = await updateCard(c.env.DB, id, body);
    return c.json({ card });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

app.post("/api/cards/:id/move", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  if (!body.status || !isStatus(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  try {
    const card = await moveCard(c.env.DB, id, body.status);
    return c.json({ card });
  } catch (err) {
    if (err instanceof TransitionError || err instanceof SpecRequiredError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: (err as Error).message }, 404);
  }
});

app.delete("/api/cards/:id", async (c) => {
  try {
    await deleteCard(c.env.DB, c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

app.get("/api/cards/:id/prompt", async (c) => {
  const card = await getCard(c.env.DB, c.req.param("id"));
  if (!card) return c.json({ error: "not found" }, 404);
  return c.text(buildPrompt(card));
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
