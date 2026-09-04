package app

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/injection"
)

func TestEnsureInjectionRetriesOnlyTransientReadiness(t *testing.T) {
	attempts := 0
	result, err := ensureInjectionWithRetry(4, func() (injection.Result, error) {
		attempts++
		if attempts < 3 {
			return injection.Result{State: injection.StateUnavailable, Reason: "Discord app.asar was not found"}, nil
		}
		return injection.Result{State: injection.StateOurs, Installed: true}, nil
	})
	if err != nil || result.State != injection.StateOurs || attempts != 3 {
		t.Fatalf("result=%#v err=%v attempts=%d", result, err, attempts)
	}
}

func TestEnsureInjectionDoesNotRetryPermanentResult(t *testing.T) {
	attempts := 0
	result, err := ensureInjectionWithRetry(4, func() (injection.Result, error) {
		attempts++
		return injection.Result{State: injection.StateUnknownMod, Reason: "unknown modification"}, nil
	})
	if err != nil || result.State != injection.StateUnknownMod || attempts != 1 {
		t.Fatalf("result=%#v err=%v attempts=%d", result, err, attempts)
	}
}
