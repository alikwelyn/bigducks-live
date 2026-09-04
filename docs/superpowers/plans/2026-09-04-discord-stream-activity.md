# Discord Stream Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VPS-hosted Discord Stream Activity in the existing monorepo with screen/window capture, optional system audio, selectable/adaptive quality, WebSocket relay, and WebRTC fallback/upgrade.

**Architecture:** Add a self-contained Node workspace under `activity/`, independent from the Go BIG DUCKS runtime. The relay authenticates Activity instances and routes binary media through WebSocket while carrying WebRTC signaling over the same authenticated socket; clients switch to direct WebRTC only after receiving a real media frame and retain relay fallback. Use the reference repository's proven WebCodecs packet model as a starting point, but implement a smaller MVP before adding production hardening.

**Tech Stack:** Node.js 22, ESM, Vite, vanilla browser JavaScript, WebCodecs, WebSocket (`ws`), Discord Embedded App SDK, Vitest, Docker, Caddy/HTTPS.

---

### Task 1: Create the isolated Activity workspace and protocol package

**Files:**
- Create: `activity/package.json`
- Create: `activity/package-lock.json`
- Create: `activity/vitest.config.js`
- Create: `activity/shared/protocol.js`
- Create: `activity/shared/protocol.test.js`
- Create: `activity/README.md`
- Modify: root `package.json` only if a workspace script is needed

- [ ] Write protocol tests for JSON control messages and binary packets with one-byte stream slot, one-byte media type, two eight-byte timestamps, and payload; reject malformed/truncated packets and unknown media types.
- [ ] Run `npm test -- --run activity/shared/protocol.test.js` and observe failure because the package does not exist.
- [ ] Implement encode/decode helpers and constants `VIDEO_KEYFRAME`, `VIDEO_DELTA`, `AUDIO`, plus bounded JSON message parsing.
- [ ] Run protocol tests until passing.
- [ ] Commit `feat: scaffold Discord stream Activity workspace`.

### Task 2: Implement relay rooms, tokens, and WebSocket transport

**Files:**
- Create: `activity/relay/rooms.js`
- Create: `activity/relay/rooms.test.js`
- Create: `activity/relay/tokens.js`
- Create: `activity/relay/tokens.test.js`
- Create: `activity/relay/server.js`
- Create: `activity/relay/server.test.js`

- [ ] Test room isolation, publisher/viewer membership, explicit watch opt-in, room cleanup after disconnect, and per-room viewer limits.
- [ ] Test HMAC-signed tokens with expiry, audience (`publisher`/`viewer`), room ID, and rejection of altered/expired tokens.
- [ ] Test WebSocket control flow: `hello`, `start`, `watch`, `unwatch`, `stop`, `need-keyframe`, `rtc`, and `rtc-active`; relay media only to opted-in viewers and enforce backpressure by dropping stale video frames above the queue limit.
- [ ] Implement the in-memory room registry and relay server with `/healthz`, `/api/session`, `/api/ice`, and `/ws` endpoints; require `SESSION_SECRET` and never persist media.
- [ ] Run all relay tests and a local smoke test with one publisher and two viewers.
- [ ] Commit `feat: add authenticated in-memory media relay`.

### Task 3: Implement shared capture, encoding, audio, and adaptation

**Files:**
- Create: `activity/shared/media.js`
- Create: `activity/shared/media.test.js`
- Create: `activity/shared/adaptation.js`
- Create: `activity/shared/adaptation.test.js`

- [ ] Add tests for screen/window capture constraints, H.264 level selection, codec fallback order, keyframe requests, queue dropping, Opus audio packet handling, and adaptive profile transitions based on loss/latency/encode queue.
- [ ] Implement `createBroadcaster` using `getDisplayMedia`, WebCodecs `VideoEncoder`, `AudioEncoder` where available, realtime latency settings, `contentHint: 'text'`, and a bounded queue.
- [ ] Implement fixed profiles 720p/60, 1080p/30, 1080p/60 and adaptive profile with gradual downgrade/upgrade.
- [ ] Ensure tracks and `VideoFrame` objects are closed on stop and no media is written to disk.
- [ ] Run media tests in Node with browser API fakes.
- [ ] Commit `feat: add low-latency screen and audio broadcaster`.

### Task 4: Implement WebRTC direct transport with WebSocket fallback

**Files:**
- Create: `activity/shared/rtc.js`
- Create: `activity/shared/rtc.test.js`
- Modify: `activity/relay/server.js`
- Modify: `activity/shared/media.js`

- [ ] Test signaling pass-through, ICE failure timeout, first-frame activation, and fallback to relay when no frame arrives within eight seconds.
- [ ] Implement publisher offer and viewer answer exchange using authenticated `rtc` control messages; configure STUN and optional TURN from `/api/ice`.
- [ ] Keep WebSocket relay active until `rtc-active` follows a received frame, then stop that viewer's relay stream only.
- [ ] Re-enable relay on WebRTC failure, renegotiation failure, or timeout.
- [ ] Run protocol, relay, media, and RTC tests.
- [ ] Commit `feat: add WebRTC upgrade with reliable relay fallback`.

### Task 5: Build the Discord Activity UI and capture page

**Files:**
- Create: `activity/apps/activity/index.html`
- Create: `activity/apps/activity/src/main.js`
- Create: `activity/apps/activity/src/player.js`
- Create: `activity/apps/activity/src/styles.css`
- Create: `activity/apps/capture/index.html`
- Create: `activity/apps/capture/src/main.js`
- Create: `activity/apps/capture/src/styles.css`
- Create: `activity/apps/activity/src/main.test.js`
- Create: `activity/apps/capture/src/main.test.js`
- Create: `activity/vite.config.js`

- [ ] Test Activity bootstrapping with Embedded App SDK, session token exchange, private-call default, explicit link access, stream list, watch opt-in, volume/fullscreen/quality controls, and readable connection states.
- [ ] Test capture UI source selection, audio toggle, fixed/adaptive profiles, status metrics, copy-link action, and clean stop behavior.
- [ ] Implement the Activity player with WebCodecs decode, keyframe gating, bounded render queue, audio buffer, WebRTC upgrade, and relay fallback.
- [ ] Implement capture-page routing to the relay, handling `MediaStreamTrack.onended`, permission errors, unsupported browser APIs, and publisher stop.
- [ ] Build both browser bundles and verify no secrets are embedded client-side beyond the public Discord client ID/session data.
- [ ] Commit `feat: add Activity viewer and capture interface`.

### Task 6: Add VPS packaging, configuration, and smoke tests

**Files:**
- Create: `activity/Dockerfile`
- Create: `activity/infra/Caddyfile`
- Create: `activity/.env.example`
- Create: `activity/scripts/smoke.mjs`
- Create: `activity/scripts/start.mjs`
- Create: `activity/README.md` additions
- Create: `activity/deploy/README.md`

- [ ] Test required environment validation (`DISCORD_CLIENT_ID`, `PUBLIC_ORIGIN`, `SESSION_SECRET`), production origin/HTTPS enforcement, and health endpoint.
- [ ] Implement a multi-stage Docker image running the relay and serving built Activity/capture assets; configure Caddy for HTTPS and WebSocket upgrade.
- [ ] Add smoke test that starts the relay, creates a publisher/viewer session, verifies private access and token expiry, relays a keyframe, and checks room cleanup.
- [ ] Document Discord Developer Portal URL mappings, Activity registration, VPS deployment, TURN variables, and local development.
- [ ] Run Docker build and smoke tests.
- [ ] Commit `ops: package Discord stream Activity for VPS deployment`.

### Task 7: Full verification and integration checkpoint

**Files:**
- Modify: `activity/README.md` and root `README.md` with links only if needed
- Test: all `activity/**/*.test.js`, smoke test, production build

- [ ] Run `npm ci` in `activity/`, `npm test`, `npm run build`, smoke test, and `git diff --check`.
- [ ] Run a real Discord Activity test with two accounts: private same-call viewing, temporary link viewing, screen/window capture, audio on/off, all fixed profiles, adaptive mode, WebRTC success, and forced fallback.
- [ ] Confirm no media files are created in the relay container and that disconnects clean room state.
- [ ] Review the implementation against every requirement in `docs/superpowers/specs/2026-09-04-discord-stream-activity-design.md`.
- [ ] Commit only any documentation/test adjustments required by verification; do not claim production readiness until the real Activity test passes.
