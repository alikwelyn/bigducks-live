package telemetry

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrDisabled = errors.New("telemetry is disabled")

type Client interface {
	Send(SafeEvent) error
	Flush(context.Context) error
	Close() error
}

type Factory interface {
	Open(Options) (Client, error)
}

type Options struct {
	Factory  Factory
	Release  string
	CacheDir string
	Mode     string
}

type Reporter struct {
	mu       sync.Mutex
	options  Options
	factory  Factory
	client   Client
	enabled  bool
	lastSent map[string]time.Time
}

func NewReporter(options Options) *Reporter {
	factory := options.Factory
	if factory == nil {
		factory = sentryFactory{}
	}
	return &Reporter{
		options:  options,
		factory:  factory,
		lastSent: make(map[string]time.Time),
	}
}

func (r *Reporter) Enable() error {
	if r == nil {
		return ErrDisabled
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.enabled {
		return nil
	}
	client, err := r.factory.Open(r.options)
	if err != nil {
		return err
	}
	r.client = client
	r.enabled = true
	return nil
}

func (r *Reporter) Disable() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	client := r.client
	r.client = nil
	r.enabled = false
	r.lastSent = make(map[string]time.Time)
	r.mu.Unlock()
	var closeErr error
	if client != nil {
		closeErr = client.Close()
	}
	if purgeErr := r.Purge(); closeErr != nil {
		return closeErr
	} else if purgeErr != nil {
		return purgeErr
	}
	return nil
}

func (r *Reporter) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	client := r.client
	r.client = nil
	r.enabled = false
	r.mu.Unlock()
	if client == nil {
		return nil
	}
	return client.Close()
}

func (r *Reporter) Purge() error {
	if r == nil || r.options.CacheDir == "" {
		return nil
	}
	if err := os.RemoveAll(filepath.Clean(r.options.CacheDir)); err != nil {
		return err
	}
	return nil
}

func (r *Reporter) Test(ctx context.Context) error {
	if r == nil {
		return ErrDisabled
	}
	if ctx == nil {
		ctx = context.Background()
	}
	safe, err := Sanitize(Event{Component: ComponentCore, Code: CodeTelemetryTest, Test: true})
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.enabled || r.client == nil {
		return ErrDisabled
	}
	if err := r.client.Send(safe); err != nil {
		return err
	}
	return r.client.Flush(ctx)
}

func (r *Reporter) Capture(event Event) {
	if r == nil {
		return
	}
	safe, err := Sanitize(event)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.enabled || r.client == nil {
		return
	}
	key := safe.Component + ":" + safe.Code
	if !safe.Test && safe.Component == string(ComponentMedia) {
		if previous, ok := r.lastSent[key]; ok && time.Since(previous) < 5*time.Minute {
			return
		}
		r.lastSent[key] = time.Now()
	}
	_ = r.client.Send(safe)
}

func (r *Reporter) Enabled() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.enabled
}
