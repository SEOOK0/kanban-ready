# Workflows

이 문서는 AI agent (Claude/Codex via MCP)가 `kanban-ready`로 작업할 때 따르는 동선을 정의한다. 사람이 GUI로 쓰는 흐름과 별개로, **MCP에서 카드를 처리할 때만 적용**된다.

새 세션을 시작할 때 `get_workflows`를 한 번 호출해서 이 문서를 받아두는 것을 전제로 한다.

---

## 1. 상태와 전이

```
draft ──┬── agent_working ── ready ── done ── deploy
        └───────────────────> ready

discarded는 모든 상태에서 들어갈 수 있고, 다시 원하는 활성 상태로 복구할 수 있다.
```

| 상태 | 의미 |
|---|---|
| `draft` | 막 떠오른 아이디어. 구체화 안 됨. AI에 던질 수 없는 단계. |
| `agent_working` | 에이전트가 draft를 받아 spec을 다듬는 중. 보드에 "작업중" 신호를 띄우는 상태. MCP에서 `start_agent_work`로 자동 진입. |
| `ready` | AI가 바로 작업 시작 가능한 spec. 본문에 충분한 컨텍스트 포함. |
| `done` | AI 작업 완료 (PR merge 등). 배포 대기. |
| `deploy` | production 반영됨. |
| `discarded` | 폐기 (의도적 폐기 + 롤백 모두 포함). 필요하면 활성 상태로 복구 가능. |

전이 규칙:
- 전진/역방향은 한 칸씩만. `draft → done`, `done → agent_working` 같은 직행 불가.
- `draft → ready` 직행도 허용 (agent_working을 건너뛸 수 있다). agent가 작업한다는 신호가 필요할 때만 agent_working을 거친다.
- `draft → agent_working`은 본문이 비어있어도 통과한다 (spec 작성을 시작하는 단계).
- 어떤 상태에서든 `ready`로 들어갈 땐 본문이 비어있으면 거부된다 (`Insufficient spec`). spec/task를 먼저 채워야 한다.
- 모든 상태에서 `discarded` 가능 (draft 포함, 폐기 기록 남김).
- `discarded`에서도 원하는 활성 상태로 복구 가능. 복구할 때도 `ready`로 들어가면 본문 필수 규칙이 적용된다.

---

## 2. 표준 동선 (작업 dispatch)

처리 흐름은 항상 **사용자의 명시적 지시에서 시작**한다. agent가 자동으로 다음 단계를 건너뛰지 않는다. 사용자가 "이 카드 작업해줘"라고 해야 spec/task 작성을 시작하고, "코드 작업해줘"라고 해야 코드를 건드린다.

### 2.1 Step-by-step (draft에서 시작)

**Step 1. 카드 내용 확인**
- 사용자가 카드를 지목하면 `get_card(id)`로 본문을 읽는다.
- 본문이 비어있으면 사용자와 대화하여 무엇을 만들 것인지 구체화한다. agent가 추측으로 본문을 채우지 않는다.

**Step 2. 작업 시작 신호 → agent_working으로 이동 (메타 자가 보고)**
- 사용자가 "이 카드 작업해줘" 식으로 요청하면 **먼저 `start_agent_work`를 호출**한다. 보드에서 카드가 Agent Working 컬럼으로 이동해 사용자에게 진행중임이 즉시 보인다.
- 인자는 반드시 본인 정체를 함께 넘긴다:
  - `id` — 카드 id
  - `agent` — 본인이 누구인지. Claude Code면 `"cc"`, Codex CLI면 `"codex"`.
  - `session_id` — 본인의 현재 세션 id. Claude Code는 활성 세션 UUID (`.claude/projects/.../<uuid>.jsonl`의 파일명), Codex CLI는 rollout 파일의 UUID 부분.
  - `depends_on` — (선택) 이 카드가 의존하는 다른 카드 번호 배열 (`[3, 7]`). 모르면 생략.
- 호출 예: `start_agent_work({ id: "2026-05-11-...", agent: "cc", session_id: "6b1644b1-f461-49db-b47e-2d0b0bcfd5c0" })`.
- 이 호출 한 번으로 카드에 `agent` / `session_id` / `depends_on` 이 atomic하게 기록되고 status는 `agent_working`이 된다. 사용자가 모달을 열면 누가 작업중인지가 메타에 보인다.
- 이 단계에서 body가 비어있어도 OK. spec 작성은 다음 step에서.

**Step 3. spec / task 작성**
- 본문에 다음 두 항목을 추가한다:
  - **Spec**: 무엇을 만들 것인가 (목표, 제약, 완료 조건)
  - **Task**: 어떻게 할 것인가 (단계별 체크리스트)
- 본문 갱신은 `update_card`. 작성 후 사용자에게 보여 confirm을 받는다.

**Step 4. Ready로 이동**
- spec/task가 본문에 들어있고 사용자 confirm을 받았으면 `move_card(id, "ready")`.
- 본문이 비어있으면 서버가 transition을 거부한다 (`Insufficient spec`). 그러면 Step 3부터 다시.

**Step 5. 코드 작업 — 사용자의 별도 요청 후**
- 사용자가 "코드 작업 진행해줘" 식으로 요청해야 시작한다. ready 진입만으로 자동 시작하지 않는다.
- 호스트 도구 (Read/Write/Edit/Bash)로 카드 spec에 따라 변경을 적용한다. 검증 (테스트, typecheck 등)까지 통과시킨다.

**Step 6. Done으로 이동**
- 코드 변경 + 검증 완료 후 `move_card(id, "done")`.

**Step 7. Deploy로 이동 (선택)**
- 실제 production 반영 후 `move_card(id, "deploy")`. 보통 사람이 배포까지 한 뒤 별도로 옮긴다.

> agent_working을 건너뛰고 싶을 때 (spec이 이미 본문에 충분히 들어있고 작업중 신호가 필요 없을 때): Step 2를 생략하고 곧장 `move_card(id, "ready")`로 가도 된다. 분기는 허용된다.

### 2.2 한 호흡으로 끝까지

사용자가 "이 카드 끝까지 가줘" 식으로 요청하면:

- **draft인데 body 충분**: Step 2 (`start_agent_work`) → 3 (spec/task 보강) → 4 (ready) → 5 (코드) → 6 (done) 까지 한 흐름. body가 이미 충분하면 Step 2를 생략하고 곧장 ready로 가도 된다 (분기 허용).
- **agent_working에서 이어 받음**: Step 3 → 4 → 5 → 6 까지 한 흐름.
- **ready인데 spec 충분**: Step 5 → 6 까지 한 흐름.

단 한 칸씩 이동 규칙은 그대로. done/deploy 직행은 안 된다. 중간에 사용자가 멈출 의도를 표현하면 즉시 멈춘다.

### 2.3 ready 카드 둘러보기

처리할 카드를 고르려고 둘러볼 때는 `list_cards(status: "ready")`로 후보 목록부터 본다. 본문 전체가 필요하면 `get_card`, AI에 그대로 던질 prompt 텍스트만 필요하면 `get_prompt`.

---

## 3. 새 카드 생성 (대화 중 발견)

대화 중 새 작업·아이디어가 떠오르면 `create_card`로 일단 던져둔다.

- **즉시 처리 안 함**: `status: "draft"` (기본값). 나중에 Step 1~3을 거쳐 ready로 옮긴다.
- **이미 충분히 구체화됨**: title + body를 채워서 `status: "draft"`로 만든 뒤 사용자 지시로 ready 이동. body 없이 ready로 직행 시도하면 가드에 막힌다.

draft에 던질 때는 title 한 줄로도 충분.

---

## 4. 폐기 / 롤백

`discarded`는 두 가지를 모두 흡수한다.

- 안 하기로 결정한 작업: `draft`/`ready` 카드를 `move_card(id, "discarded")`.
- 배포 후 롤백: `done`/`deploy` 카드를 `move_card(id, "discarded")`.

실수로 폐기했거나 다시 살릴 일이 생기면 `discarded`에서 필요한 활성 상태로 `move_card`를 호출해 복구한다. 단, `ready`로 바로 복구하려면 본문(spec)이 비어있지 않아야 한다.

draft 정리는 `discarded`로 쌓지 말고 그냥 dashboard에서 사람이 hard delete 한다 (MCP에서 delete는 노출하지 않는다).

---

## 5. ID and number

각 카드에는 두 가지 식별자가 붙는다:

- **`id`** — `YYYY-MM-DD-slugified-title` 형식으로 자동 생성 (예: `2026-05-09-d1-백업-스케줄`). 같은 날 같은 제목이면 `-2`, `-3` suffix. tool 호출에 쓰는 정식 키.
- **`number`** — 카드 생성 순서대로 1부터 매겨지는 monotonic 번호 (`#1`, `#2`, ...). 짧아서 사람이 가리키기 좋다 ("3번 카드 작업해줘").

`list_cards`/`get_card`/`move_card`/`create_card` 출력에 모두 `#N` 표기가 포함된다. 사용자가 "#3" 식으로 가리키면 `list_cards` 결과에서 매칭해 정식 `id`를 찾은 뒤 다른 tool에 넘긴다.

ID는 사람이 읽을 수 있고 안정적이라 prompt나 커밋 메시지에 그대로 인용해도 된다.

---

## 6. 톤 (`product.md` 발췌)

격려하거나 축하하지 않는다. 빈 상태에 위로 카피 안 둔다. 한국어 마이크로카피 OK. 자세한 건 [`product.md`](./product.md).
