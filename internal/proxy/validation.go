package proxy

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
)

// ProbeDiscordLatency verifies that a proxy can reach Discord's region signal.
func ProbeDiscordLatency(ctx context.Context, endpoint model.Endpoint, timeout time.Duration) error {
	status, _, err := requestThrough(ctx, endpoint, "latency.discord.media", "/rtc", timeout)
	if err != nil {
		return err
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return fmt.Errorf("Discord latency probe status %d", status)
	}
	return nil
}

// ProbeGatewayRegion validates the Discord-specific region signal and gateway TLS.
func ProbeGatewayRegion(ctx context.Context, endpoint model.Endpoint, timeout time.Duration) (model.VerifiedEndpoint, error) {
	started := time.Now()
	if err := ProbeDiscordLatency(ctx, endpoint, timeout); err != nil {
		return model.VerifiedEndpoint{}, err
	}
	if err := ProbeGateway(ctx, endpoint, timeout); err != nil {
		return model.VerifiedEndpoint{}, err
	}
	return model.VerifiedEndpoint{
		Endpoint:  endpoint,
		LatencyMS: int(time.Since(started).Milliseconds()),
		CheckedAt: time.Now().Unix(),
	}, nil
}
