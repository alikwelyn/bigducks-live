package app

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/telemetry"
)

func TestTelemetryEventForMediaUsesOnlyAggregatedRTCFields(t *testing.T) {
	status := MediaStatus{
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
	event, ok := telemetryEventForMedia(status, RoutingModeGateway)
	if !ok {
		t.Fatal("media state was not mapped")
	}
	if event.Component != telemetry.ComponentMedia || event.Code != telemetry.CodeNativeReceiverNoPackets {
		t.Fatalf("event identity = %#v", event)
	}
	if event.AudioPackets != 30534 || event.VideoPackets != 0 || event.HasAudioSSRC != true || event.HasVideoSSRC {
		t.Fatalf("event aggregates = %#v", event)
	}
	if event.Mode != string(RoutingModeGateway) || event.Detail != "" {
		t.Fatalf("event privacy fields = %#v", event)
	}
}

func TestTelemetryEventForMediaIgnoresHealthyMedia(t *testing.T) {
	if _, ok := telemetryEventForMedia(MediaStatus{State: MediaStreaming}, RoutingModeGateway); ok {
		t.Fatal("healthy media should not produce a failure event")
	}
}
