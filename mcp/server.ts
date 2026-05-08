#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Card } from "../src/core/card.js";
import { STATUSES } from "../src/core/paths.js";

const BASE_URL = (process.env.KANBAN_API_URL || "https://kanban.example.com").replace(/\/+$/, "");

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
  return `- ${c.id} (${c.status}) ${c.title}${tags}${tail}`;
}

const server = new McpServer({ name: "kanban-ready", version: "0.1.0" });

server.registerTool(
  "list_cards",
  {
    description:
      "List kanban cards. Optionally filter by status (draft|ready|done). Most recently updated first.",
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
      "Move a card to draft|ready|done. Use 'done' to mark a Ready card as completed after finishing the work.",
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
      content: [{ type: "text", text: `moved → ${card.status}: ${card.id} ${card.title}` }],
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
      content: [{ type: "text", text: `created (${card.status}): ${card.id} ${card.title}` }],
      structuredContent: { card },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
