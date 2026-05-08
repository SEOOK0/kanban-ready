export const STATUSES = ["draft", "ready", "done"] as const;
export type Status = (typeof STATUSES)[number];

export function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}
