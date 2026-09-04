package injection_test

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/injection"
)

func TestResultRetryableWhenAppAsarIsTemporarilyMissing(t *testing.T) {
	result := injection.Result{
		State:  injection.StateUnavailable,
		Reason: "Discord app.asar was not found",
	}
	if !injection.IsRetryable(result) {
		t.Fatal("missing app.asar should be retryable during an update")
	}
}

func TestResultNotRetryableForUnknownModification(t *testing.T) {
	result := injection.Result{
		State:  injection.StateUnknownMod,
		Reason: "an unrecognized app.asar directory is already installed",
	}
	if injection.IsRetryable(result) {
		t.Fatal("unknown modification must not be retried")
	}
}
