# BIG DUCKS LIVE Reliability Phases A–E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement reliable Discord lifecycle handling, safe proxy behavior, separate RTC/video diagnosis, bounded recovery, and update-safe injection in `public-main`.

**Architecture:** Add focused, testable collaborators around the existing `internal/discord`, `internal/app`, `internal/proxy`, `internal/relay`, and `internal/injection` packages. Keep gateway recovery separate from media diagnosis, keep safe mode as the default, and preserve existing Control API/HUD compatibility by extending status rather than replacing it.

**Tech Stack:** Go 1.26.5, Windows process APIs via `golang.org/x/sys/windows`, existing SOCKS5/PAC/bridge/injection code, Go standard-library tests.

---

## File map

- Modify `internal/app/config.go`: persisted lifecycle, direct-fallback, and recovery-policy settings.
- Modify `internal/app/control.go`: public lifecycle/media states and status fields.
- Create `internal/discord/process_identity_windows.go`: testable process identity and process-main discovery helpers.
- Modify `internal/discord/process_windows.go`: use process identity and stable polling instead of boolean tasklist detection.
- Create `internal/discord/process_identity_windows_test.go`: process identity tests.
- Modify `internal/discord/process_windows_test.go`: lifecycle and transient-enumeration tests.
- Create `internal/app/lifecycle.go`: lifecycle state machine and polling policy.
- Create `internal/app/lifecycle_test.go`: lifecycle transition tests.
- Modify `internal/app/run.go`: honor `Disabled`, wait for Discord, and wire lifecycle policy.
- Modify `internal/app/run_test.go`: startup policy tests.
- Modify `internal/proxy/managed.go`: bounded refresh/backoff and safe empty-pool behavior.
- Create `internal/proxy/validation.go`: Discord-specific probe composition and result classification.
- Create `internal/proxy/validation_test.go`: probe-policy tests using injected functions.
- Modify `internal/app/run.go`: use the composed proxy validator and configurable fallback policy.
- Modify `internal/relay/socks5.go`: enforce explicit refusal when no protected dialer is available.
- Modify `internal/relay/socks5_test.go`: direct-fallback safety tests.
- Create `internal/app/media.go`: RTC/video diagnostic state and event reducer.
- Create `internal/app/media_test.go`: media-state transition tests.
- Modify `internal/app/control.go`: expose media diagnostics without conflating them with gateway state.
- Modify `internal/app/recovery.go`: bounded conservative/aggressive policy and Discord-liveness guard.
- Modify `internal/app/recovery_test.go`: recovery-policy tests.
- Modify `internal/injection/injection.go`: readiness/error classification contract.
- Modify platform injection implementation files as needed: stable artifact checks and retryable readiness errors.
- Create or modify injection tests: transient update and version-change tests.
- Modify `internal/app/run.go`: wait/backoff around injection and prevent false `ours` status.
- Modify `internal/app/run_test.go`: integration readiness tests.
- Modify user-facing status mappings only where compilation/tests identify required compatibility changes.

---

### Task 1: Add safe configuration and public states

**Files:**
- Modify: `internal/app/config.go`
- Modify: `internal/app/control.go`
- Test: `internal/app/config_test.go`, `internal/app/control_test.go`

- [ ] **Step 1: Write failing configuration tests**

Add tests asserting that `DefaultConfig()` has `AutoStartDiscord == false`, `AllowDirectFallback == false`, and `AggressiveRecovery == false`; persisted JSON round-trips all three fields; and a missing field keeps the secure default.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
go test ./internal/app -run 'Test(DefaultConfig|Config)' -count=1
```

Expected: FAIL because the fields and persisted JSON members do not yet exist.

- [ ] **Step 3: Add the configuration fields and persistence**

Add the three `bool` fields to `Config`, corresponding lower-camel-case fields to `persistedConfig`, set secure defaults in `DefaultConfig`, load them when present, and write them in `SaveConfig`. Do not infer `true` from omitted JSON.

Add explicit lifecycle/media constants while retaining existing recovery constants and wire status fields for Discord lifecycle and media diagnosis.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
go test ./internal/app -run 'Test(DefaultConfig|Config)' -count=1
```

Expected: PASS.

- [ ] **Step 5: Run the package regression suite**

Run `go test ./internal/app -count=1`. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add internal/app/config.go internal/app/config_test.go internal/app/control.go internal/app/control_test.go
git commit -m "feat: add safe runtime policy settings"
```

### Task 2: Implement stable Discord process identity and lifecycle

**Files:**
- Create: `internal/discord/process_identity_windows.go`
- Create: `internal/discord/process_identity_windows_test.go`
- Modify: `internal/discord/process_windows.go`
- Modify: `internal/discord/process_windows_test.go`
- Create: `internal/app/lifecycle.go`
- Create: `internal/app/lifecycle_test.go`

- [ ] **Step 1: Write failing identity tests**

Test pure helpers with synthetic process records: the main Discord process is selected over descendants; a changed PID is a new session; and a missing process returns no identity. Keep OS enumeration behind an injected function.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
go test ./internal/discord ./internal/app -run 'Test(Process|Lifecycle)' -count=1
```

Expected: FAIL because the identity and lifecycle APIs do not exist.

- [ ] **Step 3: Implement identity and stable polling**

Introduce a `ProcessIdentity` containing PID and creation token/time where Windows permits it. Implement a process enumerator using Toolhelp snapshots and parent relationships. Require consecutive absence observations before reporting closed; treat enumeration errors as transient until the configured threshold.

Implement a lifecycle monitor with injected `Find`, `Now`, and `Sleep`/poll functions. It must emit `discord_closed`, `discord_starting`, and `discord_running`, detect a new identity, and never emit protected state itself.

- [ ] **Step 4: Run focused tests and then all package tests**

Run the focused command above, then `go test ./internal/discord ./internal/app -count=1`. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add internal/discord internal/app/lifecycle.go internal/app/lifecycle_test.go
git commit -m "feat: monitor Discord lifecycle reliably"
```

### Task 3: Integrate startup policy and disabled behavior

**Files:**
- Modify: `internal/app/run.go`
- Modify: `internal/app/run_test.go`
- Modify: `cmd/bigducks/main.go` only if configuration wiring requires it

- [ ] **Step 1: Write failing startup-policy tests**

Add tests proving that closed Discord with `AutoStartDiscord == false` returns/maintains `discord_closed` without invoking launch; enabled auto-start invokes launch; and `Disabled == true` does not create protection infrastructure or call launch.

- [ ] **Step 2: Run tests and verify failure**

Run `go test ./internal/app -run 'TestRun|TestLaunch|TestStartup' -count=1`. Expected: FAIL on the current unconditional launch/attach behavior.

- [ ] **Step 3: Refactor `Run`/`launchDiscord` around policy**

Before starting protected launch behavior, honor `Disabled`. For default mode, start the runtime infrastructure only as needed, wait for a detected Discord identity, and attach to an already-running Discord rather than rejecting it. If auto-start is enabled, retain the existing launch path. When the monitored identity disappears, close associated tunnels, update status to `discord_closed`, and wait for a new identity instead of reporting `protected` indefinitely.

Do not mark `protected` until Discord identity, proxy availability, and integration readiness are all true.

- [ ] **Step 4: Run focused and full tests**

Run `go test ./internal/app -count=1` and `go test ./...`. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add internal/app/run.go internal/app/run_test.go cmd/bigducks/main.go
git commit -m "fix: honor Discord lifecycle and disabled policy"
```

### Task 4: Harden proxy validation and refresh behavior

**Files:**
- Create: `internal/proxy/validation.go`
- Create: `internal/proxy/validation_test.go`
- Modify: `internal/proxy/managed.go`
- Modify: `internal/proxy/managed_test.go`
- Modify: `internal/app/run.go`

- [ ] **Step 1: Write failing validator tests**

Use injected probe functions to assert that a candidate is accepted only when SOCKS connectivity, Discord latency/region validation, and gateway TLS validation pass; any failed required probe rejects it; and the result records latency/region without exposing credentials.

- [ ] **Step 2: Run tests and verify failure**

Run `go test ./internal/proxy -run 'Test(Validate|Probe|Refresh)' -count=1`. Expected: FAIL because the composed validator does not exist.

- [ ] **Step 3: Implement composed validation**

Create a validator interface/function that executes the required probes under one context deadline, classifies transient versus hard failures, and returns a `VerifiedEndpoint` only after all required checks pass. Use the Discord latency endpoint when configured/available and preserve real TLS gateway probing. Keep the existing full-proxy behavior for full mode.

- [ ] **Step 4: Add bounded refresh/backoff tests**

Test that concurrent refreshes share one flight, repeated failures return cooldown, forced refresh cannot create an unbounded loop, and an empty pool remains empty after failure.

- [ ] **Step 5: Implement bounded refresh behavior**

Keep the current single-flight mechanism, make cooldown semantics explicit for both source failures and repeated dial failures, and ensure background heartbeat refresh does not immediately retry on every tick. Never synthesize a direct endpoint when the pool is empty.

- [ ] **Step 6: Run tests and commit**

Run `go test ./internal/proxy ./internal/app -count=1`, then:

```powershell
git add internal/proxy internal/app/run.go
git commit -m "fix: validate Discord proxy routes and bound refreshes"
```

### Task 5: Enforce safe relay policy

**Files:**
- Modify: `internal/relay/socks5.go`
- Modify: `internal/relay/socks5_test.go`
- Modify: `internal/app/run.go`

- [ ] **Step 1: Write failing safety tests**

Test that a missing dialer returns the protected no-proxy error, that non-allowed hosts/ports remain rejected, and that `AllowDirectFallback == false` never invokes a direct dialer.

- [ ] **Step 2: Run tests and verify failure**

Run `go test ./internal/relay ./internal/app -run 'Test.*(Direct|Proxy|Allow|Relay)' -count=1`. Expected: FAIL for any path that currently permits implicit direct dialing.

- [ ] **Step 3: Implement explicit policy**

Thread the configured fallback policy into the relay connector. In secure mode, no proxy means an explicit `ErrNoProxy`/HTTP relay failure. Only when `AllowDirectFallback` is true may a separately injected direct connector be used, and status must be marked unprotected.

- [ ] **Step 4: Run tests and commit**

Run `go test ./internal/relay ./internal/app -count=1`, then commit:

```powershell
git add internal/relay internal/app/run.go
git commit -m "fix: refuse direct gateway fallback by default"
```

### Task 6: Add independent RTC/video diagnostics

**Files:**
- Create: `internal/app/media.go`
- Create: `internal/app/media_test.go`
- Modify: `internal/app/control.go`

- [ ] **Step 1: Write the failing event-reducer tests**

Test transitions for stream start, receiver ready, frame receipt, audio-only, low-FPS timeout, receiver timeout, and RTC disconnect. Assert that a gateway-connected event does not clear `video_stalled`.

- [ ] **Step 2: Run tests and verify failure**

Run `go test ./internal/app -run 'TestMedia' -count=1`. Expected: FAIL because the media diagnosis types/reducer do not exist.

- [ ] **Step 3: Implement the reducer**

Define a small event-driven reducer with timestamps, last frame time, audio/frame counters, and a session identifier. Add explicit states `unknown`, `not_streaming`, `stream_starting`, `streaming`, `audio_only`, `video_stalled`, `receiver_timeout`, and `rtc_disconnected`. Make stale-session events no-ops.

- [ ] **Step 4: Expose diagnostics safely**

Add media status to `RuntimeStatus` with JSON-compatible fields used by Control API/HUD. Preserve existing gateway `RecoveryState`; do not overload `protected` as media health.

- [ ] **Step 5: Run tests and commit**

Run `go test ./internal/app ./internal/controlapi ./internal/hud -count=1`, then:

```powershell
git add internal/app/media.go internal/app/media_test.go internal/app/control.go
 git commit -m "feat: expose independent RTC video diagnostics"
```

### Task 7: Bound conservative and aggressive recovery

**Files:**
- Modify: `internal/app/recovery.go`
- Modify: `internal/app/recovery_test.go`
- Modify: `internal/app/run.go`

- [ ] **Step 1: Write failing policy tests**

Test that recovery aborts when Discord is closed, conservative mode never calls reload/restart, aggressive mode permits only the configured second-stage action, concurrent requests remain serialized, and cooldown/attempt limits produce a stable failure state.

- [ ] **Step 2: Run tests and verify failure**

Run `go test ./internal/app -run 'TestRecovery' -count=1`. Expected: FAIL for missing liveness and policy checks.

- [ ] **Step 3: Implement policy and liveness guards**

Add injected `DiscordAlive`, policy values, attempt counters, and cooldown timestamps. Keep proxy promotion and tunnel closure separate from media diagnosis. On conservative recovery, use only affected tunnel closure and bridge redial. On aggressive recovery, invoke the explicitly injected second-stage media/reconnect action, still bounded by budget and attempts. Never convert a successful gateway reconnect into healthy media status automatically.

- [ ] **Step 4: Run tests and commit**

Run `go test ./internal/app -count=1`, then:

```powershell
git add internal/app/recovery.go internal/app/recovery_test.go internal/app/run.go
 git commit -m "fix: bound gateway recovery during active calls"
```

### Task 8: Make injection/update readiness retryable and version-aware

**Files:**
- Modify: `internal/injection/injection.go`
- Modify: platform injection implementation files and tests
- Modify: `internal/app/run.go`
- Modify: `internal/app/run_test.go`

- [ ] **Step 1: Write failing readiness tests**

Test classification of missing `app.asar` as retryable during the update window, invalid artifact as repair-required, valid artifact as `ours`, and a version change as requiring fresh validation. Test that retry count and delay stop the loop.

- [ ] **Step 2: Run tests and verify failure**

Run `go test ./internal/injection ./internal/app -run 'Test.*(Injection|Artifact|Repair|Version)' -count=1`. Expected: FAIL because readiness classification/retry policy is absent.

- [ ] **Step 3: Implement artifact readiness contract**

Add typed errors/results distinguishing transient-not-ready, invalid/unknown-modification, and valid-installed states. Validate resource paths, artifact type, backup availability, marker, and selected Discord version before returning `StateOurs`.

- [ ] **Step 4: Add bounded wait in startup**

In `run.go`, retry only transient readiness failures with exponential backoff capped by a small maximum and a fixed attempt budget. Publish a waiting/repair status rather than repeatedly restarting Discord. Publish `InjectionState: ours` only after final validation.

- [ ] **Step 5: Run tests and commit**

Run `go test ./internal/injection ./internal/app -count=1`, then:

```powershell
git add internal/injection internal/app/run.go internal/app/run_test.go
git commit -m "fix: tolerate Discord updates during injection readiness"
```

### Task 9: Integrate status consumers and perform end-to-end verification

**Files:**
- Modify: `internal/controlapi/server.go` only if serialization needs explicit fields
- Modify: HUD/tray mappings only where needed
- Modify: relevant tests

- [ ] **Step 1: Write failing compatibility tests**

Assert that Control API status includes lifecycle and media fields, old state values remain valid, and tray/HUD labels do not panic or silently collapse new states.

- [ ] **Step 2: Implement minimal mappings**

Add labels/messages for `disabled`, `discord_closed`, `discord_starting`, `discord_running`, `starting_protection`, `no_proxy`, `repair_required`, and media states. Keep sensitive proxy details redacted.

- [ ] **Step 3: Run all automated verification**

Run:

```powershell
go test ./...
go vet ./...
```

Expected: PASS with no test failures or vet diagnostics.

- [ ] **Step 4: Run Windows build validation**

Run from the public worktree:

```powershell
.\build.ps1 -Version 0.1.2-dev
```

Expected: build artifacts are produced under `dist\` without publishing a release.

- [ ] **Step 5: Review diff and status**

Run:

```powershell
git diff origin/main...HEAD --stat
git status --short --branch
git log --oneline --decorate -12
```

Confirm no generated runtime data, secrets, or release assets were committed.

- [ ] **Step 6: Commit final integration**

```powershell
git add internal cmd
git commit -m "feat: complete BIG DUCKS reliability phases A-E"
```

## Final review checklist

- [ ] No `protected` status is emitted while Discord is closed.
- [ ] Default configuration does not launch Discord automatically.
- [ ] `disabled` prevents protection and is respected at runtime.
- [ ] Empty proxy pool cannot silently connect directly.
- [ ] Proxy refresh and recovery are bounded by cooldowns/budgets.
- [ ] Gateway state and media state are separate.
- [ ] Conservative recovery does not reload/restart Discord during a live.
- [ ] Injection waits for transient update readiness and detects version changes.
- [ ] `go test ./...` passes.
- [ ] `go vet ./...` passes.
- [ ] Windows build validation passes.
- [ ] Activity functionality remains out of scope.
