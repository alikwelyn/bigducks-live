package telemetry

type Component string
type Code string

const (
	ComponentCore   Component = "core"
	ComponentBridge Component = "bridge"
	ComponentMedia  Component = "media"

	CodeStartupFailure           Code = "startup_failure"
	CodeBridgeFailure            Code = "bridge_failure"
	CodeInjectionFailure         Code = "injection_failure"
	CodeRecoveryFailure          Code = "recovery_failure"
	CodeAudioOnly                Code = "audio_only"
	CodeVideoStalled             Code = "video_stalled"
	CodeReceiverTimeout          Code = "receiver_timeout"
	CodeRTCDisconnected          Code = "rtc_disconnected"
	CodeNativeProbeUnavailable   Code = "native_probe_unavailable"
	CodeNativeTransmitterStalled Code = "native_transmitter_stalled"
	CodeNativeReceiverAudioOnly  Code = "native_receiver_audio_only"
	CodeNativeReceiverNoPackets  Code = "native_receiver_no_packets"
	CodeNativeDecoderStalled     Code = "native_decoder_stalled"
	CodeNativeRenderUnknown      Code = "native_render_unknown"
	CodeTelemetryTest            Code = "telemetry_test"
)

type Event struct {
	Component Component
	Code      Code
	State     string
	Mode      string
	Test      bool

	StatsAvailable bool
	HasAudioSSRC   bool
	HasVideoSSRC   bool
	AudioPackets   uint64
	VideoPackets   uint64
	AudioBytes     uint64
	VideoBytes     uint64
	FramesDecoded  uint64
	ReceiverCount  uint64

	DurationBucket string
	Detail         string
}

type SafeEvent struct {
	Component string
	Code      string
	State     string
	Mode      string
	Test      bool

	StatsAvailable bool
	HasAudioSSRC   bool
	HasVideoSSRC   bool
	AudioPackets   uint64
	VideoPackets   uint64
	AudioBytes     uint64
	VideoBytes     uint64
	FramesDecoded  uint64
	ReceiverCount  uint64
	DurationBucket string
}
