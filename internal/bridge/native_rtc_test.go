package bridge_test

import (
	"errors"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
)

func TestNormalizeNativeSnapshotKeepsOnlySafeAggregates(t *testing.T) {
	snapshot, err := bridge.NormalizeNativeSnapshot(map[string]any{
		"hooked":           true,
		"streamConnection": true,
		"statsAvailable":   true,
		"hasAudioSsrc":     true,
		"videoSsrc":        "123456789012345678",
		"audioPackets":     float64(30960),
		"videoPackets":     float64(0),
		"framesDecoded":    float64(0),
		"userId":           "123456789012345678",
		"url":              "wss://secret.discord.media/?token=secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.HasAudioSSRC || snapshot.HasVideoSSRC {
		t.Fatalf("ssrc presence = %#v", snapshot)
	}
	if snapshot.AudioPackets != 30960 || snapshot.VideoPackets != 0 {
		t.Fatalf("counters = %#v", snapshot)
	}
	if snapshot.RawShape != "" {
		t.Fatalf("raw shape leaked: %q", snapshot.RawShape)
	}
}

func TestNormalizeNativeSnapshotRejectsUnboundedOrInvalidCounters(t *testing.T) {
	_, err := bridge.NormalizeNativeSnapshot(map[string]any{
		"audioPackets": float64(-1),
		"videoPackets": float64(9007199254740992),
	})
	if !errors.Is(err, bridge.ErrInvalidNativeSnapshot) {
		t.Fatalf("error = %v", err)
	}
}
