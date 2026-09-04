package app

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRetryTransientStopsAfterSuccess(t *testing.T) {
	attempts := 0
	err := retryTransient(context.Background(), 4, time.Millisecond, func() (bool, error) {
		attempts++
		if attempts < 3 {
			return true, errors.New("not ready")
		}
		return false, nil
	})
	if err != nil || attempts != 3 {
		t.Fatalf("retryTransient() = err %v, attempts %d; want nil, 3", err, attempts)
	}
}

func TestRetryTransientDoesNotRetryPermanentFailure(t *testing.T) {
	attempts := 0
	want := errors.New("invalid artifact")
	err := retryTransient(context.Background(), 4, time.Millisecond, func() (bool, error) {
		attempts++
		return false, want
	})
	if !errors.Is(err, want) || attempts != 1 {
		t.Fatalf("retryTransient() = err %v, attempts %d; want permanent error, 1", err, attempts)
	}
}

func TestRetryTransientHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	attempts := 0
	err := retryTransient(ctx, 4, time.Millisecond, func() (bool, error) {
		attempts++
		return true, errors.New("not ready")
	})
	if !errors.Is(err, context.Canceled) || attempts != 0 {
		t.Fatalf("retryTransient() = err %v, attempts %d; want canceled, 0", err, attempts)
	}
}
