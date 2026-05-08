import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import {
  type Card,
  type Status,
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
];

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
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [root, setRoot] = useState<string>("");

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
        const health = await fetch("/api/health").then((r) => r.json());
        setRoot(health.root || "");
      } catch (err) {
        flashToast(`load failed: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh, flashToast]);

  const grouped = useMemo(() => {
    const g: Record<Status, Card[]> = { draft: [], ready: [], done: [] };
    for (const c of cards) g[c.status].push(c);
    return g;
  }, [cards]);

  const onDragEnd = useCallback(
    async (result: DropResult) => {
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (source.droppableId === destination.droppableId) return;
      const target = destination.droppableId as Status;
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
    async (status: Status, title: string) => {
      if (!title.trim()) return;
      try {
        await createCard({ title: title.trim(), status });
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

  const handleMove = useCallback(
    async (id: string, target: Status) => {
      try {
        const updated = await moveCard(id, target);
        await refresh();
        setActiveCard(updated);
      } catch (err) {
        flashToast(`move failed: ${(err as Error).message}`);
      }
    },
    [refresh, flashToast],
  );

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">kanban-ready</div>
        <div className="root">{root}</div>
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
              onQuickAdd={(t) => handleQuickAdd(status, t)}
              onCardClick={(c) => setActiveCard(c)}
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
          onMove={(target) => handleMove(activeCard.id, target)}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

interface ColumnProps {
  status: Status;
  label: string;
  cards: Card[];
  loading: boolean;
  onQuickAdd: (title: string) => void;
  onCardClick: (card: Card) => void;
}

function Column({ status, label, cards, loading, onQuickAdd, onCardClick }: ColumnProps) {
  const [adding, setAdding] = useState("");
  const compact = status === "done";

  return (
    <div className="column">
      <div className={`column-header ${status}`}>
        <span className="label">{label}</span>
        <span className="count">{loading ? "…" : cards.length}</span>
      </div>
      {status === "draft" ? (
        <div className="quick-add">
          <input
            placeholder="아이디어 빠르게 등록 (Enter)"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && adding.trim()) {
                onQuickAdd(adding);
                setAdding("");
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
                    <div className="title">{card.title}</div>
                    {!compact ? (
                      <div className="preview">{firstLine(card.body)}</div>
                    ) : (
                      <div className="preview">{firstLine(card.body, 60)}</div>
                    )}
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
  onMove: (target: Status) => void;
}

function CardModal({ card, onClose, onSave, onDelete, onCopyPrompt, onMove }: CardModalProps) {
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

  const moveTargets: Status[] = (["draft", "ready", "done"] as Status[]).filter(
    (s) => s !== card.status,
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
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
            {moveTargets.map((t) => (
              <button key={t} onClick={() => onMove(t)}>
                → {t}
              </button>
            ))}
            <button onClick={onCopyPrompt}>Copy prompt</button>
            <button
              className="primary"
              disabled={!dirty}
              onClick={() => onSave({ title, body })}
            >
              Save
            </button>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
