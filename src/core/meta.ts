import { type Agent, isAgent } from "./paths.js";

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export function normalizeDependsOn(input: readonly number[] | undefined): number[] {
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

export function normalizeDependsOnInput(raw: unknown): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new InputValidationError("depends_on must be an array of positive integers");
  }

  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of raw) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new InputValidationError("depends_on must be an array of positive integers");
    }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function normalizeAgentInput(raw: unknown): Agent | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (isAgent(raw)) return raw;
  throw new InputValidationError("agent must be 'cc', 'codex', or null");
}

export function normalizeSessionIdInput(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new InputValidationError("session_id must be a string or null");
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
