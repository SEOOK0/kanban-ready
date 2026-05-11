# kanban-ready

Lightweight personal kanban (`draft → ready → done → deploy`) running on Cloudflare Workers + D1, with an MCP server so Claude Code and Codex CLI can dispatch work directly from the board.

> **Before you deploy: read [SECURITY.md](./SECURITY.md).**
> Authentication is **IP-allowlist only** (no login, no API key, no per-user isolation), and the Worker IP gate is **fail-open by default**. Without setting up either a Cloudflare WAF rule or the `ALLOWED_IPS` secret, every API endpoint (including `DELETE`) is open to the internet. SECURITY.md has the full threat model, deploy checklist, and gate setup. **Do not skip it.**

- **Stack**: Hono (Workers) + React + Vite + D1
- **Domain**: bring your own (Cloudflare-managed zone) → custom domain binding
- **`workers.dev` URL**: disabled (`workers_dev = false`) — closes the bypass route around your WAF rules

## Documentation map

| Doc | Read when |
|---|---|
| **[SECURITY.md](./SECURITY.md)** | Before your first deploy. Threat model, known limitations, deploy checklist, and IP-gate setup. **Required reading.** |
| [docs/operations.md](./docs/operations.md) | When you get locked out by an IP change, need to back up / restore D1, or are running a schema migration. |
| [docs/mcp-setup.md](./docs/mcp-setup.md) | When wiring the MCP server into Claude Code or Codex CLI. |
| [docs/agent-workflow.md](./docs/agent-workflow.md) | If you're an AI agent (or curious about what one sees). The MCP server serves this via `get_workflows`. |
| [docs/product.md](./docs/product.md) | Product purpose, design principles, anti-references. Read if you're contributing UI changes. |

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

`wrangler.toml` is committed with placeholders (`<your-d1-database-id>`, `kanban.example.com`). Pick one of the two paths below; both assume you've followed the [SECURITY.md deploy checklist](./SECURITY.md#3-deploy-checklist-do-these-before-exposing-the-worker) first.

### Option 1: local deploy (simplest, no CI required)

First-time setup (only once per fork):

```bash
npx wrangler login                       # authenticate with your Cloudflare account
npx wrangler d1 create kanban-ready      # creates the D1 database, prints a database_id
```

Copy the printed `database_id` into `wrangler.toml`, and replace the route host with your own domain:

```toml
routes = [
  { pattern = "kanban.your-domain.com", custom_domain = true }
]

[[d1_databases]]
database_id = "paste-the-id-from-wrangler-d1-create"
```

> The custom domain must already be a zone in your Cloudflare account — `wrangler deploy` will fail if it isn't.

Then deploy:

```bash
npm run db:migrate:remote      # one-time / when schema changes
npm run deploy                 # builds web + wrangler deploy
```

To keep your edited `wrangler.toml` from showing up in git diffs (recommended for forks), run `git update-index --skip-worktree wrangler.toml` after editing.

### Option 2: GitHub Actions auto-deploy on push to main

`.github/workflows/deploy.yml` builds and deploys on every push to `main`. It's gated by `if: github.repository == 'devstefancho/kanban-ready'`, so forks don't trigger doomed deploys. To enable on your fork:

1. Edit the `if:` line in `.github/workflows/deploy.yml` to your `<owner>/<repo>`.
2. Register four secrets in **Settings → Secrets and variables → Actions**:
   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | Token with `Workers Scripts:Edit` + `D1:Edit` for your account |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → right sidebar |
   | `D1_DATABASE_ID` | Output of `wrangler d1 list` for your DB |
   | `PROD_DOMAIN` | The host you want bound (e.g. `kanban.your-domain.com`) |

The workflow's "Inject deploy config" step rewrites `wrangler.toml` placeholders with these secrets at build time. Secrets are passed as env vars (not shell-interpolated) and the rewritten file lives only on the ephemeral runner.

**Schema migrations are still manual** — even with CI deploy, run `npm run db:migrate:remote` from your machine when you add a migration. The CI does *not* run migrations, by design (a bad migration in CI would break prod with no review step).

## Project layout

```
src/
  worker.ts         Cloudflare Workers entry (Hono routes + IP gate + ASSETS fallback)
  core/             Card type, status transitions, D1-backed CRUD, prompt builder
  web/              React + Vite UI (drag-and-drop board)
mcp/
  server.ts         Local stdio MCP server (thin client over the remote API)
migrations/         D1 schema migrations (idempotent)
wrangler.toml       Workers + D1 + Assets + custom domain config (placeholders)
docs/               operations / product / mcp-setup / agent-workflow
```

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/health` | – |
| GET | `/api/whoami` | – (returns your `cf-connecting-ip`) |
| GET | `/api/cards?status=draft\|agent_working\|ready\|done\|deploy\|discarded` | – |
| GET | `/api/cards/:id` | – |
| POST | `/api/cards` | `{title, body?, tags?, status?}` |
| PATCH | `/api/cards/:id` | `{title?, body?, tags?}` |
| POST | `/api/cards/:id/move` | `{status}` |
| DELETE | `/api/cards/:id` | – |
| GET | `/api/cards/:id/prompt` | – (markdown) |
