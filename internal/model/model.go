package model

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

type Endpoint struct {
	Scheme string
	Host   string
	Port   int
	User   string
	Pass   string
}

type VerifiedEndpoint struct {
	Endpoint
	LatencyMS int
	Country   string
	CheckedAt int64
}

type State struct {
	Pool      []VerifiedEndpoint
	SavedRun  string
	Installed bool
	UpdatedAt int64
}

type HostAllowlist struct {
	hosts map[string]struct{}
}

func ParseEndpoint(raw string) (Endpoint, error) {
	value := strings.TrimSpace(raw)
	parsed, err := url.Parse(value)
	if err != nil {
		return Endpoint{}, fmt.Errorf("parse proxy endpoint: %w", err)
	}
	if strings.ToLower(parsed.Scheme) != "socks5" {
		return Endpoint{}, fmt.Errorf("unsupported proxy scheme %q", parsed.Scheme)
	}
	if parsed.Hostname() == "" {
		return Endpoint{}, fmt.Errorf("proxy host is empty")
	}
	if parsed.Port() == "" {
		return Endpoint{}, fmt.Errorf("proxy port is missing")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return Endpoint{}, fmt.Errorf("proxy port is invalid: %q", parsed.Port())
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return Endpoint{}, fmt.Errorf("proxy endpoint cannot contain query or fragment")
	}

	endpoint := Endpoint{
		Scheme: "socks5",
		Host:   strings.ToLower(parsed.Hostname()),
		Port:   port,
	}
	if parsed.User != nil {
		endpoint.User = parsed.User.Username()
		if password, ok := parsed.User.Password(); ok {
			endpoint.Pass = password
		}
	}
	return endpoint, nil
}

func (e Endpoint) Address() string {
	return net.JoinHostPort(e.Host, strconv.Itoa(e.Port))
}

func (e Endpoint) RedactedURL() string {
	credentials := ""
	if e.User != "" {
		credentials = e.User + ":***@"
	}
	return fmt.Sprintf("%s://%s%s", e.Scheme, credentials, net.JoinHostPort(e.Host, strconv.Itoa(e.Port)))
}

func (e Endpoint) URL() string {
	parsed := url.URL{Scheme: e.Scheme, Host: e.Address()}
	if e.User != "" {
		if e.Pass == "" {
			parsed.User = url.User(e.User)
		} else {
			parsed.User = url.UserPassword(e.User, e.Pass)
		}
	}
	return parsed.String()
}

func NewHostAllowlist(hosts []string) HostAllowlist {
	set := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		normalized := normalizeHost(host)
		if normalized != "" {
			set[normalized] = struct{}{}
		}
	}
	return HostAllowlist{hosts: set}
}

func (a HostAllowlist) Contains(host string) bool {
	_, ok := a.hosts[normalizeHost(host)]
	return ok
}

func (a HostAllowlist) Hosts() []string {
	result := make([]string, 0, len(a.hosts))
	for host := range a.hosts {
		result = append(result, host)
	}
	return result
}

func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
}
