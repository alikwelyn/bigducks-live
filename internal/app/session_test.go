package app

import "testing"

func TestUnprotectedExistingDiscordIsRestartedOnlyWhenAutoStartIsEnabled(t *testing.T) {
	if !shouldRestartUnprotectedDiscord(true, true, true, false) {
		t.Fatal("auto-start should restart an existing unprotected Discord session")
	}
	if shouldRestartUnprotectedDiscord(true, false, true, false) {
		t.Fatal("manual-start mode must not restart an unmanaged Discord session")
	}
	if shouldRestartUnprotectedDiscord(true, true, true, true) {
		t.Fatal("protected Discord session must not be restarted")
	}
}
