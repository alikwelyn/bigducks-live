//go:build windows

package hud

import (
	"errors"
	"testing"
)

func TestRunSingleHUDRunsWindowForFirstInstance(t *testing.T) {
	released := false
	ran := false
	err := runSingleHUD(
		func() (func(), bool, error) { return func() { released = true }, false, nil },
		func() bool { t.Fatal("first instance must not activate another HUD"); return false },
		func() error { ran = true; return nil },
	)
	if err != nil {
		t.Fatalf("runSingleHUD() error = %v", err)
	}
	if !ran || !released {
		t.Fatalf("ran = %t, released = %t", ran, released)
	}
}

func TestRunSingleHUDActivatesExistingInstanceWithoutOpeningWindow(t *testing.T) {
	activated := false
	ran := false
	err := runSingleHUD(
		func() (func(), bool, error) { return func() {}, true, nil },
		func() bool { activated = true; return true },
		func() error { ran = true; return nil },
	)
	if err != nil {
		t.Fatalf("runSingleHUD() error = %v", err)
	}
	if !activated || ran {
		t.Fatalf("activated = %t, ran = %t", activated, ran)
	}
}

func TestRunSingleHUDReturnsAcquireError(t *testing.T) {
	want := errors.New("mutex failed")
	err := runSingleHUD(
		func() (func(), bool, error) { return nil, false, want },
		func() bool { return false },
		func() error { return nil },
	)
	if !errors.Is(err, want) {
		t.Fatalf("runSingleHUD() error = %v, want %v", err, want)
	}
}
