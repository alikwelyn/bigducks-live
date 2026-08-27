package proxy

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/alikwelyn/bigducks-live/internal/model"
)

const DefaultSourceURL = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=json&timeout=1500"

const (
	MaxListedTimeout = 1500
	MaxCandidates    = 40
	MinListedUptime  = 90
)

type scrapeResponse struct {
	Proxies []scrapeProxy
}

type scrapeProxy struct {
	Proxy   string
	Alive   *bool
	Uptime  float64
	Timeout float64
	IP_Data scrapeIPData
}

type scrapeIPData struct {
	CountryCode string
}

type listedCandidate struct {
	Endpoint model.Endpoint
	Timeout  float64
}

func ParseProxyScrape(body []byte, excludedCountries map[string]bool, max int) ([]model.Endpoint, error) {
	var response scrapeResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("decode proxy list: %w", err)
	}
	if max <= 0 || max > MaxCandidates {
		max = MaxCandidates
	}

	candidates := make([]listedCandidate, 0, len(response.Proxies))
	seen := make(map[string]struct{}, len(response.Proxies))
	for _, entry := range response.Proxies {
		if entry.Alive != nil && !*entry.Alive {
			continue
		}
		if entry.Uptime > 0 && entry.Uptime < MinListedUptime {
			continue
		}
		if entry.Timeout > MaxListedTimeout {
			continue
		}
		country := strings.ToUpper(strings.TrimSpace(entry.IP_Data.CountryCode))
		if country != "" && excludedCountries[country] {
			continue
		}
		endpoint, err := model.ParseEndpoint(entry.Proxy)
		if err != nil || endpoint.Port == 4145 {
			continue
		}
		key := endpoint.RedactedURL()
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		candidates = append(candidates, listedCandidate{Endpoint: endpoint, Timeout: entry.Timeout})
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Timeout == candidates[j].Timeout {
			return candidates[i].Endpoint.RedactedURL() < candidates[j].Endpoint.RedactedURL()
		}
		return candidates[i].Timeout < candidates[j].Timeout
	})
	if len(candidates) > max {
		candidates = candidates[:max]
	}
	result := make([]model.Endpoint, 0, len(candidates))
	for _, candidate := range candidates {
		result = append(result, candidate.Endpoint)
	}
	return result, nil
}
