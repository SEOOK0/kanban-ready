import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import {
  type Card,
  type Status,
  canTransition,
  createCard,
  deleteCard,
  getPrompt,
  listCards,
  moveCard,
  updateCard,
} from "./api.ts";

const COLUMNS: { status: Status; label: string }[] = [
  { status: "draft", label: "Draft" },
  { status: "ready", label: "Ready" },
  { status: "done", label: "Done" },
  { status: "deploy", label: "Deploy" },
  { status: "discarded", label: "Discarded" },
];

function emptyGroups(): Record<Status, Card[]> {
  return { draft: [], ready: [], done: [], deploy: [], discarded: [] };
}

function firstLine(body: string, max = 80): string {
  const line = body
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !s.startsWith("#"));
  if (!line) return "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  const refresh = useCallback(async () => {
    const list = await listCards();
    setCards(list);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch (err) {
        flashToast(`load failed: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh, flashToast]);

  const grouped = useMemo(() => {
    const g = emptyGroups();
    for (const c of cards) g[c.status].push(c);
    return g;
  }, [cards]);

  const onDragEnd = useCallback(
    async (result: DropResult) => {
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (source.droppableId === destination.droppableId) return;
      const from = source.droppableId as Status;
      const target = destination.droppableId as Status;
      if (!canTransition(from, target)) {
        flashToast(`이동 불가: ${from} → ${target}`);
        return;
      }
      const prev = cards;
      setCards((cs) =>
        cs.map((c) => (c.id === draggableId ? { ...c, status: target } : c)),
      );
      try {
        await moveCard(draggableId, target);
        await refresh();
      } catch (err) {
        setCards(prev);
        flashToast(`move failed: ${(err as Error).message}`);
      }
    },
    [cards, refresh, flashToast],
  );

  const handleQuickAdd = useCallback(
    async (status: Status, title: string, body?: string) => {
      if (!title.trim()) return;
      try {
        await createCard({
          title: title.trim(),
          body: body && body.trim() ? body : undefined,
          status,
        });
        await refresh();
      } catch (err) {
        flashToast(`add failed: ${(err as Error).message}`);
      }
    },
    [refresh, flashToast],
  );

  const handleSave = useCallback(
    async (id: string, patch: { title?: string; body?: string }) => {
      try {
        await updateCard(id, patch);
        await refresh();
        flashToast("saved");
      } catch (err) {
        flashToast(`save failed: ${(err as Error).message}`);
      }
    },
    [refresh, flashToast],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm(`Delete ${id}?`)) return;
      try {
        await deleteCard(id);
        await refresh();
        setActiveCard(null);
      } catch (err) {
        flashToast(`delete failed: ${(err as Error).message}`);
      }
    },
    [refresh, flashToast],
  );

  const handleCopyPrompt = useCallback(
    async (id: string) => {
      try {
        const text = await getPrompt(id);
        await navigator.clipboard.writeText(text);
        flashToast("프롬프트 복사 완료 — Claude/Codex에 붙여넣기");
      } catch (err) {
        flashToast(`copy failed: ${(err as Error).message}`);
      }
    },
    [flashToast],
  );

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">kanban-ready</div>
        <div className="topbar-right">
          <button
            type="button"
            className="rules-button"
            onClick={() => setShowRules(true)}
            aria-label="전이 규칙 보기"
            title="전이 규칙"
          >
            Flow
          </button>
        </div>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="board">
          {COLUMNS.map(({ status, label }) => (
            <Column
              key={status}
              status={status}
              label={label}
              cards={grouped[status]}
              loading={loading}
              onQuickAdd={(t, b) => handleQuickAdd(status, t, b)}
              onCardClick={(c) => setActiveCard(c)}
              onCopyPrompt={handleCopyPrompt}
            />
          ))}
        </div>
      </DragDropContext>

      {activeCard ? (
        <CardModal
          card={activeCard}
          onClose={() => setActiveCard(null)}
          onSave={async (patch) => {
            await handleSave(activeCard.id, patch);
            setActiveCard((cur) => (cur ? { ...cur, ...patch } : cur));
          }}
          onDelete={() => handleDelete(activeCard.id)}
          onCopyPrompt={() => handleCopyPrompt(activeCard.id)}
        />
      ) : null}

      {showRules ? <RulesModal onClose={() => setShowRules(false)} /> : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

interface ColumnProps {
  status: Status;
  label: string;
  cards: Card[];
  loading: boolean;
  onQuickAdd: (title: string, body?: string) => void;
  onCardClick: (card: Card) => void;
  onCopyPrompt: (id: string) => void;
}

function Column({ status, label, cards, loading, onQuickAdd, onCardClick, onCopyPrompt }: ColumnProps) {
  const [adding, setAdding] = useState("");
  const compact = status === "done" || status === "deploy" || status === "discarded";

  return (
    <div className={`column ${status}`}>
      <div className={`column-header ${status}`}>
        <span className="label">{label}</span>
        <span className="count">{loading ? "…" : cards.length}</span>
      </div>
      {status === "draft" ? (
        <div className="quick-add">
          <textarea
            placeholder="아이디어 빠르게 등록"
            rows={1}
            value={adding}
            onChange={(e) => {
              setAdding(e.target.value);
              const ta = e.currentTarget;
              ta.style.height = "auto";
              ta.style.height = ta.scrollHeight + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const text = adding;
                if (!text.trim()) return;
                const newlineAt = text.indexOf("\n");
                const title =
                  newlineAt === -1 ? text.trim() : text.slice(0, newlineAt).trim();
                const body =
                  newlineAt === -1 ? undefined : text.slice(newlineAt + 1);
                if (!title) return;
                onQuickAdd(title, body);
                setAdding("");
                e.currentTarget.style.height = "";
              }
            }}
          />
        </div>
      ) : null}
      <Droppable droppableId={status}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`cards ${snapshot.isDraggingOver ? "dragging-over" : ""}`}
          >
            {cards.map((card, idx) => (
              <Draggable key={card.id} draggableId={card.id} index={idx}>
                {(prov, snap) => (
                  <div
                    ref={prov.innerRef}
                    {...prov.draggableProps}
                    {...prov.dragHandleProps}
                    className={`card ${compact ? "compact" : ""} ${snap.isDragging ? "dragging" : ""}`}
                    onClick={() => onCardClick(card)}
                  >
                    <div className="title">
                      <span className="card-number">#{card.number}</span>
                      {card.title}
                    </div>
                    {!compact ? (
                      <div className="preview">{firstLine(card.body)}</div>
                    ) : (
                      <div className="preview">{firstLine(card.body, 60)}</div>
                    )}
                    {status === "ready" ? (
                      <button
                        type="button"
                        className="card-copy"
                        aria-label="prompt 복사"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCopyPrompt(card.id);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}

interface CardModalProps {
  card: Card;
  onClose: () => void;
  onSave: (patch: { title?: string; body?: string }) => Promise<void>;
  onDelete: () => void;
  onCopyPrompt: () => void;
}

function CardModal({ card, onClose, onSave, onDelete, onCopyPrompt }: CardModalProps) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const dirty = title !== card.title || body !== card.body;

  useEffect(() => {
    setTitle(card.title);
    setBody(card.body);
  }, [card.id, card.title, card.body]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty) onSave({ title, body });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty, title, body, onSave, onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-number">#{card.number}</span>
          <input
            className="title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <span className={`status-badge ${card.status}`}>{card.status}</span>
        </div>
        <div className="modal-body">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="modal-footer">
          <div className="left">
            <button className="danger" onClick={onDelete}>
              Delete
            </button>
          </div>
          <div className="right">
            <span className="id">{card.id}</span>
            <button onClick={onClose}>Close</button>
            <button disabled={!dirty} onClick={() => onSave({ title, body })}>
              Save
            </button>
            <button className="primary" onClick={onCopyPrompt}>
              Copy prompt
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RulesModalProps {
  onClose: () => void;
}

function RulesModal({ onClose }: RulesModalProps) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const forward: Status[] = ["draft", "ready", "done", "deploy"];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal rules-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="rules-title">Transition rules</span>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="modal-body rules-body">
          <div className="rules-flow">
            <div className="rules-flow-row">
              {forward.map((s, i) => (
                <span key={s} className="rules-flow-cell">
                  <span className={`rules-node ${s}`}>{s}</span>
                  {i < forward.length - 1 ? (
                    <span className="rules-arrow" aria-hidden="true">→</span>
                  ) : null}
                </span>
              ))}
            </div>
            <div className="rules-flow-row terminal">
              <span className="rules-source">모든 상태</span>
              <span className="rules-arrow" aria-hidden="true">→</span>
              <span className="rules-node discarded">discarded</span>
              <span className="rules-terminal-note">(종착, 복원 불가)</span>
            </div>
          </div>

          <ul className="rules-notes">
            <li>전진은 한 칸씩만. done/deploy 직행 불가.</li>
            <li>모든 상태에서 discarded 가능 (draft 포함, 폐기 기록 남김).</li>
            <li>역방향 이동 없음. 다시 작업하려면 새 카드 생성.</li>
            <li>discarded는 종착지. 복원 불가, 카드 삭제는 별개 액션.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
