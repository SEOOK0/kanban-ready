# 다중 에이전트 칸반 설계 노트

이 문서는 kanban-ready를 **여러 AI 에이전트(Claude Code, Codex CLI 등)가 자율적으로 작업을 가져가는 중앙 task pool**로 운영할 때의 설계 기준을 정리한다. 2026-05 시점의 프런티어 사례 조사 + 자체 분석 결과를 기록.

관련 문서:
- 워크플로 규약: [agent-workflow.md](./agent-workflow.md)
- 제품 정의: [product.md](./product.md)

---

## 1. 문제 상황

kanban-ready의 카드 row에는 dispatch 메타 3개가 들어있다 (migration `0005_add_card_meta.sql` 기준):

| 필드 | 의미 |
|---|---|
| `agent` | 작업한 에이전트 종류 (`cc` \| `codex` \| null) |
| `session_id` | 작업한 에이전트 세션 식별자 |
| `depends_on` | 의존하는 카드 번호 배열 |

현재 `moveCard()` / `updateCard()` 로직 (`src/core/store.ts`)은 **last-writer-wins**다 — 새 값이 들어오면 덮어쓴다. 이로 인한 시나리오 한계:

- **순차 인계**: 세션 A가 시작한 카드를 세션 B가 이어받으면 A 흔적이 사라진다.
- **에이전트 협업**: cc가 spec 다듬고 codex가 코드 작업하는 흐름에서, 둘 중 한쪽 정체만 카드에 남는다.
- **감사 불가**: "이 카드를 누가 언제 다뤘는가"에 답할 데이터가 없다.

설계 목표: **카드를 자율적으로 다루는 여러 에이전트가 서로 발을 밟지 않으면서, 누가 무엇을 했는지 추적 가능하게 한다. 규칙은 최소화하고 자율성을 최대화한다.**

---

## 2. 프런티어 사례 조사 (2026-05)

### 2.1 Hermes Kanban (Nous Research) — 가장 직접 참조

- **필수 필드 최소화**: 카드 생성 시 `title` + `assignee` 두 개만 필수. body / deps / workspace / priority / skills 모두 optional.
- **별도 attempt 테이블**: `task_runs` row가 시도마다 하나씩 쌓임 → "full attempt history" 보존.
- **Peer coordination**: *"Any profile reads/writes any task"* — 계층형 위임이 아니라 평등한 work queue.
- **Atomic claim + TTL lease**: dispatcher가 60초 단위로 ready task를 잡고, TTL 만료 시 자동 해제. crashed worker 자동 reclaim.
- **비동기 comment**: worker 재실행 시 전체 comment thread를 컨텍스트로 읽음. 동기 응답 불요.

> "Kanban is a work queue where every handoff is a row any profile (or human) can see and edit."

### 2.2 Cline Kanban / untra/operator / Cursor 3.2

- **Pull-based**: 에이전트가 ready queue에서 self-assign. 중앙 디스패처가 일일이 배정하지 않음.
- **WIP 제한**: max concurrent agents 설정, polling interval로 큐 처리.
- **상태 단순화**: pending / in_progress / completed / blocked 4단계 + 우선순위.

### 2.3 Anthropic Multi-Agent Research System

- Lead가 sub-agent에게 위임할 때 **objective, output format, tool hints, task boundaries** 4개를 명시.
- 파일 시스템이 가장 흔한 조정 메커니즘 (shared files를 읽고 쓰는 방식으로 visibility 확보).
- 다중 에이전트 셋업이 단일 에이전트 대비 90.2% 성능 향상 (단, 토큰 15배).

### 2.4 Addy Osmani — "Code Agent Orchestra"

- **"Fewer rules with stronger enforcement"** — permissive보다 적은 규칙 + 강한 게이트.
- Plan approval gate (코드 작성 전), hard iteration limits, kill criteria (3회 stuck 시 재배정).
- WIP **3–5가 sweet spot** — 의미 있게 리뷰 가능한 수.
- "One file, one owner" — git worktree로 파일 충돌 회피.
- AGENTS.md는 lead만 write — 에이전트가 직접 못 씀.

### 2.5 분산 시스템 패턴 (참고)

- **Heartbeat + lease**: 작업자가 주기적 heartbeat, 없으면 다른 worker가 takeover (AWS leader election).
- **Idempotency key**: 재시도 시 중복 작업 방지.
- **Dead letter queue**: 실패 누적 task는 별도 큐로 격리.

출처: 본 문서 끝의 Sources 섹션 참조.

---

## 3. 공통 설계 원칙 (여러 사례에서 도출)

| 원칙 | 적용 |
|---|---|
| **소프트 신호 vs 하드 락** | `agent_working` 상태는 "지금 누가 손대고 있다"는 신호. 서버는 락을 강제하지 않음. 다른 에이전트가 보고 알아서 비켜선다 |
| **Append-only history** | 카드 row는 "현재 상태", 진실은 별도 이벤트 로그 |
| **명시 의존성** | 실시간 조정이 아니라 `depends_on`으로 사전 분해. 부모 완료 시 자식 자동 ready |
| **WIP는 UI 신호, 서버 강제 X** | 같은 컬럼 카드 수가 많으면 시각적으로 부각, but 서버는 거부하지 않음 |
| **Plan 게이트 1개만, 강하게** | 현재 `agent_working → ready` 전환 시 본문 필수 (`SpecRequiredError`)가 정확히 이 패턴 |
| **에이전트 정체는 자기 신고** | 서버 검증 불가능 (MCP stdio). 도구 description으로 컨벤션만 강제 |
| **파일 소유는 worktree로** | 동일 파일 동시 편집 문제는 git worktree로 격리 (kanban-ready와 별개로 사용 측 책임) |

---

## 4. 옵션 비교 — 3 Tier

### Tier 1. events JSON 컬럼 (최소 변경)

- 카드 row에 `events TEXT NOT NULL DEFAULT '[]'` 컬럼 추가
- 모든 mutation이 events 배열 append
- **장점**: 마이그레이션 1개, 핸들러 변경 작음
- **단점**: 카드 row가 list/show hot path에서 점점 무거워짐. D1 row size 한계도 신경 필요

### Tier 2. card_events 별도 테이블 (채택) ←

- 신규 테이블 `card_events` (card_id FK, at, agent, session_id, action, ...)
- 카드 row의 `agent` / `session_id`는 "현재 owner의 캐시"로 유지
- **장점**: 카드 row가 lean하게 유지됨. 타임라인 UI 구현 깔끔. cross-card 쿼리 (특정 세션이 다룬 카드들) 가능
- **단점**: 마이그레이션 + 신규 핸들러 + UI 변경. Tier 1보다 작업량 큼

### Tier 3. TTL claim + heartbeat (현재는 과함)

- 별도 `POST /api/cards/:id/claim` 엔드포인트, TTL과 heartbeat 도입
- **장점**: 진짜 동시 경합과 좀비 작업 처리
- **단점**: 분산 시스템 복잡도. 1인 사용자 단계엔 불필요

### 채택 사유 (Tier 2)

- 사용 패턴: cc / codex 두 에이전트를 번갈아 쓰는 단계. **실제 동시 경합은 거의 없으나 인계 흔적은 보존 필요.**
- Tier 1은 events가 카드당 누적되면 hot read 비용이 늘어남. row size도 D1 limit 안전하지만 누적되면 위험.
- Tier 3은 worker pool로 다중 에이전트 동시 띄우는 단계 도달 시 검토 (현재 단계엔 YAGNI).

---

## 5. Tier 2 상세 설계

### 5.1 스키마 (`migrations/0006_add_card_events.sql` 예정)

```sql
CREATE TABLE card_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,                -- ISO timestamp
  agent       TEXT,                          -- 'cc' | 'codex' | null
  session_id  TEXT,
  action      TEXT NOT NULL CHECK (action IN
                ('claim','release','status_change','update','complete','comment')),
  from_status TEXT,                          -- for status_change / claim
  to_status   TEXT,                          -- for status_change / claim
  summary     TEXT,                          -- 한 줄 사람 친화 설명
  metadata    TEXT                           -- JSON, action-specific 추가 데이터
);
CREATE INDEX idx_events_card    ON card_events(card_id, at DESC);
CREATE INDEX idx_events_session ON card_events(session_id);
CREATE INDEX idx_events_agent   ON card_events(agent);
```

### 5.2 이벤트 발생 시점

| 트리거 | action | 기록 |
|---|---|---|
| `move_card` → `agent_working` (혹은 메타 갱신) | `claim` | from / to status, agent, session_id |
| 그 외 `move_card` | `status_change` | from / to status, 그때 보낸 agent / session_id |
| `update_card`로 본문 / 제목 / 태그 변경 | `update` | summary에 변경 필드명 |
| `done`로 이동 | `complete` | (status_change에 마킹하거나 별도 row) |
| `agent_working → draft` 손 뗌 | `release` | |

규칙: **모든 mutation은 events insert와 동일 트랜잭션**.

### 5.3 API

| 변경 | 내용 |
|---|---|
| 신규 `GET /api/cards/:id/events?limit=50` | 최신순 events 반환 |
| 기존 `POST /api/cards/:id/move`, `PATCH /api/cards/:id`, `POST /api/cards` | 내부에서 event insert. **외부 시그니처 불변** |

### 5.4 MCP 도구

신규: `list_events({ card_id, limit? }) → events[]`

`start_agent_work` description에 컨벤션 추가:
> Before claiming, if the card is already `agent_working` and `list_events` shows the most recent `claim` is by a different `agent` and `at` < 24h ago, treat the card as in-flight. Do not claim. Either pick a different card or ask the user to confirm a takeover. If the last activity is > 24h old (stale), claiming is fine — a `release` event isn't required.

### 5.5 UI

카드 상세 모달에 **Timeline** 섹션:
```
2026-05-12 14:30   cc        claim       draft → agent_working
2026-05-12 14:35   cc        update      body, tags
2026-05-12 15:10   codex     claim       agent_working → agent_working
2026-05-12 16:02   codex     complete    agent_working → done
```

다른 agent의 두 번째 `claim`은 시각적으로 구분 (색상 / 굵기) — "인계됨" 한눈에 인지.

### 5.6 백필 (선택)

```sql
INSERT INTO card_events (card_id, at, agent, session_id, action, to_status, summary)
SELECT id, updated, agent, session_id, 'claim', status, 'backfill from card row'
FROM cards WHERE agent IS NOT NULL OR session_id IS NOT NULL;
```

안 해도 새 카드부터 정상 작동.

### 5.7 작업 분해

| Phase | 작업 |
|---|---|
| P1 | migration 0006, 타입, `appendEvent` helper |
| P2 | move / update / create에 event emit 통합 (트랜잭션) |
| P3 | `GET /events` 엔드포인트 + `list_events` MCP |
| P4 | UI Timeline 섹션 |
| P5 | 백필 SQL, MCP description, agent-workflow.md 갱신 |
| P6 | 운영 배포 + cc / codex 인계 시나리오 e2e 검증 |

---

## 6. 미정 / 미래 결정 사항

### 6.1 이벤트 정리 정책
- 현재 결정: **무제한 보관**. D1 row가 가볍고 카드당 typical 20개 이하 예상.
- 향후 카드당 100+ 누적되거나 cross-card 통계가 필요해지면 archive / aggregate 정책 도입.

### 6.2 `comment` action
- 스키마에는 자리 잡고 실 사용은 후속 카드로 미룸. UI / MCP에서 comment 쓰는 흐름이 아직 정의 안 됨.

### 6.3 `session_id` 자동 채움
- 현재 호출자(에이전트)가 직접 채우는 컨벤션 유지.
- Claude Code / Codex CLI가 환경변수(`$CLAUDE_SESSION_ID` 등)로 노출하면 자동화 가능 — 환경 변화 의존.
- 임시 대안: 워크스페이스 경로 hash 사용 (세션 ≠ 워크스페이스이므로 의미 약함).

### 6.4 Tier 3 (TTL claim) 진입 시점
- 동시 경합이 실제 발생할 때:
  - cc / codex 외 에이전트가 추가되어 3개 이상 worker pool 운영
  - 사용자가 카드 우선순위 큐 기반 자동 dispatch 시작
- 그 전엔 Tier 2의 컨벤션-기반 인계로 충분.

### 6.5 `agent_working` 24시간 stale 표시
- UI에서 `updated` > 24h인 `agent_working` 카드는 옅게 / 배지로 stale 신호.
- Tier 2 이벤트 로그가 들어오면 더 정확하게 "마지막 활동 X시간 전" 표시 가능.
- 별건 UI 작업.

### 6.6 에이전트 검증
- 서버는 `agent` 값 진위 검증 불가 (cc라 자칭하는 다른 클라이언트 막을 수 없음).
- 운영 전제: IP gate + 사용자 본인만 접근 (`SECURITY.md`). 외부 위협 모델은 IP gate에 위임.

---

## 7. 검증된 가설 / 폐기한 옵션

### 검증됨
- **last-writer-wins 동작**: v2 통합 테스트 (`test_v2_meta_filled.sh` 18/18 통과)로 확인. `start_agent_work` 재호출 시 메타 덮어씀, 메타 없는 move는 보존.
- **에이전트 정체는 클라이언트 신고에 의존**: 서버 검증 불가, MCP description으로만 컨벤션 안내.

### 폐기
- **`agent` enum에 `cc+codex` 같은 합성값 추가**: 협업 표시 가능하나 "누가 언제 들어왔는가" 분실. Tier 2가 상위호환.
- **events를 카드 row의 JSON 배열로**: row size 성장 + hot path 비용 우려로 Tier 2로 이동.

---

## Sources

- [Hermes Kanban — Multi-Agent Board](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Addy Osmani — The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- [Anthropic — Multi-Agent Coordination Patterns](https://claude.com/blog/multi-agent-coordination-patterns)
- [Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Cursor 3.2 — Agent Execution Runtime / multitask](https://futurumgroup.com/insights/cursor-3-2-reframes-the-ide-as-an-agent-execution-runtime/)
- [Augment Code — 9 Open-Source Agent Orchestrators (2026)](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [LogRocket — Why your AI agent needs a task queue](https://blog.logrocket.com/ai-agent-task-queues/)
- [AWS Builders' Library — Leader election in distributed systems](https://d1.awsstatic.com/builderslibrary/pdfs/leader-election-in-distributed-systems.pdf)
- [Cline Kanban](https://cline.bot/kanban)
- [untra/operator — Multi-agent orchestration with markdown tickets](https://github.com/untra/operator)
