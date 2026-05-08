import type { Card } from "./card.js";

export function buildPrompt(card: Card): string {
  const header =
    card.status === "draft"
      ? "다음은 칸반 Draft 카드다. 함께 논의해서 Ready로 넘길 스펙을 만들어줘. 확정되면 보드에서 Ready 컬럼으로 이동시킬 것."
      : card.status === "ready"
        ? "다음은 칸반 Ready 카드다. 이 스펙대로 구현해줘. 끝나면 보드에서 Done 컬럼으로 이동시킬 것."
        : "다음은 칸반 Done 카드다. 참고용.";
  const idLine = `--- Card id: ${card.id} (${card.status}) ---`;
  const titleLine = `# ${card.title}`;
  return `${header}\n\n${idLine}\n${titleLine}\n\n${card.body}\n`;
}
