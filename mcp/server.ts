#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Card } from "../src/core/card.js";
import { AGENTS, STATUSES } from "../src/core/paths.js";

function resolveBaseUrl(): string {
  const raw = process.env.KANBAN_API_URL;
  if (!raw) {
    throw new Error(
      "KANBAN_API_URL is not set. Point it at your deployed worker (e.g. https://kanban.your-domain.com) " +
        "or http://localhost:8787 for a local wrangler dev session.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`KANBAN_API_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`KANBAN_API_URL must use http(s): ${raw}`);
  }
  if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`KANBAN_API_URL must use https except for localhost: ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

const BASE_URL = resolveBaseUrl();
const WORKFLOWS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "agent-workflow.md");

async function apiRaw(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method || "GET"} ${path} → ${res.status} ${text || res.statusText}`);
  }
  return text;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const text = await apiRaw(path, init);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function summarizeCard(c: Card): string {
  const tags = c.tags.length ? ` [${c.tags.join(", ")}]` : "";
  const preview = c.body.split("\n").map((s) => s.trim()).find(Boolean) || "";
  const tail = preview ? ` — ${preview.length > 80 ? preview.slice(0, 79) + "…" : preview}` : "";
  const meta: string[] = [];
  if (c.agent) meta.push(`agent=${c.agent}`);
  if (c.session_id) meta.push(`session=${c.session_id}`);
  if (c.depends_on.length) meta.push(`deps=${c.depends_on.map((n) => `#${n}`).join(",")}`);
  const metaTail = meta.length ? ` {${meta.join(" ")}}` : "";
  return `- #${c.number} ${c.id} (${c.status}) ${c.title}${tags}${metaTail}${tail}`;
}

const server = new McpServer({ name: "kanban-ready", version: "0.2.0" });

server.registerTool(
  "get_workflows",
  {
    description:
      "Read the kanban-ready agent workflow guide (docs/agent-workflow.md). Call this FIRST in a session to learn the card lifecycle, transition rules, and standard MCP dispatch flow before using other tools.",
    inputSchema: {},
  },
  async () => {
    const text = readFileSync(WORKFLOWS_PATH, "utf-8");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "list_cards",
  {
    description:
      "List kanban cards. Optionally filter by status (draft|agent_working|ready|done|deploy|discarded). Most recently updated first. For dispatch, filter by 'ready'.",
    inputSchema: {
      status: z.enum(STATUSES).optional().describe("Filter by status"),
    },
  },
  async ({ status }) => {
    const qs = status ? `?${new URLSearchParams({ status }).toString()}` : "";
    const { cards } = await apiJson<{ cards: Card[] }>(`/api/cards${qs}`);
    const lines = cards.length
      ? cards.map(summarizeCard).join("\n")
      : "(no cards)";
    return {
      content: [{ type: "text", text: lines }],
      structuredContent: { cards },
    };
  },
);

server.registerTool(
  "get_card",
  {
    description:
      "Get a card's full content (title, status, tags, body) by id. Use this to read a draft before refining it.",
    inputSchema: {
      id: z.string().min(1).describe("Card id"),
    },
  },
  async ({ id }) => {
    const { card } = await apiJson<{ card: Card }>(`/api/cards/${encodeURIComponent(id)}`);
    const tags = card.tags.length ? `\ntags: ${card.tags.join(", ")}` : "";
    const metaLines: string[] = [];
    if (card.agent) metaLines.push(`agent: ${card.agent}`);
    if (card.session_id) metaLines.push(`session: ${card.session_id}`);
    if (card.depends_on.length) metaLines.push(`depends_on: ${card.depends_on.map((n) => `#${n}`).join(", ")}`);
    const meta = metaLines.length ? `\n${metaLines.join("\n")}` : "";
    const text = `#${card.number} ${card.id} (${card.status}) ${card.title}${tags}${meta}\n\n${card.body}`;
    return {
      content: [{ type: "text", text }],
      structuredContent: { card },
    };
  },
);

server.registerTool(
  "update_card",
  {
    description:
      "Update a card's title, body, tags, or dispatch metadata (depends_on, session_id, agent). Use this to refine a draft into a Ready-quality spec. Status changes go through move_card; for the draft → agent_working hand-off use start_agent_work so agent/session_id are recorded atomically.",
    inputSchema: {
      id: z.string().min(1).describe("Card id"),
      title: z.string().min(1).optional().describe("New title (id stays the same)"),
      body: z.string().optional().describe("New body / spec"),
      tags: z.array(z.string()).optional().describe("Replace tags (full list, not a delta)"),
      depends_on: z
        .array(z.number().int().positive())
        .optional()
        .describe("Card numbers this card depends on (e.g. [3, 7]). Replaces, not appends."),
      session_id: z
        .string()
        .nullable()
        .optional()
        .describe("Agent session id. Pass null to clear."),
      agent: z
        .enum(AGENTS)
        .nullable()
        .optional()
        .describe("Which agent ran this card. Pass null to clear."),
    },
  },
  async ({ id, title, body, tags, depends_on, session_id, agent }) => {
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (tags !== undefined) payload.tags = tags;
    if (depends_on !== undefined) payload.depends_on = depends_on;
    if (session_id !== undefined) payload.session_id = session_id;
    if (agent !== undefined) payload.agent = agent;
    const { card } = await apiJson<{ card: Card }>(
      `/api/cards/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    );
    return {
      content: [{ type: "text", text: `updated (${card.status}): #${card.number} ${card.id} ${card.title}` }],
      structuredContent: { card },
    };
  },
);

server.registerTool(
  "get_prompt",
  {
    description:
      "Get the AI-ready prompt text for a card by id. The prompt embeds card id, status, title, and body.",
    inputSchema: {
      id: z.string().min(1).describe("Card id (e.g. 2026-05-08-d1-백업-스케줄)"),
    },
  },
  async ({ id }) => {
    const text = await apiRaw(`/api/cards/${encodeURIComponent(id)}/prompt`);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "move_card",
  {
    description:
      "Move a card to draft|agent_working|ready|done|deploy|discarded. Active workflow moves one step at a time in either direction (draft↔agent_working↔ready↔done↔deploy); draft→ready direct is also allowed. Skipping further (e.g. draft→done or done→agent_working) rejects with 'Invalid transition'. Any move into 'ready' requires a non-empty body (spec) — write spec/task via update_card first or the move is rejected with 'Insufficient spec'. 'discarded' is reachable from any state and can be restored to any active status. To mark a draft as actively being worked on by an agent, prefer the dedicated start_agent_work tool. See get_workflows for full rules.",
    inputSchema: {
      id: z.string().min(1).describe("Card id"),
      status: z.enum(STATUSES).describe("Target column"),
    },
  },
  async ({ id, status }) => {
    const { card } = await apiJson<{ card: Card }>(
      `/api/cards/${encodeURIComponent(id)}/move`,
      { method: "POST", body: JSON.stringify({ status }) },
    );
    return {
      content: [{ type: "text", text: `moved → ${card.status}: #${card.number} ${card.id} ${card.title}` }],
      structuredContent: { card },
    };
  },
);

server.registerTool(
  "start_agent_work",
  {
    description:
      "Mark a draft card as actively being worked on by an agent and record who is working on it. This is the canonical draft → agent_working hand-off: pass your own identity (`agent` = 'cc' for Claude Code / 'codex' for Codex CLI) and your session id so the card carries the dispatch trail. The column flip gives the user a real-time signal the agent picked the card up; the recorded agent/session_id stays on the card for traceability. Body may be empty at this point — you fill it via update_card while in agent_working. The card is usually in 'draft' or already in 'agent_working' (idempotent in the latter case; the meta still updates). Use move_card for general undo/restore moves without metadata.",
    inputSchema: {
      id: z.string().min(1).describe("Card id"),
      agent: z
        .enum(AGENTS)
        .describe("Which agent is starting work: 'cc' (Claude Code) or 'codex' (Codex CLI)."),
      session_id: z
        .string()
        .min(1)
        .describe("Your current session id (e.g. the UUID of this Claude Code or Codex CLI session)."),
      depends_on: z
        .array(z.number().int().positive())
        .optional()
        .describe("Card numbers this card depends on (e.g. [3, 7]). Optional. Replaces any existing list."),
    },
  },
  async ({ id, agent, session_id, depends_on }) => {
    const payload: Record<string, unknown> = {
      status: "agent_working",
      agent,
      session_id,
    };
    if (depends_on !== undefined) payload.depends_on = depends_on;
    const { card } = await apiJson<{ card: Card }>(
      `/api/cards/${encodeURIComponent(id)}/move`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    return {
      content: [{ type: "text", text: `agent working (${card.agent ?? "?"}): #${card.number} ${card.id} ${card.title}` }],
      structuredContent: { card },
    };
  },
);

server.registerTool(
  "create_card",
  {
    description:
      "Create a new card. Defaults to draft column. Use this to capture ideas surfaced during a conversation. Dispatch metadata (depends_on/session_id/agent) can be set up front when known, or filled later via start_agent_work / update_card.",
    inputSchema: {
      title: z.string().min(1).describe("Card title (becomes part of the id)"),
      body: z.string().optional().describe("Card body / spec"),
      status: z.enum(STATUSES).optional().describe("Initial status (default: draft)"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
      depends_on: z
        .array(z.number().int().positive())
        .optional()
        .describe("Card numbers this card depends on (e.g. [3, 7])."),
      session_id: z.string().min(1).optional().describe("Agent session id, if known at creation."),
      agent: z.enum(AGENTS).optional().describe("Which agent will run this card, if known."),
    },
  },
  async ({ title, body, status, tags, depends_on, session_id, agent }) => {
    const payload: Record<string, unknown> = { title };
    if (body !== undefined) payload.body = body;
    if (status !== undefined) payload.status = status;
    if (tags !== undefined) payload.tags = tags;
    if (depends_on !== undefined) payload.depends_on = depends_on;
    if (session_id !== undefined) payload.session_id = session_id;
    if (agent !== undefined) payload.agent = agent;
    const { card } = await apiJson<{ card: Card }>(`/api/cards`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return {
      content: [{ type: "text", text: `created (${card.status}): #${card.number} ${card.id} ${card.title}` }],
      structuredContent: { card },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
