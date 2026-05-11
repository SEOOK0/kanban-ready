export const STATUSES = ["draft", "agent_working", "ready", "done", "deploy", "discarded"] as const;
export type Status = (typeof STATUSES)[number];

export function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}

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
