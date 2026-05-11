export const STATUSES = ["draft", "agent_working", "ready", "done", "deploy", "discarded"] as const;
export type Status = (typeof STATUSES)[number];

export function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}

export const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ["agent_working", "ready", "discarded"],
  agent_working: ["ready", "discarded"],
  ready: ["done", "discarded"],
  done: ["deploy", "discarded"],
  deploy: ["discarded"],
  discarded: [],
};

export function canTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}
