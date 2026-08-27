package model_test

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/model"
)

func TestEndpointAddressRejectsInvalidPort(t *testing.T) {
	if _, err := model.ParseEndpoint("socks5://127.0.0.1:70000"); err == nil {
		t.Fatal("expected invalid port error")
	}
}

func TestEndpointParserAcceptsCredentials(t *testing.T) {
	endpoint, err := model.ParseEndpoint("socks5://alice:secret@proxy.example:1080")
	if err != nil {
		t.Fatalf("ParseEndpoint() error = %v", err)
	}
	if endpoint.Scheme != "socks5" || endpoint.Host != "proxy.example" || endpoint.Port != 1080 {
		t.Fatalf("unexpected endpoint: %#v", endpoint)
	}
	if endpoint.User != "alice" || endpoint.Pass != "secret" {
		t.Fatalf("unexpected credentials: %#v", endpoint)
	}
}

func TestAllowlistMatchesOnlyExactGatewayHosts(t *testing.T) {
	allow := model.NewHostAllowlist([]string{"gateway.discord.gg"})
	if !allow.Contains("gateway.discord.gg") {
		t.Fatal("expected exact gateway host to be allowed")
	}
	if allow.Contains("evil-gateway.discord.gg") {
		t.Fatal("did not expect lookalike host to be allowed")
	}
}
