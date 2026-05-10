# kanban-ready

Lightweight personal kanban (`draft → ready → done`) running on Cloudflare Workers + D1.

> **Before you deploy: read [SECURITY.md](./SECURITY.md).**
> This project is designed for **a single operator**. Authentication is **IP-allowlist only** (no login, no API key, no per-user isolation). The Worker-level IP gate is **fail-open by default** — if you deploy without setting up either a Cloudflare WAF rule or the `ALLOWED_IPS` secret, every API endpoint (including `DELETE`) is open to the internet. SECURITY.md has the full threat model, known limitations, and a deploy checklist. **Do not skip it.**

- **Stack**: Hono (Workers) + React + Vite + D1
- **Domain**: bring your own (Cloudflare-managed zone) → custom domain binding
- **workers.dev URL**: disabled (`workers_dev = false`)

## Local development

```bash
npm install
npm run db:migrate:local       # apply schema to local D1
npm run build                  # build the React UI into dist/web
npm run dev:worker             # start wrangler dev on :8787

# (optional) hot-reload UI on :5173 with /api proxied to :8787
npm run dev:web
```

## Deploy

```bash
npm run db:migrate:remote      # one-time / when schema changes
npm run deploy                 # builds web + wrangler deploy
```

## Project layout

```
src/
  worker.ts         Cloudflare Workers entry (Hono routes + IP gate + ASSETS fallback)
  core/
    paths.ts        Status type
    card.ts         Card type, slug/id helpers
    store.ts        D1-backed CRUD
    prompt.ts       buildPrompt(card) for Claude/Codex paste
  web/              React + Vite UI (drag-and-drop board)
mcp/
  server.ts         Local stdio MCP server (thin client over the remote API)
migrations/
  0001_init.sql     cards table schema
wrangler.toml       Workers + D1 + Assets + custom domain config
```

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/health` | – |
| GET | `/api/whoami` | – (returns your `cf-connecting-ip`) |
| GET | `/api/cards?status=draft\|ready\|done` | – |
| GET | `/api/cards/:id` | – |
| POST | `/api/cards` | `{title, body?, tags?, status?}` |
| PATCH | `/api/cards/:id` | `{title?, body?, tags?}` |
| POST | `/api/cards/:id/move` | `{status}` |
| DELETE | `/api/cards/:id` | – |
| GET | `/api/cards/:id/prompt` | – (markdown) |

## MCP server (Claude Code / Codex)

Local stdio MCP server in `mcp/server.ts` lets Claude Code and Codex CLI call the board directly — pull a Ready card's prompt, mark it Done after finishing, capture new ideas as Draft cards. Card lifecycle and standard dispatch flow are defined in [WORKFLOWS.md](./WORKFLOWS.md), which agents fetch via `get_workflows` at session start.

### Why MCP (vs. a Claude Code skill)

이 보드는 **Claude Code와 Codex CLI 양쪽에서 동일하게** 쓰이는 게 전제다. MCP는 두 클라이언트가 공유하는 표준 프로토콜이라 한 번 정의하면 양쪽에 그대로 등록된다. Skill로 만들었다면 Claude 생태계에 묶여 Codex에서 다시 만들어야 했다.

트레이드오프:
- MCP는 schema가 시작 시점에 lock — 코드를 바꿔도 서버 프로세스를 재시작해야 반영.
- 호스트와 격리된 process라 RPC tool 표면 안에서만 동작. 복잡한 절차(여러 tool 조합·분기)는 호스트 모델이 조립하거나 [WORKFLOWS.md](./WORKFLOWS.md)로 가이드한다.

이식성·외부 자동화 우선이므로 이 트레이드오프는 받아들인다.

### Tools

| Tool | Purpose |
|---|---|
| `get_workflows` | Read [WORKFLOWS.md](./WORKFLOWS.md) — call once at session start |
| `list_cards` | List cards, optionally filtered by status |
| `get_card` | Read a card's full content (title, status, tags, body) |
| `get_prompt` | Fetch the AI-ready prompt text for a card id |
| `create_card` | Capture a new card (defaults to draft) |
| `update_card` | Edit a card's title / body / tags (status via `move_card`) |
| `move_card` | Move a card across `draft → ready → done → deploy` (or any → `discarded`) |

It hits the remote API (`https://kanban.example.com` by default; override with `KANBAN_API_URL` env var), so the IP gate / WAF rules above apply — your machine must be on an allowlisted IP.

### Run locally

```bash
npm run mcp:dev    # tsx mcp/server.ts (stdio)
```

### Register with Claude Code

CLI (user scope, absolute path — works from any directory):

```bash
claude mcp add kanban-ready -- npx tsx /path/to/kanban-ready/mcp/server.ts
```

Or commit a `.mcp.json` at the repo root (project scope, auto-loaded when Claude Code runs from this directory):

```json
{
  "mcpServers": {
    "kanban-ready": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"]
    }
  }
}
```

To point at a local worker instead of the deployed one, add an `env` block:

```json
{
  "mcpServers": {
    "kanban-ready": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "env": { "KANBAN_API_URL": "http://localhost:8787" }
    }
  }
}
```

### Register with Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.kanban-ready]
command = "npx"
args = ["tsx", "/path/to/kanban-ready/mcp/server.ts"]
```

After registering, ask the agent: *"보드의 ready 카드 하나 가져와서 작업하고 끝나면 done으로 옮겨줘."*

## Access control: WAF + Worker-level fallback

> See [SECURITY.md §3](./SECURITY.md#3-deploy-checklist-do-these-before-exposing-the-worker) for the full deploy checklist and verification steps. The setup below is *how* to configure the gate; SECURITY.md is *why* and *what to verify*.

Two layers; either alone is enough, but you should stack both for defense-in-depth. Without at least one of them active, the API is open to the internet.

### Find your home IP

```bash
curl https://kanban.example.com/api/whoami
# or
curl ifconfig.me; echo
curl -6 ifconfig.me; echo   # IPv6 (if your ISP gives one)
```

### Layer 1 (recommended): Cloudflare WAF Custom Rule

Free plan includes 5 custom rules per zone — plenty for personal use.

1. https://dash.cloudflare.com → **Websites → example.com**.
2. **Security → WAF → Custom rules → Create rule**.
3. Name: `kanban home only`.
4. Use the *Edit expression* mode and paste:
   ```
   (http.host eq "kanban.example.com") and not (ip.src in {203.0.113.10})
   ```
   Replace `203.0.113.10` with your home IPv4 from `/api/whoami`. Add IPv6 inside the same set if you have one: `{203.0.113.10 2001:xxxx::/64}`.
5. **Action: Block**.
6. Save.

Anyone outside the listed IPs gets a Cloudflare 1020 block page before the request reaches the Worker.

### Layer 2: Worker-level secret (`ALLOWED_IPS`)

Already wired into `src/worker.ts`. Empty/unset = pass-through. Set the secret to activate:

```bash
npx wrangler secret put ALLOWED_IPS
# paste comma-separated IPs (no spaces): 203.0.113.10,2001:xxx::/64
```

Unset to disable:
```bash
npx wrangler secret delete ALLOWED_IPS
```

## Why this stack

- **Hono** is the de-facto Workers framework — same code runs locally and on the edge.
- **D1** (SQLite at the edge) gives free 5GB / 25M reads / 50K writes per day — far beyond personal use.
- **Workers Assets** serves the SPA without a separate CDN. `run_worker_first = true` routes every request through the Worker for the IP gate; non-matching paths fall through to `c.env.ASSETS.fetch()`.
- **Custom domain** removes the `<account-subdomain>.workers.dev` exposure and unlocks zone-level WAF rules.

## Operations

자주 마주칠 두 가지 상황 — **집 IP 변경으로 본인이 차단됐을 때** 복구 절차와 **D1 데이터 백업/복구** — 은 [RUNBOOK.md](./RUNBOOK.md)에 정리했습니다.

## Migration history

| | |
|---|---|
| `0.1.0` | Local Node CLI + Hono server, markdown files in `~/kanban/` |
| `0.2.0` | Cloudflare Workers + D1, web-only |
| `0.2.1` | Custom domain `kanban.example.com`, IP gate (Worker + WAF) |
