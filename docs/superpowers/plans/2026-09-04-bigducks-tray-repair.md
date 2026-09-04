# BIG DUCKS LIVE Tray Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confirmed tray action that repairs Discord without Task Manager and make `Sair` close HUD, core, Discord, and the tray process completely.

**Architecture:** The tray calls a new authenticated `RepairDiscord` operation on the existing local core control API. The core owns process cleanup, injection, PAC/relay launch, and status reporting; explicit repair bypasses only the automatic-start gate in memory. The HUD package owns its Windows window-close and bounded process cleanup, while the tray coordinates shutdown and prevents the supervisor from restarting the core.

**Tech Stack:** Go 1.26, Windows Win32 APIs through `golang.org/x/sys/windows`, existing local HTTP control API, WebView2 HUD, systray, Go tests, GitHub Actions signed Windows release.

---

### Task 1: Extend the runtime control contract for explicit Discord repair

**Files:**
- Modify: `internal/app/control.go`
- Modify: `internal/controlapi/server.go`
- Modify: `internal/controlapi/client.go`
- Test: `internal/controlapi/server_test.go`
- Test: `internal/app/control_test.go`

- [ ] **Step 1: Write the failing runtime/control API tests**

Add `RepairDiscord` to the fake bindings in `internal/controlapi/server_test.go`, invoke `client.RepairDiscord`, and assert one call. Add a runtime control test asserting a bound repair callback is dispatched and an unbound callback returns `app.ErrRuntimeUnavailable`.

Expected test shape:

```go
repairCalls := 0
runtime.Bind(app.RuntimeBindings{
    RepairDiscord: func(context.Context) error { repairCalls++; return nil },
})
if err := runtime.RepairDiscord(context.Background()); err != nil { t.Fatal(err) }
if repairCalls != 1 { t.Fatalf("repair calls = %d", repairCalls) }
```

- [ ] **Step 2: Run the focused tests and verify they fail for the missing API**

Run:

```bash
go test ./internal/app ./internal/controlapi -run 'RepairDiscord|RuntimeControl' -count=1
```

Expected: compilation failure because `RuntimeBindings`, `RuntimeControl`, `Client`, and the server route do not yet expose `RepairDiscord`.

- [ ] **Step 3: Implement the minimal control contract**

Add `RepairDiscord func(context.Context) error` to `app.RuntimeBindings` and a `RuntimeControl.RepairDiscord` method matching `Reconnect`. Add `/v1/repair-discord` to the authenticated server mux and add `Client.RepairDiscord` using `POST`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
go test ./internal/app ./internal/controlapi -run 'RepairDiscord|RuntimeControl' -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the control API change**

```bash
git add internal/app/control.go internal/app/control_test.go internal/controlapi/server.go internal/controlapi/client.go internal/controlapi/server_test.go
git commit -m "feat: expose explicit Discord repair action"
```

### Task 2: Add core-side explicit protected Discord repair

**Files:**
- Modify: `internal/app/run.go`
- Modify: `internal/app/run_test.go`
- Create: `internal/app/discord_repair_test.go`

- [ ] **Step 1: Write failing tests for forced repair policy**

Add a small testable helper around the repair launch policy. It must accept `autoStartDiscord`, `disabled`, and a launch callback. Assert that explicit repair invokes launch when auto-start is false, while disabled protection returns an error without invoking launch.

Expected test shape:

```go
func TestExplicitDiscordRepairLaunchesWhenAutomaticStartupIsDisabled(t *testing.T) {
    launched := false
    err := repairDiscordPolicy(false, false, func() error { launched = true; return nil })
    if err != nil || !launched { t.Fatalf("err=%v launched=%t", err, launched) }
}

func TestExplicitDiscordRepairRefusesDisabledProtection(t *testing.T) {
    launched := false
    err := repairDiscordPolicy(false, true, func() error { launched = true; return nil })
    if err == nil || launched { t.Fatalf("err=%v launched=%t", err, launched) }
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
go test ./internal/app -run 'ExplicitDiscordRepair' -count=1
```

Expected: compilation failure because `repairDiscordPolicy` does not exist.

- [ ] **Step 3: Implement the minimal policy helper and core binding**

Add the helper in a focused `internal/app/discord_repair.go` file. In `Run`, reuse the existing protected launch preparation (latest Discord discovery, bridge injection retry, PAC/full-relay selection, and process-tree wait) through a closure that accepts `force bool`; `force` bypasses only `AutoStartDiscord`. Add a repair callback to `RuntimeBindings` that:

1. Rejects `config.Disabled`.
2. Marks `RecoveryDiscordStarting`.
3. Gets the current Discord identity and calls `discord.KillProcessTree` when present.
4. Waits up to the existing bounded Discord shutdown deadline.
5. Starts through the protected launch closure with `force=true`.
6. Logs the operation and returns any error to the control API.

Do not enable direct fallback, persist `autoStartDiscord`, or duplicate PAC/relay logic in the tray.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
go test ./internal/app -run 'ExplicitDiscordRepair|Run' -count=1
go test ./internal/app -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the core repair implementation**

```bash
git add internal/app/discord_repair.go internal/app/discord_repair_test.go internal/app/run.go internal/app/run_test.go
git commit -m "feat: repair Discord through protected launch"
```

### Task 3: Add bounded Windows HUD shutdown

**Files:**
- Modify: `internal/hud/instance_windows.go`
- Modify: `internal/hud/hud_windows_test.go`
- Create: `internal/hud/close_windows_test.go`

- [ ] **Step 1: Write failing tests for the close helper**

Add tests for an injected `find`/`post`/`terminate` helper: when a HUD window exists it posts `WM_CLOSE`; when the window disappears it returns nil; when the deadline expires it calls the restricted terminate callback and returns its result. Use a fake window handle and no real Win32 window.

- [ ] **Step 2: Run the focused Windows tests and verify they fail**

Run:

```bash
go test ./internal/hud -run 'CloseExisting|closeExisting' -count=1
```

Expected: compilation failure because the close helper and public HUD close function do not exist.

- [ ] **Step 3: Implement the Windows HUD close operation**

Refactor the existing `FindWindowW` lookup into a shared helper. Add `CloseExisting(ctx context.Context) error` that posts `WM_CLOSE`, polls for disappearance with a bounded context, and on timeout obtains only that window's PID and invokes `taskkill.exe /PID <pid> /T /F`. Keep `ActivateExisting` behavior unchanged. Add injectable helper functions so the polling and fallback behavior remain unit-testable.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
GOOS=windows GOARCH=amd64 go test ./internal/hud -run 'CloseExisting|closeExisting' -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the HUD shutdown implementation**

```bash
git add internal/hud/instance_windows.go internal/hud/hud_windows_test.go internal/hud/close_windows_test.go
git commit -m "feat: close HUD process during tray shutdown"
```

### Task 4: Add tray repair action and complete shutdown coordination

**Files:**
- Modify: `cmd/bigducks/tray_windows.go`
- Modify: `cmd/bigducks/main_windows_test.go`
- Test: `internal/controlapi/server_test.go`

- [ ] **Step 1: Write failing tray tests**

Extend the tray label test with `Corrigir Discord`. Add testable confirmation/operation helpers that assert a declined confirmation does not call the core and an accepted repair calls the client exactly once. Add a shutdown guard test proving the supervisor watcher skips restart after closing begins.

- [ ] **Step 2: Run the focused Windows tests and verify they fail**

Run:

```bash
go test ./cmd/bigducks -run 'TrayMenu|Repair|Shutdown' -count=1
```

Expected: failure because the new menu item, guard, and helpers do not exist.

- [ ] **Step 3: Implement the tray behavior**

Add `trayRepairLabel`, a `repairItem`, and an atomic `closing`/`repairing` guard. On repair click, show a Yes/No confirmation, disable the item while busy, call the authenticated core client's `RepairDiscord` with a bounded context, update tooltip, and show errors without changing persisted configuration. Enable the repair item after a healthy core start unless protection is disabled.

Update `quitEverything` and `onExit` so shutdown is idempotent: mark closing before any waits, prevent `watchCore` from restarting, close the existing HUD with a bounded context, stop the core, kill the complete Discord tree, call `systray.Quit`, and let `runTray` return. Keep `Sair` semantics of closing Discord; never kill arbitrary other `BigDucks.exe` processes.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
GOOS=windows GOARCH=amd64 go test ./cmd/bigducks -run 'TrayMenu|Repair|Shutdown' -count=1
go test ./...
go vet ./...
```

Expected: PASS with no vet findings.

- [ ] **Step 5: Commit the tray integration**

```bash
git add cmd/bigducks/tray_windows.go cmd/bigducks/main_windows_test.go
git commit -m "feat: add tray Discord repair and complete exit"
```

### Task 5: Update version, documentation, and release artifacts

**Files:**
- Modify: `internal/buildinfo/buildinfo.go`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-04-bigducks-tray-repair-design.md`

- [ ] **Step 1: Update the release version and user documentation**

Bump `buildinfo.Version` from `0.1.6` to `0.1.7`. Document the new tray item and explain that it closes/reopens Discord through the protected route. Document that `Sair` also closes the HUD and Discord completely.

- [ ] **Step 2: Run final local validation**

Run:

```bash
gofmt -w cmd/bigducks/tray_windows.go internal/app/*.go internal/controlapi/*.go internal/hud/*.go internal/buildinfo/buildinfo.go
git diff --check
go test ./...
go vet ./...
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H=windowsgui -X github.com/alikwelyn/bigducks-live/internal/buildinfo.Version=0.1.7" -o ./dist/bigducks-live-0.1.7-test.exe ./cmd/bigducks
```

Expected: all tests and vet pass, and the Windows executable is produced.

- [ ] **Step 3: Commit release preparation**

```bash
git add README.md internal/buildinfo/buildinfo.go docs/superpowers/specs/2026-09-04-bigducks-tray-repair-design.md
git commit -m "chore: prepare BIG DUCKS LIVE 0.1.7"
```

- [ ] **Step 4: Push the branch and signed tag**

```bash
git push origin public-main
git tag -a v0.1.7 -m "BIG DUCKS LIVE 0.1.7"
git push origin v0.1.7
```

Expected: the release workflow starts for `v0.1.7`.

- [ ] **Step 5: Verify the workflow and release artifacts**

Run:

```bash
gh run list --repo alikwelyn/bigducks-live --workflow release.yml --limit 3
gh run watch <release-run-id> --repo alikwelyn/bigducks-live --exit-status
gh release download v0.1.7 --repo alikwelyn/bigducks-live --dir <temporary-directory> --clobber
```

Verify all three assets exist: `BigDucks-windows-amd64.exe`, `manifest.json`, and `manifest.sig`. Parse the manifest, recompute executable size/SHA-256, and verify the Ed25519 signature with the public key embedded in `internal/buildinfo/buildinfo.go`. Do not report the release as complete if any check fails.
