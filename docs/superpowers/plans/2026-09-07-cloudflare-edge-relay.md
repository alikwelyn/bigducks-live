# Cloudflare Edge Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay Activity WebSocket media through a room-scoped Cloudflare Durable Object near users instead of the German VPS.

**Architecture:** Keep OAuth and signed session issuance on Node. Validate those signed tokens at a Worker route, then coordinate each room in a hibernation-aware Durable Object. Clients prefer the edge route and retain the Node relay as connection fallback.

**Tech Stack:** Cloudflare Workers, Durable Objects, WebSocket Hibernation API, JavaScript, Vitest, Wrangler.

---

### Task 1: Token verification

**Files:**
- Create: `activity/edge-relay/token.js`
- Create: `activity/edge-relay/token.test.js`

- [ ] Write tests using a deterministic HMAC token covering valid, expired, malformed, and modified tokens.
- [ ] Run `npx vitest run edge-relay/token.test.js` and verify the missing module fails.
- [ ] Implement base64url parsing, HMAC-SHA256 verification with Web Crypto, expiry validation, and claim validation.
- [ ] Run the focused test and verify it passes.

### Task 2: Durable Object room relay

**Files:**
- Create: `activity/edge-relay/worker.js`
- Create: `activity/edge-relay/room-state.js`
- Create: `activity/edge-relay/room-state.test.js`

- [ ] Write pure state tests for three publisher slots, fourth-publisher rejection, 25-viewer limit, and one watched stream per viewer.
- [ ] Run the focused test and verify failure before implementation.
- [ ] Implement state helpers with lowest-free-slot allocation and single-slot watching.
- [ ] Implement the Worker route and hibernation-aware Durable Object handlers for control, signaling, stop cleanup, and opaque binary forwarding.
- [ ] Run edge tests and the complete Activity suite.

### Task 3: Wrangler deployment configuration

**Files:**
- Create: `activity/edge-relay/wrangler.jsonc`
- Modify: `activity/package.json`

- [ ] Configure the Worker entry point, `ROOMS` Durable Object binding, first SQLite migration, observability, and `stream.skillup.com.br/edge/*` zone route.
- [ ] Add `edge:dev`, `edge:deploy`, and `edge:tail` scripts.
- [ ] Run `npx wrangler deploy --dry-run --config edge-relay/wrangler.jsonc` and verify the bundle and migration.

### Task 4: Edge-first client transport

**Files:**
- Create: `activity/apps/activity/src/relay-socket.js`
- Create: `activity/apps/activity/src/relay-socket.test.js`
- Modify: `activity/apps/activity/src/main.js`

- [ ] Test URL construction for external browser, Discord `/.proxy`, edge, and origin fallback paths.
- [ ] Implement a connector that tries `/edge/ws`, times out quickly, and falls back to `/ws` without changing the media protocol.
- [ ] Replace direct WebSocket construction in broadcaster and viewer flows.
- [ ] Run unit tests, build, and local smoke test.

### Task 5: Secure deploy and remote verification

**Files:**
- Modify: `activity/README.md`
- Modify: `activity/deploy/README.md`

- [ ] Pipe the active `SESSION_SECRET` from the Dokploy container to `wrangler secret put SESSION_SECRET` without printing it.
- [ ] Deploy the Worker and Durable Object migration with Wrangler.
- [ ] Verify `https://stream.skillup.com.br/edge/healthz` returns an edge health response.
- [ ] Verify an invalid WebSocket token is rejected.
- [ ] Deploy the edge-first client through Dokploy.
- [ ] Run the Activity suite, Vite build, smoke test, `git diff --check`, and commit each completed unit.
