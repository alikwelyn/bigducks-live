package app

import "time"

type MediaState string

const (
	MediaUnknown         MediaState = "unknown"
	MediaNotStreaming    MediaState = "not_streaming"
	MediaStreamStarting  MediaState = "stream_starting"
	MediaStreaming       MediaState = "streaming"
	MediaAudioOnly       MediaState = "audio_only"
	MediaVideoStalled    MediaState = "video_stalled"
	MediaReceiverTimeout MediaState = "receiver_timeout"
	MediaRTCDisconnected MediaState = "rtc_disconnected"
)

type MediaStatus struct {
	State        MediaState `json:"state"`
	Session      string     `json:"session,omitempty"`
	LastFrameAt  time.Time  `json:"lastFrameAt,omitempty"`
	AudioPackets uint64     `json:"audioPackets"`
	VideoFrames  uint64     `json:"videoFrames"`
	LastEvent    string     `json:"lastEvent,omitempty"`
}

type MediaEvent struct {
	Session string
	Kind    string
	At      time.Time
}

func ReduceMedia(status MediaStatus, event MediaEvent) MediaStatus {
	if event.At.IsZero() {
		event.At = time.Now()
	}
	if event.Session != "" && status.Session != "" && event.Session != status.Session {
		return status
	}
	if event.Session != "" {
		status.Session = event.Session
	}
	status.LastEvent = event.Kind
	switch event.Kind {
	case "stream_start":
		status.State = MediaStreamStarting
	case "receiver_ready", "video_frame":
		if event.Kind == "video_frame" {
			status.VideoFrames++
			status.LastFrameAt = event.At
		}
		status.State = MediaStreaming
	case "audio_packet":
		status.AudioPackets++
		if status.VideoFrames == 0 {
			status.State = MediaAudioOnly
		}
	case "low_fps", "video_timeout":
		status.State = MediaVideoStalled
	case "receiver_timeout":
		status.State = MediaReceiverTimeout
	case "rtc_disconnect":
		status.State = MediaRTCDisconnected
	case "stream_stop":
		status.State = MediaNotStreaming
	}
	return status
}
