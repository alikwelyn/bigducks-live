package app

import (
	"errors"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
)

func normalizeTelemetryBridgeTestError(err error) (string, error) {
	if err == nil {
		return "test_sent", nil
	}
	if errors.Is(err, bridge.ErrTelemetryUnsupported) {
		return "bridge_upgrade_required", nil
	}
	return "bridge_test_failed", err
}
