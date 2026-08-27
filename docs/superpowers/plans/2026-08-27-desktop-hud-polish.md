# BIG DUCKS Desktop HUD Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a single-instance, landscape BIG DUCKS desktop HUD and a correctly branded `D:\discord\dist\BigDucks.exe` without launching it.

**Architecture:** Keep the existing tray supervisor/core split. Add a HUD-specific named mutex plus Win32 activation helper, make the tray request activation before spawning, harden the vendored Windows tray event decoder, and reshape the embedded WebView assets into a fixed two-column dashboard.

**Tech Stack:** Go 1.26, Win32 APIs, WebView2, embedded HTML/CSS/JavaScript, PowerShell, go-winres.

---

### Task 1: Single HUD and exact tray contract

**Files:**
- Create: `internal/hud/instance_windows.go`
- Create: `internal/hud/instance_windows_test.go`
- Modify: `internal/hud/hud_windows.go`
- Modify: `cmd/bigducks/tray_windows.go`
- Modify: `cmd/bigducks/main_windows_test.go`

- [ ] Add failing tests that require `RunSingle` to activate and exit when a second HUD owns the mutex, and require the labels `Abrir`, `Reiniciar`, `Sair`.
- [ ] Run `go test ./internal/hud ./cmd/bigducks` and confirm the missing API/labels fail.
- [ ] Implement a `Local\\BigDucks.Live.HUD` mutex and exact-title Win32 foreground activation.
- [ ] Make tray opening activate the existing HUD first and serialize first-launch requests.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Reliable Windows tray mouse notifications

**Files:**
- Create: `third_party/systray/*` from the pinned Apache-2.0 dependency
- Modify: `third_party/systray/systray_windows.go`
- Modify: `go.mod`
- Test: `third_party/systray/systray_windows_test.go`

- [ ] Add a failing table test for classic `WM_LBUTTONUP`, classic `WM_RBUTTONUP`, and version-4 `WM_CONTEXTMENU` decoding.
- [ ] Run the vendored package test and confirm version-4 context-menu decoding fails.
- [ ] Add a small notification decoder and route all supported menu notifications to `showMenu`.
- [ ] Add the local module replacement and run the focused test again.

### Task 3: Fixed horizontal HUD with no scroll or zoom

**Files:**
- Modify: `internal/hud/assets/index.html`
- Modify: `internal/hud/assets/app.css`
- Modify: `internal/hud/assets/app.js`
- Modify: `internal/hud/assets_test.go`
- Modify: `internal/hud/hud_windows.go`

- [ ] Extend the page test to require the dashboard grid, `overflow: hidden`, zoom guards, delayed update check, and fixed landscape dimensions.
- [ ] Run `go test ./internal/hud` and confirm the new assertions fail.
- [ ] Recompose markup into header + two-column dashboard + full-width technical footer.
- [ ] Apply fixed `1180×700` WebView sizing, no document scroll, responsive internal sizing, and 44 px controls.
- [ ] Install pre-document keyboard/wheel zoom guards and delay network update work until after first paint.
- [ ] Run the HUD tests and confirm they pass.

### Task 4: Transparent icon and root build artifact

**Files:**
- Modify: `imgs/big-ducks.png`
- Modify: `internal/brand/brand_test.go`
- Modify: `build.ps1`

- [ ] Add a failing brand test that requires transparent corner pixels.
- [ ] Run `go test ./internal/brand` and confirm the opaque source fails.
- [ ] Replace only the outer background with alpha while preserving the framed duck artwork.
- [ ] Add `-OutputDirectory` to `build.ps1`, keeping the default worktree `dist` behavior.
- [ ] Run `go test ./...`, static analysis, and `build.ps1 -Version 0.1.1 -OutputDirectory D:\discord\dist`.
- [ ] Inspect version resources, icon extraction, SHA-256, and repository diff without launching the executable.

### Task 5: Final repository state

**Files:** all changed files above.

- [ ] Run formatting and all tests from a clean command invocation.
- [ ] Confirm `D:\discord\dist\BigDucks.exe` exists and carries BIG DUCKS metadata/icon resources.
- [ ] Commit the implementation locally without publishing a release before user testing.
