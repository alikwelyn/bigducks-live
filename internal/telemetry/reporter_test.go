package telemetry_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/telemetry"
)

type fakeFactory struct {
	opens  int
	client *fakeClient
	err    error
}

type fakeClient struct {
	sent    int
	flushed int
	closed  int
	err     error
}

func (f *fakeFactory) Open(telemetry.Options) (telemetry.Client, error) {
	f.opens++
	if f.err != nil {
		return nil, f.err
	}
	f.client = &fakeClient{}
	return f.client, nil
}

func (f *fakeClient) Send(telemetry.SafeEvent) error {
	if f.err != nil {
		return f.err
	}
	f.sent++
	return nil
}

func (f *fakeClient) Flush(context.Context) error {
	f.flushed++
	return f.err
}

func (f *fakeClient) Close() error {
	f.closed++
	return nil
}

func TestReporterDoesNotCreateTransportWhileDisabled(t *testing.T) {
	factory := &fakeFactory{}
	reporter := telemetry.NewReporter(telemetry.Options{Factory: factory, Release: "0.1.8", CacheDir: t.TempDir()})
	reporter.Capture(telemetry.Event{Component: telemetry.ComponentCore, Code: telemetry.CodeStartupFailure})
	if factory.opens != 0 {
		t.Fatalf("transport opens = %d", factory.opens)
	}
}

func TestReporterDeduplicatesMediaEvents(t *testing.T) {
	factory := &fakeFactory{}
	reporter := telemetry.NewReporter(telemetry.Options{Factory: factory, Release: "0.1.8", CacheDir: t.TempDir()})
	if err := reporter.Enable(); err != nil {
		t.Fatal(err)
	}
	event := telemetry.Event{Component: telemetry.ComponentMedia, Code: telemetry.CodeAudioOnly}
	reporter.Capture(event)
	reporter.Capture(event)
	if got := factory.client.sent; got != 1 {
		t.Fatalf("sent = %d, want 1", got)
	}
}

func TestReporterDisableStopsNewEventsAndPurgesOnlyOwnCache(t *testing.T) {
	cache := t.TempDir()
	marker := filepath.Join(cache, "envelope")
	if err := os.WriteFile(marker, []byte("local"), 0o600); err != nil {
		t.Fatal(err)
	}
	factory := &fakeFactory{}
	reporter := telemetry.NewReporter(telemetry.Options{Factory: factory, Release: "0.1.8", CacheDir: cache})
	if err := reporter.Enable(); err != nil {
		t.Fatal(err)
	}
	if err := reporter.Disable(); err != nil {
		t.Fatal(err)
	}
	reporter.Capture(telemetry.Event{Component: telemetry.ComponentCore, Code: telemetry.CodeStartupFailure})
	if factory.client.sent != 0 {
		t.Fatalf("sent after disable = %d", factory.client.sent)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cache marker error = %v", err)
	}
}

func TestReporterTestFlushesOneExplicitEvent(t *testing.T) {
	factory := &fakeFactory{}
	reporter := telemetry.NewReporter(telemetry.Options{Factory: factory, Release: "0.1.8", CacheDir: t.TempDir()})
	if err := reporter.Enable(); err != nil {
		t.Fatal(err)
	}
	if err := reporter.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if factory.client.sent != 1 || factory.client.flushed != 1 {
		t.Fatalf("sent=%d flushed=%d", factory.client.sent, factory.client.flushed)
	}
}
