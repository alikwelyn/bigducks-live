# Activity polish implementation plan

**Goal:** Implement approved broadcaster, lobby and viewer UX while preserving SFU fallback.
**Architecture:** Keep transport independent of presentation. A small playback-state component owns loading/error overlays and first-frame observation; automatic quality uses bounded WebRTC sender settings.
**Tech Stack:** Vanilla JS, CSS, WebRTC, Vitest, Vite.

- [ ] Add tested playback-state component: loading with thumbnail, playing only after first frame, stalled/retry/error states, cleanup on stream changes.
- [ ] Integrate overlay into main.js without destroying media elements. Close old relay decoder before switching streams. Keep retry and back accessible.
- [ ] Refresh broadcaster layout with primary capture action, default automatic 720p30, collapsed advanced options, silent preview and source controls.
- [ ] Refresh lobby with larger responsive cards, own-live label and no redundant action button. Separate top identity and bottom audio controls.
- [ ] Add tested bounded automatic-quality decision function; sample SFU outbound stats, reduce on sustained congestion and recover slowly up to profile ceiling. Stop timer on close.
- [ ] Run npm test, npm run build, npm run smoke and git diff --check. Commit and push only after verification. Verify deployed asset separately from manual playback.
