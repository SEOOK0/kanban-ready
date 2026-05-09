# Workflows

이 문서는 AI agent (Claude/Codex via MCP)가 `kanban-ready`로 작업할 때 따르는 동선을 정의한다. 사람이 GUI로 쓰는 흐름과 별개로, **MCP에서 카드를 처리할 때만 적용**된다.

새 세션을 시작할 때 `get_workflows`를 한 번 호출해서 이 문서를 받아두는 것을 전제로 한다.

---

## 1. 상태와 전이

```
draft → ready → done → deploy
                            ↘
                       discarded (모든 상태에서 가능, 종착)
```

| 상태 | 의미 |
|---|---|
| `draft` | 막 떠오른 아이디어. 구체화 안 됨. AI에 던질 수 없는 단계. |
| `ready` | AI가 바로 작업 시작 가능한 spec. 본문에 충분한 컨텍스트 포함. |
| `done` | AI 작업 완료 (PR merge 등). 배포 대기. |
| `deploy` | production 반영됨. |
| `discarded` | 폐기 (의도적 폐기 + 롤백 모두 포함). 종착지, 복원 불가. |

전이 규칙:
- 전진은 한 칸씩만. `draft → done` 같은 직행 불가.
- 모든 상태에서 `discarded` 가능 (draft 포함, 폐기 기록 남김).
- 역방향 이동 없음. 다시 작업할 거면 새 카드 생성.

전이 규칙을 위반하면 `move_card`가 `Invalid transition` 에러로 거부한다.

---

## 2. 표준 동선 (작업 dispatch)

처리할 카드 한 장을 끝까지 가져가는 흐름.

1. `list_cards(status: "ready")` → 처리 가능한 카드 목록 확인.
2. 우선순위 하나 고른 뒤 `get_prompt(id)` → 카드의 prompt 텍스트 받음.
3. 받은 prompt 기준으로 실제 작업 수행 (코드 작성, 변경 적용 등).
4. 작업이 끝나면 `move_card(id, "done")`.
5. 실제 production 반영까지 했다면 별도로 `move_card(id, "deploy")`.

`list_cards()`(status 없이)는 모든 상태를 반환한다. 보통 `ready`만 보면 충분.

---

## 3. 새 카드 생성 (대화 중 발견)

대화 중 새 작업·아이디어가 떠오르면 `create_card`로 일단 던져둔다.

- **즉시 처리 안 함**: `status: "draft"` (기본값). 사람이 나중에 구체화해서 ready로 옮긴다.
- **이미 충분히 구체화됨**: `status: "ready"` 로 직행 가능. 단, 본문에 컨텍스트가 충분해야 한다 (다른 agent가 그 카드만 보고도 시작할 수 있을 정도).

draft에 던질 때는 title 한 줄로도 충분. ready로 만들 때는 body에 배경/제약/완료 조건을 적어둔다.

---

## 4. 폐기 / 롤백

`discarded`는 두 가지를 모두 흡수한다.

- 안 하기로 결정한 작업: `draft`/`ready` 카드를 `move_card(id, "discarded")`.
- 배포 후 롤백: `done`/`deploy` 카드를 `move_card(id, "discarded")`.

복원은 안 된다. 다시 살릴 일이 생기면 새 카드를 생성하고 본문에 이전 카드 id를 참조로 적는다.

draft 정리는 `discarded`로 쌓지 말고 그냥 dashboard에서 사람이 hard delete 한다 (MCP에서 delete는 노출하지 않는다).

---

## 5. ID convention

`YYYY-MM-DD-slugified-title` 형식으로 자동 생성된다 (예: `2026-05-09-d1-백업-스케줄`). 같은 날 같은 제목이면 `-2`, `-3` suffix.

ID는 사람이 읽을 수 있고 안정적이라 prompt나 커밋 메시지에 그대로 인용해도 된다.

---

## 6. 톤 (`PRODUCT.md` 발췌)

격려하거나 축하하지 않는다. 빈 상태에 위로 카피 안 둔다. 한국어 마이크로카피 OK. 자세한 건 `PRODUCT.md`.
