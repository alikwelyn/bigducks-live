package app

import (
	"context"
	"errors"
	"time"
)

// retryTransient retries only failures explicitly marked as transient.
func retryTransient(ctx context.Context, attempts int, delay time.Duration, operation func() (transient bool, err error)) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if attempts < 1 {
		attempts = 1
	}
	if delay <= 0 {
		delay = 50 * time.Millisecond
	}
	for attempt := 0; attempt < attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		transient, err := operation()
		if err == nil {
			return nil
		}
		if !transient {
			return err
		}
		if attempt == attempts-1 {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		}
		if delay < time.Second {
			delay *= 2
		}
	}
	return errors.New("retry operation exhausted")
}
