package telemetry_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/telemetry"
)

func TestSanitizeRejectsIdentifiersAndSecrets(t *testing.T) {
	_, err := telemetry.Sanitize(telemetry.Event{
		Component: telemetry.ComponentMedia,
		Code:      telemetry.CodeAudioOnly,
		State:     "media_audio_only",
		Mode:      "gateway",
		Detail:    "token=secret user=123456789012345678 https://discord.media/x",
	})
	if !errors.Is(err, telemetry.ErrUnsafeEvent) {
		t.Fatalf("error = %v", err)
	}
}

func TestSanitizeAllowsOnlyFixedAggregates(t *testing.T) {
	event, err := telemetry.Sanitize(telemetry.Event{
		Component:    telemetry.ComponentMedia,
		Code:         telemetry.CodeAudioOnly,
		State:        "audio_only",
		Mode:         "gateway",
		HasAudioSSRC: true,
		HasVideoSSRC: false,
		AudioPackets: 30960,
		VideoPackets: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if event.Code != string(telemetry.CodeAudioOnly) || event.AudioPackets != 30960 {
		t.Fatalf("sanitized event = %#v", event)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "Detail") || strings.Contains(string(encoded), "discord") {
		t.Fatalf("free text survived: %s", encoded)
	}
}

func TestSanitizeRejectsUnknownCodesAndModes(t *testing.T) {
	for _, event := range []telemetry.Event{
		{Component: telemetry.ComponentCore, Code: telemetry.Code("arbitrary")},
		{Component: telemetry.ComponentCore, Code: telemetry.CodeStartupFailure, Mode: "socks5://127.0.0.1:55367"},
	} {
		if _, err := telemetry.Sanitize(event); !errors.Is(err, telemetry.ErrUnsafeEvent) {
			t.Fatalf("event %#v error = %v", event, err)
		}
	}
}
