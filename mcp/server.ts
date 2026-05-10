#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Card } from "../src/core/card.js";
import { STATUSES } from "../src/core/paths.js";

const BASE_URL = (process.env.KANBAN_API_URL || "https://kanban.example.com").replace(/\/+$/, "");
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
  return `- #${c.number} ${c.id} (${c.status}) ${c.title}${tags}${tail}`;
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
      "List kanban cards. Optionally filter by status (draft|ready|done|deploy|discarded). Most recently updated first. For dispatch, filter by 'ready'.",
    inputSchema: {
      status: z.enum(STATUSES).optional().describe("Filter by status"),
    },
  },
  async ({ status }) => {
    const qs = status ? `?status=${status}` : "";
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
    const text = `#${card.number} ${card.id} (${card.status}) ${card.title}${tags}\n\n${card.body}`;
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
      "Update a card's title, body, or tags. Use this to refine a draft into a Ready-quality spec. Status changes go through move_card.",
    inputSchema: {
      id: z.string().min(1).describe("Card id"),
      title: z.string().min(1).optional().describe("New title (id stays the same)"),
      body: z.string().optional().describe("New body / spec"),
      tags: z.array(z.string()).optional().describe("Replace tags (full list, not a delta)"),
    },
  },
  async ({ id, title, body, tags }) => {
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (tags !== undefined) payload.tags = tags;
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
      "Move a card to draft|ready|done|deploy|discarded. Forward path is one step at a time (draft→ready→done→deploy); skipping rejects with 'Invalid transition'. draft→ready also requires a non-empty body (spec) — write spec/task via update_card first or the move is rejected with 'Insufficient spec'. 'discarded' is reachable from any state and is terminal. See get_workflows for full rules.",
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
  "create_card",
  {
    description:
      "Create a new card. Defaults to draft column. Use this to capture ideas surfaced during a conversation.",
    inputSchema: {
      title: z.string().min(1).describe("Card title (becomes part of the id)"),
      body: z.string().optional().describe("Card body / spec"),
      status: z.enum(STATUSES).optional().describe("Initial status (default: draft)"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
    },
  },
  async ({ title, body, status, tags }) => {
    const payload: Record<string, unknown> = { title };
    if (body !== undefined) payload.body = body;
    if (status !== undefined) payload.status = status;
    if (tags !== undefined) payload.tags = tags;
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
