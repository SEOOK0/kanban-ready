import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { type Status, isStatus } from "./core/paths.js";
import {
  createCard,
  deleteCard,
  getCard,
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
  SHARED_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const TOKEN_COOKIE = "kanban_token";
const TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function parseAllowedIps(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function buildTokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TOKEN_COOKIE_MAX_AGE}`;
}

app.use("*", async (c, next) => {
  const allowed = parseAllowedIps(c.env.ALLOWED_IPS);
  const sharedToken = (c.env.SHARED_TOKEN || "").trim();

  // Both gates off → fail-open (matches original behavior)
  if (allowed.length === 0 && !sharedToken) return next();

  // Setup flow: ?token=X always sets cookie + redirects, regardless of IP.
  // Lets a user (laptop or phone) bookmark the clean URL once and rely on
  // the cookie thereafter.
  if (sharedToken) {
    const qToken = c.req.query("token");
    if (qToken && qToken === sharedToken) {
      const cookie = buildTokenCookie(sharedToken);
      if (c.req.method === "GET") {
        const url = new URL(c.req.url);
        url.searchParams.delete("token");
        c.header("Set-Cookie", cookie);
        return c.redirect(url.toString(), 302);
      }
      c.header("Set-Cookie", cookie);
      return next();
    }
  }

  // IP gate
  const ip = c.req.header("cf-connecting-ip") || "";
  if (allowed.length > 0 && allowed.includes(ip)) return next();

  // Cookie gate
  if (sharedToken) {
    const cookieToken = readCookie(c.req.header("cookie"), TOKEN_COOKIE);
    if (cookieToken && cookieToken === sharedToken) return next();
  }

  return c.text("Forbidden", 403);
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

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
