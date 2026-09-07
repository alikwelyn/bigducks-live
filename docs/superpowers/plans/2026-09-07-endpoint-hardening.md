# Endpoint hardening implementation plan

**Goal:** Harden the existing Activity entry points without changing media quality, SFU routing, fallback, or adding spending limits.
**Architecture:** Keep the existing room-token format for compatibility. Add validated publisher bootstrap, short-lived one-use share invitations, bounded HTTP parsing/rate limits, safe OAuth redirects, and generic browser entry states. Do not confuse frame_id, Origin, or noindex with authorization.
**Tech Stack:** Node HTTP, HMAC tokens, vanilla browser JS, Vitest.

## Scope approved in conversation
- `/` outside Discord must not initialize the SDK or list lives.
- `/share` must validate publisher access before enabling capture or replacing another capture tab.
- New invitations carry a random one-use code (2 minutes), not a six-hour room token in the URL. Valid legacy publisher links keep working until expiration. Clean query/history after redemption and validate sessionStorage on reload.
- Keep room access validated at APIs/WS. Reject malformed claims and wrong-role capture tokens. Preserve legitimate Discord Activity API calls.
- Limit JSON bodies and HTTP API bursts. Do not limit binary media throughput or claim comprehensive bot/DDoS protection.
- Add no-referrer, no-store and noindex headers. Keep iframe compatibility; no blanket DENY or cross-origin isolation changes.
- Fix OAuth redirect validation and bind callback state to an HttpOnly cookie.
- Keep healthz/config public with non-secret metadata. Restricting to one guild/presence needs configured Discord membership proof and is not enabled without it.

## Tasks / verification
1. Add failing `relay/security.test.js` unit tests for claim validation, body byte limits, safe redirects and bounded limiter reset. Run `npx vitest run relay/security.test.js`; implement `relay/security.js`; rerun.
2. Add HTTP integration tests in `relay/server.test.js` for invalid/expired/wrong-role capture sessions, one-use invite replay, invalid Origin, oversized body, security headers and existing authenticated SFU/relay compatibility. Implement endpoints in `relay/server.js` with bounded in-memory invite storage.
3. Add frontend access tests in `apps/activity/src/access.test.js`: generic outside entry, legacy URL and one-use redemption, cleanup before capture, denial before boot. Integrate helper into `main.js`, preserve publisher start/stop and viewer media logic.
4. Prefer Authorization header for ICE requests while retaining legacy query support; test in `shared/rtc.test.js`.
5. Run full `npm test`, `npm run build`, `npm run smoke`, `git diff --check`; review focused diff. Commit/push verified changes and verify production headers, friendly shell and auth guards without touching any active room. Document remaining guild authorization and operational limitations.
