package telemetry

import "testing"

func TestEventToSentryOmitsEmptyOptionalTags(t *testing.T) {
	event := eventToSentry(SafeEvent{Component: "core", Code: "telemetry_test"})
	if _, ok := event.Tags["state"]; ok {
		t.Fatal("empty state must not be sent as a Sentry tag")
	}
	if _, ok := event.Tags["mode"]; ok {
		t.Fatal("empty mode must not be sent as a Sentry tag")
	}
}
