package app

import (
	"time"

	"github.com/alikwelyn/bigducks-live/internal/injection"
)

func ensureInjectionWithRetry(attempts int, ensure func() (injection.Result, error)) (injection.Result, error) {
	var result injection.Result
	var err error
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 0; attempt < attempts; attempt++ {
		result, err = ensure()
		if err != nil || !injection.IsRetryable(result) {
			return result, err
		}
		if attempt < attempts-1 {
			time.Sleep(time.Duration(attempt+1) * 100 * time.Millisecond)
		}
	}
	return result, err
}
