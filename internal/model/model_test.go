package model_test

import (
	"strings"
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

func TestParseEndpointRejectsUnsupportedInputs(t *testing.T) {
	inputs := []string{
		"http://proxy.example:1080",
		"socks5://:1080",
		"socks5://proxy.example",
		"socks5://proxy.example:1080?region=us",
		"socks5://proxy.example:1080#fragment",
		"socks5://proxy.example:0",
		"socks5://proxy.example:65536",
		"socks5://proxy.example:notaport",
		"",
	}
	for _, input := range inputs {
		if _, err := model.ParseEndpoint(input); err == nil {
			t.Errorf("ParseEndpoint(%q) unexpectedly succeeded", input)
		}
	}
}

func TestParseEndpointAcceptsBoundaryPortsAndNormalizes(t *testing.T) {
	endpoint, err := model.ParseEndpoint("  SOCKS5://PROXY.Example.com.:1 ")
	if err != nil {
		t.Fatalf("ParseEndpoint() error = %v", err)
	}
	if endpoint.Scheme != "socks5" {
		t.Fatalf("scheme = %q, want socks5", endpoint.Scheme)
	}
	if endpoint.Host != "proxy.example.com." {
		t.Fatalf("host = %q, want lowercased trimmed host", endpoint.Host)
	}
	if endpoint.Port != 1 {
		t.Fatalf("port = %d, want 1", endpoint.Port)
	}
	endpoint, err = model.ParseEndpoint("socks5://proxy.example:65535")
	if err != nil {
		t.Fatalf("ParseEndpoint(65535) error = %v", err)
	}
	if endpoint.Port != 65535 {
		t.Fatalf("port = %d, want 65535", endpoint.Port)
	}
}

func TestParseEndpointAcceptsUserWithoutPassword(t *testing.T) {
	endpoint, err := model.ParseEndpoint("socks5://alice@proxy.example:1080")
	if err != nil {
		t.Fatalf("ParseEndpoint() error = %v", err)
	}
	if endpoint.User != "alice" {
		t.Fatalf("user = %q, want alice", endpoint.User)
	}
	if endpoint.Pass != "" {
		t.Fatalf("pass = %q, want empty", endpoint.Pass)
	}
}

func TestEndpointAddressBracketsIPv6Host(t *testing.T) {
	endpoint := model.Endpoint{Scheme: "socks5", Host: "::1", Port: 1080}
	if address := endpoint.Address(); address != "[::1]:1080" {
		t.Fatalf("Address() = %q, want [::1]:1080", address)
	}
}

func TestEndpointRedactedURLHidesPassword(t *testing.T) {
	endpoint := model.Endpoint{Scheme: "socks5", Host: "proxy.example", Port: 1080, User: "alice", Pass: "secret"}
	redacted := endpoint.RedactedURL()
	if redacted != "socks5://alice:***@proxy.example:1080" {
		t.Fatalf("RedactedURL() = %q", redacted)
	}
	if strings.Contains(endpoint.RedactedURL(), "secret") {
		t.Fatalf("RedactedURL() leaked the password: %q", redacted)
	}
}

func TestEndpointURLIncludesCredentialsOnlyWhenPresent(t *testing.T) {
	withPassword := model.Endpoint{Scheme: "socks5", Host: "proxy.example", Port: 1080, User: "alice", Pass: "secret"}
	if url := withPassword.URL(); url != "socks5://alice:secret@proxy.example:1080" {
		t.Fatalf("URL() with password = %q", url)
	}
	userOnly := model.Endpoint{Scheme: "socks5", Host: "proxy.example", Port: 1080, User: "alice"}
	if url := userOnly.URL(); url != "socks5://alice@proxy.example:1080" {
		t.Fatalf("URL() user only = %q", url)
	}
	plain := model.Endpoint{Scheme: "socks5", Host: "proxy.example", Port: 1080}
	if url := plain.URL(); url != "socks5://proxy.example:1080" {
		t.Fatalf("URL() plain = %q", url)
	}
}

func TestAllowlistNormalizesAndRepresentsHosts(t *testing.T) {
	allow := model.NewHostAllowlist([]string{" GATEWAY.Discord.gg. ", "", "plain.example"})
	if !allow.Contains("gateway.discord.gg") {
		t.Fatal("expected normalized host to be allowed")
	}
	if !allow.Contains("GATEWAY.DISCORD.GG.") {
		t.Fatal("expected case/trailing-dot variants to be allowed")
	}
	list := allow.Hosts()
	if len(list) != 2 {
		t.Fatalf("Hosts() = %v, want 2 entries", list)
	}
	seen := map[string]bool{}
	for _, host := range list {
		seen[host] = true
	}
	if !seen["gateway.discord.gg"] || !seen["plain.example"] {
		t.Fatalf("Hosts() = %v, want normalized entries", list)
	}
}
