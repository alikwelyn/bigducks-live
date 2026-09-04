package app

import (
	"time"

	"github.com/alikwelyn/bigducks-live/internal/telemetry"
)

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

	MediaNativeProbeUnavailable   MediaState = "native_probe_unavailable"
	MediaNativeTransmitterStalled MediaState = "native_transmitter_stalled"
	MediaNativeReceiverAudioOnly  MediaState = "native_receiver_audio_only"
	MediaNativeReceiverNoPackets  MediaState = "native_receiver_no_packets"
	MediaNativeDecoderStalled     MediaState = "native_decoder_stalled"
	MediaNativeRenderUnknown      MediaState = "native_render_unknown"
	MediaNativeRTCDisconnected    MediaState = "native_rtc_disconnected"
)

type MediaStatus struct {
	State        MediaState        `json:"state"`
	Session      string            `json:"session,omitempty"`
	LastFrameAt  time.Time         `json:"lastFrameAt,omitempty"`
	AudioPackets uint64            `json:"audioPackets"`
	VideoFrames  uint64            `json:"videoFrames"`
	LastEvent    string            `json:"lastEvent,omitempty"`
	Native       NativeMediaStatus `json:"native"`

	nativePrevious *NativeMediaSample
}

type NativeMediaStatus struct {
	State            MediaState `json:"state"`
	Consecutive      int        `json:"consecutive"`
	Hooked           bool       `json:"hooked"`
	StreamConnection bool       `json:"streamConnection"`
	StatsAvailable   bool       `json:"statsAvailable"`
	DemandActive     bool       `json:"demandActive"`
	HasAudioSSRC     bool       `json:"hasAudioSsrc"`
	HasVideoSSRC     bool       `json:"hasVideoSsrc"`
	AudioPackets     uint64     `json:"audioPackets"`
	VideoPackets     uint64     `json:"videoPackets"`
	AudioBytes       uint64     `json:"audioBytes"`
	VideoBytes       uint64     `json:"videoBytes"`
	CaptureFrames    uint64     `json:"captureFrames"`
	EncodedFrames    uint64     `json:"encodedFrames"`
	FramesDecoded    uint64     `json:"framesDecoded"`
	ReceiverCount    uint64     `json:"receiverCount"`
}

type NativeMediaSample struct {
	Hooked           bool
	StreamConnection bool
	StatsAvailable   bool
	DemandActive     bool
	HasAudioSSRC     bool
	HasVideoSSRC     bool
	AudioPackets     uint64
	VideoPackets     uint64
	AudioBytes       uint64
	VideoBytes       uint64
	AudioFrames      uint64
	VideoFrames      uint64
	CaptureFrames    uint64
	EncodedFrames    uint64
	FramesDecoded    uint64
	FramesDropped    uint64
	ReceiverCount    uint64
	InputFPS         float64
	EncodedFPS       float64
}

type MediaEvent struct {
	Session string
	Kind    string
	At      time.Time
}

type mediaTelemetryReporter interface {
	Capture(telemetry.Event)
}

func reportMediaTransition(reporter mediaTelemetryReporter, before, after MediaStatus) {
	reportMediaTransitionWithMode(reporter, before, after, "")
}

func reportMediaTransitionWithMode(reporter mediaTelemetryReporter, before, after MediaStatus, mode string) {
	if reporter == nil || before.State == after.State {
		return
	}
	codes := map[MediaState]telemetry.Code{
		MediaAudioOnly:                telemetry.CodeAudioOnly,
		MediaVideoStalled:             telemetry.CodeVideoStalled,
		MediaReceiverTimeout:          telemetry.CodeReceiverTimeout,
		MediaRTCDisconnected:          telemetry.CodeRTCDisconnected,
		MediaNativeReceiverAudioOnly:  telemetry.CodeAudioOnly,
		MediaNativeReceiverNoPackets:  telemetry.CodeNativeReceiverNoPackets,
		MediaNativeDecoderStalled:     telemetry.CodeNativeDecoderStalled,
		MediaNativeTransmitterStalled: telemetry.CodeNativeTransmitterStalled,
		MediaNativeProbeUnavailable:   telemetry.CodeNativeProbeUnavailable,
		MediaNativeRenderUnknown:      telemetry.CodeNativeRenderUnknown,
		MediaNativeRTCDisconnected:    telemetry.CodeRTCDisconnected,
	}
	code, ok := codes[after.State]
	if !ok {
		return
	}
	audioPackets := after.Native.AudioPackets
	if after.Native.State == MediaUnknown {
		audioPackets = after.AudioPackets
	}
	reporter.Capture(telemetry.Event{
		Component:      telemetry.ComponentMedia,
		Code:           code,
		State:          string(after.State),
		Mode:           mode,
		StatsAvailable: after.Native.StatsAvailable,
		HasAudioSSRC:   after.Native.HasAudioSSRC,
		HasVideoSSRC:   after.Native.HasVideoSSRC,
		AudioPackets:   audioPackets,
		VideoPackets:   after.Native.VideoPackets,
		AudioBytes:     after.Native.AudioBytes,
		VideoBytes:     after.Native.VideoBytes,
		FramesDecoded:  after.Native.FramesDecoded,
		ReceiverCount:  after.Native.ReceiverCount,
	})
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

func ReduceNativeMedia(status MediaStatus, sample NativeMediaSample) MediaStatus {
	if status.State == "" {
		status.State = MediaUnknown
	}
	previousNative := status.Native
	nativeState := previousNative.State
	if nativeState == "" {
		nativeState = MediaUnknown
	}
	status.Native = NativeMediaStatus{
		State:            nativeState,
		Hooked:           sample.Hooked,
		StreamConnection: sample.StreamConnection,
		StatsAvailable:   sample.StatsAvailable,
		DemandActive:     sample.DemandActive,
		HasAudioSSRC:     sample.HasAudioSSRC,
		HasVideoSSRC:     sample.HasVideoSSRC,
		AudioPackets:     sample.AudioPackets,
		VideoPackets:     sample.VideoPackets,
		AudioBytes:       sample.AudioBytes,
		VideoBytes:       sample.VideoBytes,
		CaptureFrames:    sample.CaptureFrames,
		EncodedFrames:    sample.EncodedFrames,
		FramesDecoded:    sample.FramesDecoded,
		ReceiverCount:    sample.ReceiverCount,
	}

	if !sample.Hooked || !sample.StatsAvailable {
		if status.nativePrevious != nil && status.nativePrevious.Hooked == sample.Hooked && status.nativePrevious.StatsAvailable == sample.StatsAvailable {
			status.Native.Consecutive = previousNative.Consecutive + 1
		} else {
			status.Native.Consecutive = 1
		}
		status.nativePrevious = copyNativeSample(sample)
		if status.Native.Consecutive >= 2 {
			status.Native.State = MediaNativeProbeUnavailable
			status.State = MediaNativeProbeUnavailable
		}
		return status
	}
	if !sample.DemandActive {
		status.Native.Consecutive = 0
		status.Native.State = MediaUnknown
		status.nativePrevious = nil
		return status
	}

	previous := status.nativePrevious
	consecutive := 1
	if previous != nil && !nativeCounterReset(*previous, sample) {
		consecutive = previousNative.Consecutive + 1
	}
	status.Native.Consecutive = consecutive
	status.nativePrevious = copyNativeSample(sample)
	if previous == nil || nativeCounterReset(*previous, sample) || consecutive < 2 {
		return status
	}

	classification := classifyNativeMedia(*previous, sample)
	if classification != MediaUnknown {
		status.Native.State = classification
		status.State = classification
	}
	return status
}

func copyNativeSample(sample NativeMediaSample) *NativeMediaSample {
	copy := sample
	return &copy
}

func nativeCounterReset(previous, current NativeMediaSample) bool {
	return current.AudioPackets < previous.AudioPackets ||
		current.VideoPackets < previous.VideoPackets ||
		current.AudioBytes < previous.AudioBytes ||
		current.VideoBytes < previous.VideoBytes ||
		current.AudioFrames < previous.AudioFrames ||
		current.VideoFrames < previous.VideoFrames ||
		current.CaptureFrames < previous.CaptureFrames ||
		current.EncodedFrames < previous.EncodedFrames ||
		current.FramesDecoded < previous.FramesDecoded ||
		current.FramesDropped < previous.FramesDropped
}

func classifyNativeMedia(previous, current NativeMediaSample) MediaState {
	audioProgress := current.AudioPackets > previous.AudioPackets || current.AudioBytes > previous.AudioBytes || current.AudioFrames > previous.AudioFrames
	videoProgress := current.VideoPackets > previous.VideoPackets || current.VideoBytes > previous.VideoBytes || current.VideoFrames > previous.VideoFrames
	decodedProgress := current.FramesDecoded > previous.FramesDecoded
	captureProgress := current.CaptureFrames > previous.CaptureFrames || current.InputFPS > 0
	encodedProgress := current.EncodedFrames > previous.EncodedFrames || current.EncodedFPS > 0

	if current.StreamConnection && captureProgress && !encodedProgress {
		return MediaNativeTransmitterStalled
	}
	if videoProgress && !decodedProgress {
		return MediaNativeDecoderStalled
	}
	if audioProgress && !videoProgress {
		return MediaNativeReceiverAudioOnly
	}
	if !audioProgress && !videoProgress && current.ReceiverCount == 0 {
		return MediaNativeReceiverNoPackets
	}
	return MediaUnknown
}
