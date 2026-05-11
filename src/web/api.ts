export type Status = "draft" | "agent_working" | "ready" | "done" | "deploy" | "discarded";

export const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ["agent_working", "ready", "discarded"],
  agent_working: ["draft", "ready", "discarded"],
  ready: ["agent_working", "done", "discarded"],
  done: ["ready", "deploy", "discarded"],
  deploy: ["done", "discarded"],
  discarded: ["draft", "agent_working", "ready", "done", "deploy"],
};

export function canTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export interface Card {
  id: string;
  number: number;
  title: string;
  status: Status;
  body: string;
  created: string;
  updated: string;
  tags: string[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export async function listCards(): Promise<Card[]> {
  const data = await req<{ cards: Card[] }>("/api/cards");
  return data.cards;
}

export async function createCard(input: { title: string; body?: string; status?: Status }): Promise<Card> {
  const data = await req<{ card: Card }>("/api/cards", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.card;
}

export async function updateCard(id: string, patch: { title?: string; body?: string; tags?: string[] }): Promise<Card> {
  const data = await req<{ card: Card }>(`/api/cards/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.card;
}

export async function moveCard(id: string, status: Status): Promise<Card> {
  const data = await req<{ card: Card }>(`/api/cards/${encodeURIComponent(id)}/move`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  return data.card;
}

export async function deleteCard(id: string): Promise<void> {
  await req<{ ok: true }>(`/api/cards/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getPrompt(id: string): Promise<string> {
  const res = await fetch(`/api/cards/${encodeURIComponent(id)}/prompt`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}
