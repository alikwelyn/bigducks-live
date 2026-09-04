package app

import (
	"testing"
	"time"
)

func TestReduceMediaKeepsVideoFailureSeparateFromGateway(t *testing.T) {
	now := time.Unix(10, 0)
	status := ReduceMedia(MediaStatus{}, MediaEvent{Session: "s1", Kind: "stream_start", At: now})
	status = ReduceMedia(status, MediaEvent{Session: "s1", Kind: "audio_packet", At: now.Add(time.Second)})
	if status.State != MediaAudioOnly {
		t.Fatalf("state after audio without video = %q, want audio_only", status.State)
	}
	status = ReduceMedia(status, MediaEvent{Session: "s1", Kind: "low_fps", At: now.Add(2 * time.Second)})
	if status.State != MediaVideoStalled {
		t.Fatalf("state after low fps = %q, want video_stalled", status.State)
	}
	status = ReduceMedia(status, MediaEvent{Session: "other", Kind: "video_frame", At: now.Add(3 * time.Second)})
	if status.State != MediaVideoStalled || status.VideoFrames != 0 {
		t.Fatalf("stale session changed media status: %#v", status)
	}
}

func TestReduceMediaTracksReceiverTimeoutAndDisconnect(t *testing.T) {
	status := ReduceMedia(MediaStatus{}, MediaEvent{Session: "s1", Kind: "receiver_timeout"})
	if status.State != MediaReceiverTimeout {
		t.Fatalf("timeout state = %q", status.State)
	}
	status = ReduceMedia(status, MediaEvent{Session: "s1", Kind: "rtc_disconnect"})
	if status.State != MediaRTCDisconnected {
		t.Fatalf("disconnect state = %q", status.State)
	}
}
