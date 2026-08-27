package pac_test

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/pac"
)

func TestRenderRoutesExactHostsAndRegionalGatewaySuffix(t *testing.T) {
	script := pac.Render(
		[]string{"gateway.discord.gg", "remote-auth-gateway.discord.gg"},
		[]string{"discord.gg"},
		45123,
	)
	if !strings.Contains(script, "SOCKS5 127.0.0.1:45123") {
		t.Fatal("missing local SOCKS5 route")
	}
	if !strings.Contains(script, `return "DIRECT"`) {
		t.Fatal("missing direct fallback")
	}
	if !strings.Contains(script, `host === routed[i]`) {
		t.Fatal("missing exact host comparison")
	}
	if !strings.Contains(script, `host.endsWith("." + routedSuffixes[i])`) {
		t.Fatal("missing boundary-safe regional gateway suffix comparison")
	}
	if strings.Contains(script, `host.indexOf(routedSuffixes[i])`) {
		t.Fatal("PAC must not use a substring match for gateway suffixes")
	}
	if strings.Contains(script, "proxy.example") {
		t.Fatal("PAC must not expose upstream proxy details")
	}
}

func TestServerServesPACOnlyOnExpectedPath(t *testing.T) {
	server := pac.NewServer([]string{"gateway.discord.gg"}, []string{"discord.gg"}, 45123)
	baseURL, closeServer, err := server.Start()
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer closeServer()

	response, err := http.Get(baseURL)
	if err != nil {
		t.Fatalf("GET PAC error = %v", err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatalf("read PAC error = %v", err)
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "gateway.discord.gg") {
		t.Fatalf("unexpected PAC response: status=%d body=%q", response.StatusCode, body)
	}

	response, err = http.Get(strings.TrimSuffix(baseURL, "/proxy.pac") + "/other")
	if err != nil {
		t.Fatalf("GET other path error = %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("other path status = %d, want %d", response.StatusCode, http.StatusNotFound)
	}
}

func TestServerBindsRequestedLoopbackAddress(t *testing.T) {
	server := pac.NewServerAt("127.0.0.1:0", []string{"gateway.discord.gg"}, []string{"discord.gg"}, 45123)
	baseURL, closeServer, err := server.Start()
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer closeServer()
	if !strings.HasPrefix(baseURL, "http://127.0.0.1:") {
		t.Fatalf("PAC URL = %q", baseURL)
	}
}
