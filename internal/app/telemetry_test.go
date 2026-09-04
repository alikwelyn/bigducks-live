package app

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
	"github.com/alikwelyn/bigducks-live/internal/telemetry"
)

type capturedTelemetry struct {
	events []telemetry.Event
}

func (c *capturedTelemetry) Capture(event telemetry.Event) {
	c.events = append(c.events, event)
}

func TestLegacyBridgeDoesNotFailCoreTelemetryTest(t *testing.T) {
	result, err := normalizeTelemetryBridgeTestError(bridge.ErrTelemetryUnsupported)
	if err != nil {
		t.Fatalf("normalized error = %v", err)
	}
	if result != "bridge_upgrade_required" {
		t.Fatalf("normalized result = %q, want bridge_upgrade_required", result)
	}
}

func TestReportMediaTransitionUsesOnlyAggregatedRTCFields(t *testing.T) {
	capture := &capturedTelemetry{}
	after := MediaStatus{
		State: MediaNativeReceiverNoPackets,
		Native: NativeMediaStatus{
			State:          MediaNativeReceiverNoPackets,
			StatsAvailable: true,
			HasAudioSSRC:   true,
			HasVideoSSRC:   false,
			AudioPackets:   30534,
			VideoPackets:   0,
			ReceiverCount:  0,
		},
	}
	reportMediaTransitionWithMode(capture, MediaStatus{}, after, string(RoutingModeGateway))
	if len(capture.events) != 1 {
		t.Fatalf("captured events = %#v", capture.events)
	}
	event := capture.events[0]
	if event.Component != telemetry.ComponentMedia || event.Code != telemetry.CodeNativeReceiverNoPackets {
		t.Fatalf("event identity = %#v", event)
	}
	if event.AudioPackets != 30534 || event.VideoPackets != 0 || !event.HasAudioSSRC || event.HasVideoSSRC {
		t.Fatalf("event aggregates = %#v", event)
	}
	if event.Mode != string(RoutingModeGateway) || event.Detail != "" {
		t.Fatalf("event privacy fields = %#v", event)
	}
}

func TestReportMediaTransitionIgnoresHealthyMediaAndRepeatedState(t *testing.T) {
	capture := &capturedTelemetry{}
	streaming := MediaStatus{State: MediaStreaming}
	reportMediaTransition(capture, MediaStatus{}, streaming)
	reportMediaTransition(capture, streaming, streaming)
	if len(capture.events) != 0 {
		t.Fatalf("healthy events = %#v", capture.events)
	}
}
