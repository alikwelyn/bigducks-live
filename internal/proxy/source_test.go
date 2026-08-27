package proxy_test

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/proxy"
)

func TestParseProxyScrapeFiltersAndSortsCandidates(t *testing.T) {
	body := []byte(`{
  "proxies": [
    {"proxy":"socks5://198.51.100.10:1080","alive":true,"uptime":99,"timeout":800,"ip_data":{"countryCode":"US"}},
    {"proxy":"socks5://198.51.100.11:1080","alive":true,"uptime":99,"timeout":300,"ip_data":{"countryCode":"FR"}},
    {"proxy":"socks5://198.51.100.12:1080","alive":true,"uptime":99,"timeout":200,"ip_data":{"countryCode":"BR"}},
    {"proxy":"socks5://198.51.100.13:1080","alive":false,"uptime":99,"timeout":100,"ip_data":{"countryCode":"DE"}},
    {"proxy":"socks5://198.51.100.14:4145","alive":true,"uptime":99,"timeout":100,"ip_data":{"countryCode":"DE"}},
    {"proxy":"socks5://198.51.100.15:1080","alive":true,"uptime":99,"timeout":2000,"ip_data":{"countryCode":"DE"}},
    {"proxy":"not-an-endpoint","alive":true,"uptime":99,"timeout":100,"ip_data":{"countryCode":"DE"}}
  ]
}`)

	endpoints, err := proxy.ParseProxyScrape(body, map[string]bool{"BR": true}, 10)
	if err != nil {
		t.Fatalf("ParseProxyScrape() error = %v", err)
	}
	if len(endpoints) != 2 {
		t.Fatalf("endpoint count = %d, want 2", len(endpoints))
	}
	if endpoints[0].Host != "198.51.100.11" || endpoints[1].Host != "198.51.100.10" {
		t.Fatalf("unexpected order: %#v", endpoints)
	}
}
