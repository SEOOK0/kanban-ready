import type { Status } from "./paths.js";

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

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/[^a-z0-9가-힣\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return base || "untitled";
}

export function todayPrefix(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function makeId(title: string, now: Date = new Date()): string {
  return `${todayPrefix(now)}-${slugify(title)}`;
}

export function firstLinePreview(body: string, max = 80): string {
  const line = body
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !s.startsWith("#"));
  if (!line) return "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
