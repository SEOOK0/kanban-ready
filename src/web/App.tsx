import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AGENTS,
  type Agent,
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

const DRAFT_BODY_TEMPLATE =
  "## 목표\n\n## 컨텍스트\n\n## 작업 단계\n- [ ] …\n\n## 검증 기준\n- [ ] …\n";

function shortSession(id: string | null): string {
  if (!id) return "";
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const COLUMNS: { status: Status; label: string; filterLabel: string; weight: number }[] = [
  { status: "draft", label: "Draft", filterLabel: "Draft", weight: 1 },
  { status: "agent_working", label: "Agent", filterLabel: "Agent", weight: 1.1 },
  { status: "ready", label: "Ready", filterLabel: "Ready", weight: 1.1 },
  { status: "done", label: "Done", filterLabel: "Done", weight: 0.9 },
  { status: "deploy", label: "Deploy", filterLabel: "Deploy", weight: 0.85 },
  { status: "discarded", label: "Discarded", filterLabel: "Discarded", weight: 0.7 },
];

const STATUS_FILTER_KEY = "kanban-ready:hidden-statuses";
const DEFAULT_HIDDEN_STATUSES: Status[] = ["deploy"];
const STATUS_SET = new Set<Status>(COLUMNS.map((c) => c.status));

function emptyGroups(): Record<Status, Card[]> {
  return { draft: [], agent_working: [], ready: [], done: [], deploy: [], discarded: [] };
}

function firstLine(body: string, max = 80): string {
  const line = body
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !s.startsWith("#"));
  if (!line) return "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function readHiddenStatuses(): Set<Status> {
  if (typeof window === "undefined") return new Set(DEFAULT_HIDDEN_STATUSES);
  const raw = window.localStorage.getItem(STATUS_FILTER_KEY);
  if (!raw) return new Set(DEFAULT_HIDDEN_STATUSES);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_HIDDEN_STATUSES);
    return new Set(parsed.filter((s): s is Status => STATUS_SET.has(s as Status)));
  } catch {
    return new Set(DEFAULT_HIDDEN_STATUSES);
  }
}

function buildGridColumns(columns: typeof COLUMNS): string {
  return columns.map((c) => `${c.weight}fr`).join(" ");
}

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [hiddenStatuses, setHiddenStatuses] = useState(readHiddenStatuses);
  const [openMobileStatus, setOpenMobileStatus] = useState<Status>("ready");
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

  useEffect(() => {
    window.localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify([...hiddenStatuses]));
  }, [hiddenStatuses]);

  const grouped = useMemo(() => {
    const g = emptyGroups();
    for (const c of cards) g[c.status].push(c);
    return g;
  }, [cards]);

  const visibleColumns = useMemo(
    () => COLUMNS.filter((c) => !hiddenStatuses.has(c.status)),
    [hiddenStatuses],
  );

  useEffect(() => {
    if (!hiddenStatuses.has(openMobileStatus)) return;
    const next = visibleColumns.find((c) => c.status === "ready") ?? visibleColumns[0];
    if (next) setOpenMobileStatus(next.status);
  }, [hiddenStatuses, openMobileStatus, visibleColumns]);

  const toggleStatusFilter = useCallback((status: Status) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
        return next;
      }
      const visibleCount = COLUMNS.length - next.size;
      if (visibleCount <= 1) return prev;
      next.add(status);
      return next;
    });
  }, []);

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
      const finalBody = body && body.trim() ? body : DRAFT_BODY_TEMPLATE;
      try {
        await createCard({
          title: title.trim(),
          body: finalBody,
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
    async (
      id: string,
      patch: {
        title?: string;
        body?: string;
        depends_on?: number[];
        session_id?: string | null;
        agent?: Agent | null;
      },
    ) => {
      try {
        await updateCard(id, patch);
        await refresh();
        flashToast("저장됨");
        return true;
      } catch (err) {
        flashToast(`save failed: ${(err as Error).message}`);
        return false;
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
        flashToast("프롬프트 복사 완료");
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
          <StatusFilter hiddenStatuses={hiddenStatuses} onToggle={toggleStatusFilter} />
          <span className="topbar-count">
            {visibleColumns.length}/{COLUMNS.length}
          </span>
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
        <div className="board" style={{ gridTemplateColumns: buildGridColumns(visibleColumns) }}>
          {visibleColumns.map(({ status, label }) => (
            <Column
              key={status}
              status={status}
              label={label}
              cards={grouped[status]}
              loading={loading}
              mobileOpen={openMobileStatus === status}
              onMobileToggle={() => setOpenMobileStatus(status)}
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
            const ok = await handleSave(activeCard.id, patch);
            if (ok) setActiveCard(null);
            else setActiveCard((cur) => (cur ? { ...cur, ...patch } : cur));
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

interface StatusFilterProps {
  hiddenStatuses: Set<Status>;
  onToggle: (status: Status) => void;
}

function StatusFilter({ hiddenStatuses, onToggle }: StatusFilterProps) {
  return (
    <div className="status-filter" role="group" aria-label="status filter">
      {COLUMNS.map(({ status, filterLabel }) => {
        const off = hiddenStatuses.has(status);
        return (
          <button
            key={status}
            type="button"
            className={`status-filter-chip ${status} ${off ? "is-off" : "is-on"}`}
            aria-pressed={!off}
            onClick={() => onToggle(status)}
            title={off ? `${filterLabel} 보이기` : `${filterLabel} 숨기기`}
          >
            <span className={`status-dot ${status}`} aria-hidden="true" />
            <span className="status-filter-label">{filterLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

interface ColumnProps {
  status: Status;
  label: string;
  cards: Card[];
  loading: boolean;
  mobileOpen: boolean;
  onMobileToggle: () => void;
  onQuickAdd: (title: string, body?: string) => void;
  onCardClick: (card: Card) => void;
  onCopyPrompt: (id: string) => void;
}

function Column({
  status,
  label,
  cards,
  loading,
  mobileOpen,
  onMobileToggle,
  onQuickAdd,
  onCardClick,
  onCopyPrompt,
}: ColumnProps) {
  const [adding, setAdding] = useState("");
  const compact = status === "done" || status === "deploy";
  const tight = status === "discarded";

  return (
    <div className={`column ${status} ${mobileOpen ? "mobile-open" : "mobile-closed"}`}>
      <div
        className={`column-header ${status}`}
        role="button"
        tabIndex={0}
        aria-expanded={mobileOpen}
        onClick={onMobileToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onMobileToggle();
          }
        }}
      >
        <span className="label">
          <span className={`status-dot ${status}`} aria-hidden="true" />
          {label}
        </span>
        <span className="column-header-right">
          <span className="count">{loading ? "…" : cards.length}</span>
          <span className="mobile-chev" aria-hidden="true">
            {mobileOpen ? "▾" : "▸"}
          </span>
        </span>
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
                    className={`card ${status} ${compact ? "compact" : ""} ${tight ? "tight" : ""} ${
                      snap.isDragging ? "dragging" : ""
                    }`}
                    onClick={() => onCardClick(card)}
                  >
                    <div className="title-row">
                      <span className="card-number">#{card.number}</span>
                      <span className="title">{card.title}</span>
                    </div>
                    {!compact && !tight ? (
                      <div className="preview">{firstLine(card.body)}</div>
                    ) : null}
                    {!compact && !tight ? <CardMetaRow card={card} /> : null}
                    {status === "agent_working" && !tight ? (
                      <div className="agent-progress" aria-hidden="true">
                        <span />
                      </div>
                    ) : null}
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
  onSave: (patch: {
    title?: string;
    body?: string;
    depends_on?: number[];
    session_id?: string | null;
    agent?: Agent | null;
  }) => Promise<void>;
  onDelete: () => void;
  onCopyPrompt: () => void;
}

function dependsOnToString(deps: number[]): string {
  return deps.map((n) => `#${n}`).join(", ");
}

function parseDependsOnInput(raw: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const tok of raw.split(/[\s,]+/)) {
    if (!tok) continue;
    const n = Number(tok.replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function CardModal({ card, onClose, onSave, onDelete, onCopyPrompt }: CardModalProps) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [dependsOnText, setDependsOnText] = useState(dependsOnToString(card.depends_on));
  const [sessionIdText, setSessionIdText] = useState(card.session_id ?? "");
  const [agentValue, setAgentValue] = useState<Agent | "">(card.agent ?? "");
  const [editing, setEditing] = useState(false);
  const bodyEditRef = useRef<HTMLTextAreaElement | null>(null);

  const parsedDeps = useMemo(() => parseDependsOnInput(dependsOnText), [dependsOnText]);
  const depsDirty = JSON.stringify(parsedDeps) !== JSON.stringify(card.depends_on);
  const sessionDirty = (sessionIdText.trim() || null) !== card.session_id;
  const agentDirty = (agentValue || null) !== card.agent;
  const dirty = title !== card.title || body !== card.body || depsDirty || sessionDirty || agentDirty;

  useEffect(() => {
    setTitle(card.title);
    setBody(card.body);
    setDependsOnText(dependsOnToString(card.depends_on));
    setSessionIdText(card.session_id ?? "");
    setAgentValue(card.agent ?? "");
    setEditing(false);
  }, [card.id, card.title, card.body, card.depends_on, card.session_id, card.agent]);

  useEffect(() => {
    if (editing) bodyEditRef.current?.focus();
  }, [editing]);

  const buildPatch = useCallback(() => ({
    title,
    body,
    depends_on: parsedDeps,
    session_id: sessionIdText.trim() || null,
    agent: (agentValue || null) as Agent | null,
  }), [title, body, parsedDeps, sessionIdText, agentValue]);

  const handleSave = useCallback(async () => {
    await onSave(buildPatch());
    setEditing(false);
  }, [onSave, buildPatch]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editing) setEditing(false);
        else onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty) handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        setEditing((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty, handleSave, onClose, editing]);

  const handlePreviewClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a")) return;
    if (window.getSelection()?.toString().length) return;
    setEditing(true);
  }, []);

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
          <button
            type="button"
            className="modal-body-toggle"
            onClick={() => setEditing((v) => !v)}
            title={editing ? "Preview (Esc)" : "Edit (⌘/Ctrl+E or click body)"}
          >
            {editing ? "Preview" : "Edit"}
          </button>
          {editing ? (
            <textarea
              ref={bodyEditRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          ) : (
            <div
              className={`markdown-body ${body.trim() ? "" : "markdown-body--empty"}`}
              onClick={handlePreviewClick}
              title="Click to edit (⌘/Ctrl+E)"
            >
              {body.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
              ) : (
                <span className="markdown-body__hint">empty — click to add</span>
              )}
            </div>
          )}
        </div>
        <div className="modal-meta">
          <label className="meta-field">
            <span className="meta-label">Agent</span>
            <select
              value={agentValue}
              onChange={(e) => setAgentValue(e.target.value as Agent | "")}
            >
              <option value="">—</option>
              {AGENTS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
          <label className="meta-field">
            <span className="meta-label">Session</span>
            <input
              className="meta-input mono"
              placeholder="agent session id"
              value={sessionIdText}
              onChange={(e) => setSessionIdText(e.target.value)}
            />
          </label>
          <label className="meta-field">
            <span className="meta-label">Depends</span>
            <input
              className="meta-input mono"
              placeholder="#3, #7"
              value={dependsOnText}
              onChange={(e) => setDependsOnText(e.target.value)}
            />
          </label>
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
            <button disabled={!dirty} onClick={handleSave}>
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

function CardMetaRow({ card }: { card: Card }) {
  const hasMeta = card.agent || card.session_id || card.depends_on.length > 0;
  const hasTags = card.tags.length > 0;
  if (!hasMeta && !hasTags) return null;
  return (
    <div className="card-meta">
      {card.agent ? <span className={`agent-badge ${card.agent}`}>{card.agent}</span> : null}
      {card.depends_on.length > 0 ? (
        <span className="deps-pill mono" title="depends on">
          {card.depends_on.map((n) => `#${n}`).join(" ")}
        </span>
      ) : null}
      {card.session_id ? (
        <span className="session-pill mono" title={card.session_id}>
          {shortSession(card.session_id)}
        </span>
      ) : null}
      {card.tags.map((tag) => (
        <span key={tag} className="tag-pill">{tag}</span>
      ))}
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

  const forward: Status[] = ["draft", "agent_working", "ready", "done", "deploy"];

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
                    <span className="rules-arrow" aria-hidden="true">↔</span>
                  ) : null}
                </span>
              ))}
            </div>
            <div className="rules-flow-row terminal">
              <span className="rules-source">모든 상태</span>
              <span className="rules-arrow" aria-hidden="true">↔</span>
              <span className="rules-node discarded">discarded</span>
              <span className="rules-terminal-note">(복구 가능)</span>
            </div>
          </div>

          <ul className="rules-notes">
            <li>전진/역방향 모두 한 칸씩만. done/deploy 직행 불가.</li>
            <li>draft → ready 직행도 허용 (agent_working은 건너뛸 수 있다).</li>
            <li>agent_working은 에이전트가 draft를 받아 spec을 다듬는 중인 상태. MCP에서 자동 진입.</li>
            <li>ready로 들어갈 땐 본문(spec) 필수. 비어있으면 거부.</li>
            <li>모든 상태에서 discarded 가능 (draft 포함, 폐기 기록 남김).</li>
            <li>discarded에서도 원하는 활성 상태로 복구 가능. 카드 삭제는 별개 액션.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
