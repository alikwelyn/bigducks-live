# Cloudflare Realtime SFU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route BIG DUCKS live audio/video through Cloudflare Realtime SFU while retaining the current Durable Object relay as an automatic fallback.

**Architecture:** An authenticated origin proxy owns the Realtime App Secret and signs published track capabilities. Browser publishers and viewers use native WebRTC sessions with Cloudflare; the Durable Object carries presence and control only unless a viewer explicitly requests compatibility relay.

**Tech Stack:** JavaScript, native WebRTC, Cloudflare Realtime SFU HTTPS API, HMAC capabilities, WebSocket, Durable Objects, Vitest, Vite.

---

### Task 1: Authenticated SFU proxy

**Files:**
- Create: `activity/relay/sfu.js`
- Create: `activity/relay/sfu.test.js`
- Modify: `activity/relay/config.js`
- Modify: `activity/relay/server.js`
- Modify: `activity/relay/server.test.js`
- Modify: `activity/.env.example`

- [ ] Write tests proving requests fail without a room token, a publisher can publish, and a viewer can subscribe only to a media capability from its room.
- [ ] Implement a Cloudflare Realtime API client with response validation and dependency-injected `fetch`.
- [ ] Add create, publish, subscribe, renegotiate, and close-track proxy operations.
- [ ] Sign track identifiers into short-lived HMAC media capabilities; never return the App Secret.
- [ ] Verify focused and full relay tests.

### Task 2: Native WebRTC publisher and viewer

**Files:**
- Create: `activity/apps/activity/src/sfu.js`
- Create: `activity/apps/activity/src/sfu.test.js`
- Modify: `activity/apps/activity/src/main.js`

- [ ] Write tests for proxy request construction, publishing metadata, and subscription renegotiation.
- [ ] Implement SFU publishing with send-only transceivers and video bitrate/FPS limits.
- [ ] Implement SFU subscription with track-to-MediaStream assembly, timeout, mute, and deterministic close.
- [ ] Make new broadcasts prefer SFU and make selected cards prefer native playback.
- [ ] Preserve aspect ratio through native video `object-fit: contain`.

### Task 3: Targeted compatibility fallback

**Files:**
- Modify: `activity/apps/activity/src/main.js`
- Modify: `activity/edge-relay/worker.js`
- Modify: `activity/relay/server.js`
- Modify: `activity/edge-relay/room-state.test.js`
- Modify: `activity/relay/server.test.js`

- [ ] Add failing relay tests for targeted `fallback-want` and `fallback-ready` controls.
- [ ] Route fallback requests only between the authenticated viewer and selected publisher.
- [ ] Gate publisher binary packets until fallback is requested.
- [ ] On SFU timeout, request relay, force a keyframe, and start the existing WebCodecs player.
- [ ] Verify a normal SFU view sends no media frames through the Durable Object.

### Task 4: Configuration, documentation, and rollout

**Files:**
- Modify: `activity/README.md`
- Modify: `activity/deploy/README.md`
- Modify: `activity/scripts/smoke.mjs`

- [ ] Document `CLOUDFLARE_SFU_APP_ID` and `CLOUDFLARE_SFU_APP_SECRET` as server-only settings.
- [ ] Make missing credentials explicitly select relay mode rather than break broadcasting.
- [ ] Extend smoke coverage to SFU proxy authorization and fallback room controls.
- [ ] Create/install Cloudflare Realtime credentials and deploy backend configuration.

### Task 5: Verification and deployment

**Files:** all modified Activity files

- [ ] Run `npm test`; all suites must pass.
- [ ] Run `npm run build`; Vite production build must succeed.
- [ ] Run `npm run smoke`; relay smoke must pass.
- [ ] Run Wrangler dry-run and `git diff --check`.
- [ ] Deploy the Durable Object Worker, push `public-main`, deploy origin, and verify health endpoints.
