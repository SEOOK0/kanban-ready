# MCP server setup

Local stdio MCP server in `mcp/server.ts` lets Claude Code and Codex CLI call the kanban board directly — pull a Ready card's prompt, mark it Done after finishing, capture new ideas as Draft cards.

The agent-side workflow (transition rules, dispatch flow, tool sequencing) is defined in [agent-workflow.md](./agent-workflow.md), which the agent fetches via `get_workflows` at session start.

> **Network**: the MCP server hits the API at `KANBAN_API_URL` (required — set it to your deployed worker URL or `http://localhost:8787` for local dev). The IP gate / WAF rules apply — your machine must be on an allowlisted IP. See [SECURITY.md §4](../SECURITY.md#4-setting-up-the-ip-gate).

---

## Why MCP (vs. a Claude Code skill)

이 보드는 **Claude Code와 Codex CLI 양쪽에서 동일하게** 쓰이는 게 전제다. MCP는 두 클라이언트가 공유하는 표준 프로토콜이라 한 번 정의하면 양쪽에 그대로 등록된다. Skill로 만들었다면 Claude 생태계에 묶여 Codex에서 다시 만들어야 했다.

트레이드오프:
- MCP는 schema가 시작 시점에 lock — 코드를 바꿔도 서버 프로세스를 재시작해야 반영.
- 호스트와 격리된 process라 RPC tool 표면 안에서만 동작. 복잡한 절차(여러 tool 조합·분기)는 호스트 모델이 조립하거나 [agent-workflow.md](./agent-workflow.md)로 가이드한다.

이식성·외부 자동화 우선이므로 이 트레이드오프는 받아들인다.

---

## Tools

| Tool | Purpose |
|---|---|
| `get_workflows` | Read [agent-workflow.md](./agent-workflow.md) — call once at session start |
| `list_cards` | List cards, optionally filtered by status |
| `get_card` | Read a card's full content (title, status, tags, body) |
| `get_prompt` | Fetch the AI-ready prompt text for a card id |
| `create_card` | Capture a new card (defaults to draft) |
| `update_card` | Edit a card's title / body / tags (status via `move_card`) |
| `move_card` | Move a card across `draft → ready → done → deploy` (or any → `discarded`) |

---

## Run locally

```bash
KANBAN_API_URL=https://kanban.your-domain.com npm run mcp:dev    # against deployed worker
# or
KANBAN_API_URL=http://localhost:8787 npm run mcp:dev              # against `npm run dev:worker`
```

`KANBAN_API_URL` is required. The server validates it (must be a valid `https:` URL, or `http://localhost`) and refuses to start otherwise — this prevents accidentally pointing at a typo'd or attacker-controlled host.

---

## Register with Claude Code

CLI (user scope, absolute path — works from any directory):

```bash
claude mcp add kanban-ready --env KANBAN_API_URL=https://kanban.your-domain.com -- npx tsx /path/to/kanban-ready/mcp/server.ts
```

Or commit a `.mcp.json` at the repo root (project scope, auto-loaded when Claude Code runs from this directory). The `env` block is **required** — replace the placeholder host with your own deployed worker:

```json
{
  "mcpServers": {
    "kanban-ready": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "env": { "KANBAN_API_URL": "https://kanban.your-domain.com" }
    }
  }
}
```

For a local worker (`npm run dev:worker`), use `http://localhost:8787` instead.

---

## Register with Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.kanban-ready]
command = "npx"
args = ["tsx", "/path/to/kanban-ready/mcp/server.ts"]
env = { KANBAN_API_URL = "https://kanban.your-domain.com" }
```

After registering, ask the agent: *"보드의 ready 카드 하나 가져와서 작업하고 끝나면 done으로 옮겨줘."*
