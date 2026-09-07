# Activity Viewer and Broadcaster UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Discord viewing and external broadcasting clear, reliable, visually identifiable, and compatible across capture sources.

**Architecture:** Discord identity is signed into publisher sessions and trusted relays enrich stream metadata. Broadcasters probe codecs, publish actual audio configuration and lightweight thumbnails; viewers render cards and maintain exactly one player subscription.

**Tech Stack:** JavaScript, Discord Embedded App SDK, WebCodecs, Web Audio, WebSocket, Cloudflare Durable Objects, Vitest, Vite.

---

### Task 1: Compatible media configuration

**Files:** `activity/shared/media.js`, `activity/shared/media.test.js`, `activity/apps/activity/src/player.js`

- [x] Add a failing test for codec probing and VP8 fallback.
- [x] Implement asynchronous codec support selection.
- [x] Make capture constraints advisory and cap encoder output to the selected profile.
- [x] derive Opus sample rate and channel count from the captured track.
- [x] Configure viewer audio from stream metadata and resume AudioContext after the watch gesture.

### Task 2: Single-view lifecycle

**Files:** `activity/apps/activity/src/main.js`

- [x] Make the active card action “Parar de assistir”.
- [x] On stop, send `unwatch`, close RTC and decoders, and replace the stage with its prompt.
- [x] Keep switching atomic so only one watched slot exists.
- [x] Use BroadcastChannel to replace an older external broadcaster tab.

### Task 3: Trusted visual stream cards

**Files:** `activity/relay/server.js`, `activity/edge-relay/worker.js`, `activity/apps/activity/src/main.js`, `activity/apps/activity/src/styles.css`

- [x] Derive Discord avatar URL and display name on the backend and sign them into the session.
- [x] Generate constrained JPEG thumbnails in the broadcaster.
- [x] Validate and forward thumbnails through Node and edge relays.
- [x] Render responsive visual cards with thumbnail, live badge, avatar, name, media metadata, and accessible controls.

### Task 4: Verification and deployment

**Files:** all modified Activity files

- [ ] Run `npm test`; expect all suites to pass.
- [ ] Run `npm run build`; expect Vite production build success.
- [ ] Run `npm run smoke`; expect `activity relay smoke: OK`.
- [ ] Run `npx wrangler deploy --dry-run --config edge-relay/wrangler.jsonc`.
- [ ] Deploy the Worker, push `public-main`, and deploy the Dokploy client.
