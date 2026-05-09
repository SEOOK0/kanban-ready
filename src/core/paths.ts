export const STATUSES = ["draft", "ready", "done", "deploy", "discarded"] as const;
export type Status = (typeof STATUSES)[number];

export function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}

export const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ["ready", "discarded"],
  ready: ["done", "discarded"],
  done: ["deploy", "discarded"],
  deploy: ["discarded"],
  discarded: [],
};

export function canTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}
