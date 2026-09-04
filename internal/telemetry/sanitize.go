package telemetry

import (
	"errors"
	"fmt"
)

var ErrUnsafeEvent = errors.New("telemetry event is not allowed")

var allowedCodes = map[Code]struct{}{
	CodeStartupFailure:           {},
	CodeBridgeFailure:            {},
	CodeInjectionFailure:         {},
	CodeRecoveryFailure:          {},
	CodeAudioOnly:                {},
	CodeVideoStalled:             {},
	CodeReceiverTimeout:          {},
	CodeRTCDisconnected:          {},
	CodeNativeProbeUnavailable:   {},
	CodeNativeTransmitterStalled: {},
	CodeNativeReceiverNoPackets:  {},
	CodeNativeDecoderStalled:     {},
	CodeNativeRenderUnknown:      {},
	CodeTelemetryTest:            {},
}

var allowedComponents = map[Component]struct{}{
	ComponentCore:   {},
	ComponentBridge: {},
	ComponentMedia:  {},
}

var allowedStates = map[string]struct{}{
	"":                           {},
	"unknown":                    {},
	"not_streaming":              {},
	"stream_starting":            {},
	"streaming":                  {},
	"audio_only":                 {},
	"video_stalled":              {},
	"receiver_timeout":           {},
	"rtc_disconnected":           {},
	"native_probe_unavailable":   {},
	"native_transmitter_stalled": {},
	"native_receiver_audio_only": {},
	"native_receiver_no_packets": {},
	"native_decoder_stalled":     {},
	"native_render_unknown":      {},
	"native_rtc_disconnected":    {},
}

var allowedModes = map[string]struct{}{
	"": {}, "gateway": {}, "full": {},
}

var allowedDurationBuckets = map[string]struct{}{
	"": {}, "short": {}, "medium": {}, "long": {},
}

func Sanitize(event Event) (SafeEvent, error) {
	if _, ok := allowedComponents[event.Component]; !ok {
		return SafeEvent{}, fmt.Errorf("%w: component", ErrUnsafeEvent)
	}
	if _, ok := allowedCodes[event.Code]; !ok {
		return SafeEvent{}, fmt.Errorf("%w: code", ErrUnsafeEvent)
	}
	if _, ok := allowedStates[event.State]; !ok {
		return SafeEvent{}, fmt.Errorf("%w: state", ErrUnsafeEvent)
	}
	if _, ok := allowedModes[event.Mode]; !ok {
		return SafeEvent{}, fmt.Errorf("%w: mode", ErrUnsafeEvent)
	}
	if _, ok := allowedDurationBuckets[event.DurationBucket]; !ok {
		return SafeEvent{}, fmt.Errorf("%w: duration", ErrUnsafeEvent)
	}
	if event.Detail != "" {
		return SafeEvent{}, fmt.Errorf("%w: detail", ErrUnsafeEvent)
	}
	return SafeEvent{
		Component:      event.Component.String(),
		Code:           string(event.Code),
		State:          event.State,
		Mode:           event.Mode,
		Test:           event.Test,
		StatsAvailable: event.StatsAvailable,
		HasAudioSSRC:   event.HasAudioSSRC,
		HasVideoSSRC:   event.HasVideoSSRC,
		AudioPackets:   event.AudioPackets,
		VideoPackets:   event.VideoPackets,
		AudioBytes:     event.AudioBytes,
		VideoBytes:     event.VideoBytes,
		FramesDecoded:  event.FramesDecoded,
		ReceiverCount:  event.ReceiverCount,
		DurationBucket: event.DurationBucket,
	}, nil
}

func (component Component) String() string { return string(component) }
