package pac

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
)

func Render(hosts, suffixes []string, relayPort int) string {
	hostJSON, _ := json.Marshal(normalizeList(hosts))
	suffixJSON, _ := json.Marshal(normalizeList(suffixes))
	if relayPort < 1 || relayPort > 65535 {
		return "function FindProxyForURL(url, host) { return \"DIRECT\"; }\n"
	}
	return fmt.Sprintf(
		"var routed = %s;\n"+
			"var routedSuffixes = %s;\n"+
			"function FindProxyForURL(url, host) {\n"+
			"  host = String(host).toLowerCase().replace(/\\.$/, \"\");\n"+
			"  for (var i = 0; i < routedSuffixes.length; i++) {\n"+
			"    if (host === routedSuffixes[i] || host.endsWith(\".\" + routedSuffixes[i])) return \"SOCKS5 127.0.0.1:%d\";\n"+
			"  }\n"+
			"  for (var i = 0; i < routed.length; i++) {\n"+
			"    if (host === routed[i]) return \"SOCKS5 127.0.0.1:%d\";\n"+
			"  }\n"+
			"  return \"DIRECT\";\n"+
			"}\n",
		string(hostJSON), string(suffixJSON), relayPort, relayPort,
	)
}

func normalizeList(values []string) []string {
	unique := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
		if value != "" {
			unique[value] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(unique))
	for value := range unique {
		ordered = append(ordered, value)
	}
	sort.Strings(ordered)
	return ordered
}

type Server struct {
	address    string
	script     string
	httpServer *http.Server
	listener   net.Listener
	once       sync.Once
}

func NewServer(hosts, suffixes []string, relayPort int) *Server {
	return NewServerAt("127.0.0.1:0", hosts, suffixes, relayPort)
}

func NewServerAt(address string, hosts, suffixes []string, relayPort int) *Server {
	return &Server{address: address, script: Render(hosts, suffixes, relayPort)}
}

func (s *Server) Start() (string, func(), error) {
	address := s.address
	if address == "" {
		address = "127.0.0.1:0"
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return "", nil, fmt.Errorf("listen for PAC: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/proxy.pac", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writer.Header().Set("Content-Type", "application/x-ns-proxy-autoconfig")
		writer.Header().Set("Cache-Control", "no-store")
		_, _ = writer.Write([]byte(s.script))
	})
	s.listener = listener
	s.httpServer = &http.Server{Handler: mux}
	go func() {
		_ = s.httpServer.Serve(listener)
	}()
	closeServer := func() {
		s.once.Do(func() {
			_ = s.httpServer.Close()
			_ = listener.Close()
		})
	}
	return "http://" + listener.Addr().String() + "/proxy.pac", closeServer, nil
}

func (s *Server) Close(ctx context.Context) error {
	if s == nil || s.httpServer == nil {
		return nil
	}
	s.once.Do(func() {
		_ = s.listener.Close()
	})
	return s.httpServer.Shutdown(ctx)
}
