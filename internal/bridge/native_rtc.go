package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

var ErrInvalidNativeSnapshot = errors.New("invalid native RTC snapshot")

const maxSafeJSONNumber = float64(9007199254740991)

type NativeSnapshot struct {
	Hooked           bool    `json:"hooked"`
	StreamConnection bool    `json:"streamConnection"`
	StatsAvailable   bool    `json:"statsAvailable"`
	DemandActive     bool    `json:"demandActive"`
	HasAudioSSRC     bool    `json:"hasAudioSsrc"`
	HasVideoSSRC     bool    `json:"hasVideoSsrc"`
	AudioPackets     uint64  `json:"audioPackets"`
	VideoPackets     uint64  `json:"videoPackets"`
	AudioBytes       uint64  `json:"audioBytes"`
	VideoBytes       uint64  `json:"videoBytes"`
	AudioFrames      uint64  `json:"audioFrames"`
	VideoFrames      uint64  `json:"videoFrames"`
	CaptureFrames    uint64  `json:"captureFrames"`
	EncodedFrames    uint64  `json:"encodedFrames"`
	FramesDecoded    uint64  `json:"framesDecoded"`
	FramesDropped    uint64  `json:"framesDropped"`
	ReceiverCount    uint64  `json:"receiverCount"`
	Width            uint32  `json:"width"`
	Height           uint32  `json:"height"`
	InputFPS         float64 `json:"inputFPS"`
	EncodedFPS       float64 `json:"encodedFPS"`
	RawShape         string  `json:"-"`
}

func NormalizeNativeSnapshot(raw map[string]any) (NativeSnapshot, error) {
	var out NativeSnapshot
	if raw == nil {
		return out, fmt.Errorf("%w: nil", ErrInvalidNativeSnapshot)
	}
	out.Hooked = boolValue(raw["hooked"])
	out.StreamConnection = boolValue(raw["streamConnection"])
	out.StatsAvailable = boolValue(raw["statsAvailable"])
	out.DemandActive = boolValue(raw["demandActive"])
	out.HasAudioSSRC = boolValue(raw["hasAudioSsrc"])
	out.HasVideoSSRC = boolValue(raw["hasVideoSsrc"])

	counters := []struct {
		key string
		dst *uint64
	}{
		{"audioPackets", &out.AudioPackets}, {"videoPackets", &out.VideoPackets},
		{"audioBytes", &out.AudioBytes}, {"videoBytes", &out.VideoBytes},
		{"audioFrames", &out.AudioFrames}, {"videoFrames", &out.VideoFrames},
		{"captureFrames", &out.CaptureFrames}, {"encodedFrames", &out.EncodedFrames},
		{"framesDecoded", &out.FramesDecoded}, {"framesDropped", &out.FramesDropped},
		{"receiverCount", &out.ReceiverCount},
	}
	for _, item := range counters {
		value, present := raw[item.key]
		if !present {
			continue
		}
		number, ok := safeUint(value)
		if !ok {
			return NativeSnapshot{}, fmt.Errorf("%w: %s", ErrInvalidNativeSnapshot, item.key)
		}
		*item.dst = number
	}
	if value, present := raw["inputFPS"]; present {
		var ok bool
		out.InputFPS, ok = safeFloat(value)
		if !ok {
			return NativeSnapshot{}, fmt.Errorf("%w: inputFPS", ErrInvalidNativeSnapshot)
		}
	}
	if value, present := raw["encodedFPS"]; present {
		var ok bool
		out.EncodedFPS, ok = safeFloat(value)
		if !ok {
			return NativeSnapshot{}, fmt.Errorf("%w: encodedFPS", ErrInvalidNativeSnapshot)
		}
	}
	return out, nil
}

func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func safeUint(value any) (uint64, bool) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		if typed < 0 {
			return 0, false
		}
		return uint64(typed), true
	case int64:
		if typed < 0 {
			return 0, false
		}
		return uint64(typed), true
	case uint:
		return uint64(typed), true
	case uint64:
		return typed, true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		number = parsed
	default:
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > maxSafeJSONNumber || math.Trunc(number) != number {
		return 0, false
	}
	return uint64(number), true
}

func safeFloat(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok {
		if parsed, parsedOK := value.(json.Number); parsedOK {
			var err error
			number, err = parsed.Float64()
			ok = err == nil
		}
	}
	return number, ok && !math.IsNaN(number) && !math.IsInf(number, 0) && number >= 0 && number <= 100000
}
