# kanban-ready

Lightweight personal kanban (`draft → ready → done`) running on Cloudflare Workers + D1.

- **Live URL**: https://kanban.example.com
- **Stack**: Hono (Workers) + React + Vite + D1
- **Domain**: `example.com` (Cloudflare-managed) → `kanban.example.com` via custom domain binding
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

Local stdio MCP server in `mcp/server.ts` lets Claude Code and Codex CLI call the board directly — pull a Ready card's prompt, mark it Done after finishing, capture new ideas as Draft cards.

### Tools

| Tool | Purpose |
|---|---|
| `list_cards` | List cards, optionally filtered by status |
| `get_prompt` | Fetch the AI-ready prompt text for a card id |
| `move_card` | Move a card to draft / ready / done |
| `create_card` | Capture a new card (defaults to draft) |

It hits the remote API (`https://kanban.example.com` by default; override with `KANBAN_API_URL` env var), so the IP gate / WAF rules above apply — your machine must be on an allowlisted IP.

### Run locally

```bash
npm run mcp:dev    # tsx mcp/server.ts (stdio)
```

### Register with Claude Code

```bash
claude mcp add kanban-ready -- npx tsx /path/to/kanban-ready/mcp/server.ts
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

Two layers; either alone is enough, but you can stack both for defense-in-depth.

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
