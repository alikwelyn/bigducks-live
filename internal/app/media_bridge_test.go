package app

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
)

func TestNativeSampleFromBridgeEventCopiesOnlyAggregates(t *testing.T) {
	sample, ok := nativeSampleFromBridgeEvent(bridge.MediaEvent{
		Kind: "native_rtc_snapshot",
		Native: &bridge.NativeSnapshot{
			Hooked: true, StreamConnection: true, StatsAvailable: true,
			DemandActive: true, HasAudioSSRC: true, AudioPackets: 20,
			VideoPackets: 0, FramesDecoded: 0, ReceiverCount: 0,
		},
	})
	if !ok {
		t.Fatal("native event was not converted")
	}
	if !sample.Hooked || !sample.StreamConnection || !sample.DemandActive || !sample.HasAudioSSRC {
		t.Fatalf("sample flags = %#v", sample)
	}
	if sample.AudioPackets != 20 || sample.VideoPackets != 0 || sample.FramesDecoded != 0 {
		t.Fatalf("sample counters = %#v", sample)
	}
}

func TestNativeSampleFromBridgeEventRejectsNonNativeEvent(t *testing.T) {
	if _, ok := nativeSampleFromBridgeEvent(bridge.MediaEvent{Kind: "video_frame"}); ok {
		t.Fatal("legacy event was converted as native")
	}
}
