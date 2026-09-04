package app

import "testing"

func TestLifecycleTrackerRequiresStableAbsenceBeforeClosed(t *testing.T) {
	tracker := NewLifecycleTracker(2)
	identity := DiscordIdentity{PID: 42, Token: "session-1"}
	if got := tracker.Observe(identity); got != DiscordStarting {
		t.Fatalf("first present state = %q, want starting", got)
	}
	if got := tracker.Observe(identity); got != DiscordRunning {
		t.Fatalf("stable present state = %q, want running", got)
	}
	if got := tracker.Observe(DiscordIdentity{}); got != DiscordRunning {
		t.Fatalf("first absent state = %q, want running", got)
	}
	if got := tracker.Observe(DiscordIdentity{}); got != DiscordClosed {
		t.Fatalf("second absent state = %q, want closed", got)
	}
}

func TestLifecycleTrackerDetectsNewDiscordSession(t *testing.T) {
	tracker := NewLifecycleTracker(2)
	first := DiscordIdentity{PID: 42, Token: "session-1"}
	second := DiscordIdentity{PID: 77, Token: "session-2"}
	tracker.Observe(first)
	if got := tracker.Observe(second); got != DiscordStarting {
		t.Fatalf("new identity state = %q, want starting", got)
	}
	if got := tracker.Observe(second); got != DiscordRunning {
		t.Fatalf("stable new identity state = %q, want running", got)
	}
}
