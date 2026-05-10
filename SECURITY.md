# Security Model & Deployment Constraints

> **Read this before deploying.** This project is intentionally minimal and ships with a security model that fits *one specific use case*. If your use case is different, the defaults here can leave you exposed.

---

## 1. Threat model & assumptions

This project is designed for **a single operator running their own instance for personal use**. The entire security posture relies on that assumption.

| Assumption | What it means in practice |
|---|---|
| Single user | There is no concept of "user accounts." Every request that gets past the IP gate has full read/write/delete on every card. |
| Operator owns the deploy | You control the Cloudflare account, the domain, the WAF rules, and `wrangler secret`. There is no admin/non-admin split. |
| Card content is yours | Cards are stored as plaintext in D1. Don't put anything in them you wouldn't put in a notes app on your laptop. |
| Trust boundary = IP allowlist | The only thing standing between the open internet and your full CRUD API is the IP allowlist (Cloudflare WAF and/or `ALLOWED_IPS` secret). |

**If any of those assumptions don't hold for you, the default configuration is not safe.** See [§4 If you want multi-user](#4-if-you-want-multi-user).

---

## 2. Known limitations (what this project does NOT do)

These are not bugs. They're explicit non-features. Read them before running.

### 2.1 Authentication is IP-based only

There is **no login, no session, no API key, no OAuth**. The only authentication signal is the source IP from `cf-connecting-ip`.

Implications:
- Anyone on the **same NAT'd network** as you (same household, same coffee shop wifi, same office) appears with the same public IP and is fully authenticated as "you."
- If your home IP rotates (most Korean ISPs), you lose access until you update the allowlist. There is no fallback identity.
- Mobile data, VPNs, travel — all require allowlist updates or temporary rule disable.

### 2.2 Worker IP gate is fail-open by default

`src/worker.ts` has this:

```ts
if (!raw) return next();   // ALLOWED_IPS empty/unset → request passes
```

If you deploy without setting the `ALLOWED_IPS` secret **and** without a Cloudflare WAF rule, **every API endpoint is open to the internet**, including `DELETE /api/cards/:id`.

This is a deliberate trade-off (the operator can temporarily disable the gate without redeploying), but it means **first-time deploys are dangerous**. See the deploy checklist in §3.

### 2.3 No per-endpoint authorization

Once a request passes the IP gate, every API endpoint is callable. There is no "read-only" mode, no separate admin path, no rate limiting beyond what Cloudflare provides at the edge.

### 2.4 No input size limits

`title`, `body`, and `tags` are accepted at any size. A single 100MB POST is allowed. Combined with the absence of rate limiting, this means **anyone past the IP gate can exhaust your D1 free-tier quota** (50K writes/day, 5GB total) trivially.

### 2.5 Plaintext storage and backups

- Card content is stored unencrypted in Cloudflare D1.
- Backups produced by `wrangler d1 export` are plaintext SQL files.
- `.gitignore` blocks `backup-*.sql` from being committed, but you must store the backup files themselves somewhere safe (don't drop them in shared cloud folders).

### 2.6 No audit log

Cards have `created`/`updated` timestamps but no history. Deletes are hard deletes. If someone breaches the IP gate and wipes the table, your only recovery is your last manual backup.

### 2.7 The MCP server is unauthenticated stdio

`mcp/server.ts` is a thin client that calls the remote API. Anyone who can run that script on your machine can hit your board. This matters if you share an MCP config across machines or commit one to a multi-user environment — the URL alone is enough to call the API (still subject to the IP gate of the calling machine).

---

## 3. Deploy checklist (do these before exposing the worker)

Before you `wrangler deploy` for the first time, all of these must be true:

- [ ] **`workers_dev = false` in `wrangler.toml`** (already set in this repo). This closes the `<account>.workers.dev` backdoor that bypasses your custom-domain WAF rules.
- [ ] **At least one of**:
  - A Cloudflare WAF Custom Rule blocking everything except your IP(s) on the host (see [README §Access control](./README.md#access-control-waf--worker-level-fallback)), **or**
  - `ALLOWED_IPS` Worker secret set with your IP(s): `npx wrangler secret put ALLOWED_IPS`.
  - Setting **both** is recommended (defense in depth — one as the platform-level block, one as code-level fallback).
- [ ] **Verify the gate from outside**: after deploying, visit the URL from a network that is *not* on the allowlist (e.g. mobile data with wifi off). You should get Cloudflare 1020 (WAF block) or HTTP 403 (worker block). If you get a normal response, **the gate is not active — stop and fix it before continuing**.
- [ ] **`/api/whoami`**: from your allowed network, hit `https://<your-domain>/api/whoami`. The returned IP should match what's in your allowlist. If it doesn't, your WAF rule will silently block you next.
- [ ] **First deploy is a destructive write surface**: don't put real card content in until the above checks pass. A blank board is a cheap recovery point.

If your IP rotates and you lock yourself out, see [RUNBOOK §1](./RUNBOOK.md#1-본인이-차단당했을-때-집-ip-변경).

---

## 4. If you want multi-user

This project is **not** suitable as-is for shared use (team kanban, public SaaS, "just our 3 friends"). To make it safe for multiple users you would need to add, at minimum:

1. **Real authentication** — OAuth (e.g. Cloudflare Access, Auth0, GitHub OAuth) or a session-based login. The IP gate is not a substitute.
2. **Per-user data isolation** — the `cards` table has no `owner` / `user_id` column. Every user would see and edit every card. Adding ownership requires a migration plus authorization checks in `src/core/store.ts`.
3. **Rate limiting** — Cloudflare's free tier offers some, but you'll want explicit per-user limits to prevent quota exhaustion.
4. **Audit logging** — at minimum a `card_history` table or a write log, so you can answer "who deleted that?"
5. **Input validation** — explicit length caps on `title`, `body`, `tags` to prevent abuse.

These are non-trivial changes. If you just need a personal task queue, the current single-user design is the right fit; if you need shared use, you're better off forking and treating the existing code as a starting skeleton, not a production app.

---

## 5. Reporting a vulnerability

If you find a security issue in this codebase (not in your own deployment configuration — that's on you), please open an issue on the GitHub repo with the label `security`, or contact the maintainer privately if the issue is sensitive.

This is a personal project maintained best-effort. There is no SLA on response times.
