package telemetry

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/getsentry/sentry-go"
)

const sentryDSN = "https://d6d3529330c54bad7b7f266b1d124580@o4512025900810240.ingest.us.sentry.io/4512025910444032"

type sentryFactory struct{}

func (sentryFactory) Open(options Options) (Client, error) {
	if options.Release == "" {
		return nil, errors.New("telemetry release is empty")
	}
	transport := sentry.NewHTTPSyncTransport()
	client, err := sentry.NewClient(sentry.ClientOptions{
		Dsn:              sentryDSN,
		Release:          options.Release,
		Environment:      "production",
		SendDefaultPII:   false,
		AttachStacktrace: false,
		EnableTracing:    false,
		Transport:        transport,
		HTTPClient: &http.Client{
			Transport: &http.Transport{Proxy: nil},
			Timeout:   5 * time.Second,
		},
		BeforeSend: scrubSentryEvent,
	})
	if err != nil {
		return nil, err
	}
	return &sentryClient{client: client}, nil
}

type sentryClient struct {
	client *sentry.Client
}

func (c *sentryClient) Send(event SafeEvent) error {
	if c == nil || c.client == nil {
		return ErrDisabled
	}
	c.client.CaptureEvent(eventToSentry(event), nil, nil)
	return nil
}

func (c *sentryClient) Flush(ctx context.Context) error {
	if c == nil || c.client == nil {
		return ErrDisabled
	}
	timeout := 2 * time.Second
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining < timeout {
			timeout = remaining
		}
	}
	if timeout <= 0 || !c.client.Flush(timeout) {
		return errors.New("telemetry flush timed out")
	}
	return nil
}

func (c *sentryClient) Close() error {
	if c == nil || c.client == nil {
		return nil
	}
	c.client.Close()
	return nil
}

func eventToSentry(event SafeEvent) *sentry.Event {
	return &sentry.Event{
		Message: "bigducks." + event.Component + "." + event.Code,
		Level:   sentry.LevelInfo,
		Tags: map[string]string{
			"component": event.Component,
			"code":      event.Code,
			"state":     event.State,
			"mode":      event.Mode,
		},
		Contexts: map[string]sentry.Context{
			"diagnostic": {
				"test":            event.Test,
				"stats_available": event.StatsAvailable,
				"has_audio_ssrc":  event.HasAudioSSRC,
				"has_video_ssrc":  event.HasVideoSSRC,
				"audio_packets":   event.AudioPackets,
				"video_packets":   event.VideoPackets,
				"audio_bytes":     event.AudioBytes,
				"video_bytes":     event.VideoBytes,
				"frames_decoded":  event.FramesDecoded,
				"receiver_count":  event.ReceiverCount,
				"duration_bucket": event.DurationBucket,
			},
		},
	}
}

func scrubSentryEvent(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
	if event == nil {
		return nil
	}
	event.User = sentry.User{}
	event.Request = nil
	event.Breadcrumbs = nil
	event.Exception = nil
	event.Attachments = nil
	event.Threads = nil
	event.DebugMeta = nil
	event.Modules = nil
	event.ServerName = ""
	for key := range event.Tags {
		if key != "component" && key != "code" && key != "state" && key != "mode" {
			delete(event.Tags, key)
		}
	}
	for key := range event.Contexts {
		if key != "diagnostic" {
			delete(event.Contexts, key)
		}
	}
	return event
}
