package relay_test

import (
	"context"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/relay"
)

type fakeDialer struct {
	calls  chan string
	remote net.Conn
	peer   net.Conn
}

func (d *fakeDialer) Dial(_ context.Context, host string, port int) (net.Conn, error) {
	d.remote, d.peer = net.Pipe()
	d.calls <- net.JoinHostPort(host, formatPort(port))
	return d.remote, nil
}

func TestServerRejectsNonAllowlistedDestination(t *testing.T) {
	dialer := &fakeDialer{calls: make(chan string, 1)}
	addr := startTestRelay(t, model.NewHostAllowlist([]string{"gateway.discord.gg"}), dialer)
	client := connectAndHandshake(t, addr)
	defer client.Close()

	writeConnectRequest(t, client, "example.com", 443)
	reply := readReply(t, client)
	if reply[1] == 0 {
		t.Fatal("expected non-allowlisted destination to be rejected")
	}
	select {
	case call := <-dialer.calls:
		t.Fatalf("dialer was called for disallowed destination %q", call)
	default:
	}
}

func TestServerBindsRequestedLoopbackAddress(t *testing.T) {
	dialer := &fakeDialer{calls: make(chan string, 1)}
	server := &relay.Server{Address: "127.0.0.1:0", Dial: dialer.Dial, Timeout: time.Second}
	address, closeServer, err := server.ListenAndServe(context.Background())
	if err != nil {
		t.Fatalf("ListenAndServe() error = %v", err)
	}
	t.Cleanup(closeServer)
	if host, _, err := net.SplitHostPort(address); err != nil || host != "127.0.0.1" {
		t.Fatalf("relay address = %q, %v", address, err)
	}
}

func TestServerRelaysBytesForAllowedDestination(t *testing.T) {
	dialer := &fakeDialer{calls: make(chan string, 1)}
	addr := startTestRelay(t, model.NewHostAllowlist([]string{"gateway.discord.gg"}), dialer)
	client := connectAndHandshake(t, addr)
	defer client.Close()

	writeConnectRequest(t, client, "gateway.discord.gg", 443)
	reply := readReply(t, client)
	if reply[1] != 0 {
		t.Fatalf("CONNECT reply code = %d, want success", reply[1])
	}
	if got := <-dialer.calls; got != "gateway.discord.gg:443" {
		t.Fatalf("dialer destination = %q", got)
	}

	writeFromPeer := make(chan error, 1)
	go func() {
		_, err := dialer.peer.Write([]byte("from-peer"))
		writeFromPeer <- err
	}()
	buf := make([]byte, len("from-peer"))
	if _, err := io.ReadFull(client, buf); err != nil {
		t.Fatalf("read peer bytes = %v", err)
	}
	if string(buf) != "from-peer" {
		t.Fatalf("client received %q", buf)
	}
	if err := <-writeFromPeer; err != nil {
		t.Fatalf("write peer bytes = %v", err)
	}

	writeFromClient := make(chan error, 1)
	go func() {
		_, err := client.Write([]byte("from-client"))
		writeFromClient <- err
	}()
	buf = make([]byte, len("from-client"))
	if _, err := io.ReadFull(dialer.peer, buf); err != nil {
		t.Fatalf("read client bytes = %v", err)
	}
	if string(buf) != "from-client" {
		t.Fatalf("peer received %q", buf)
	}
	if err := <-writeFromClient; err != nil {
		t.Fatalf("write client bytes = %v", err)
	}
}

func TestServerAllowsOnlyConfiguredDomainSuffixes(t *testing.T) {
	dialer := &fakeDialer{calls: make(chan string, 1)}
	server := &relay.Server{
		AllowedSuffixes: []string{"discord.com"},
		AllowedPorts:    map[int]bool{443: true},
		Dial:            dialer.Dial,
		Timeout:         time.Second,
	}
	addr, closeServer, err := server.ListenAndServe(context.Background())
	if err != nil {
		t.Fatalf("ListenAndServe() error = %v", err)
	}
	t.Cleanup(closeServer)
	client := connectAndHandshake(t, addr)
	defer client.Close()

	writeConnectRequest(t, client, "api.discord.com", 443)
	reply := readReply(t, client)
	if reply[1] != 0 {
		t.Fatalf("CONNECT reply code = %d, want success", reply[1])
	}
	if got := <-dialer.calls; got != "api.discord.com:443" {
		t.Fatalf("dialer destination = %q", got)
	}
	_ = client.Close()

	rejected := connectAndHandshake(t, addr)
	defer rejected.Close()
	writeConnectRequest(t, rejected, "example.com", 443)
	if reply := readReply(t, rejected); reply[1] == 0 {
		t.Fatal("destination outside configured suffixes was accepted")
	}
	_ = rejected.Close()

	wrongPort := connectAndHandshake(t, addr)
	defer wrongPort.Close()
	writeConnectRequest(t, wrongPort, "api.discord.com", 80)
	if reply := readReply(t, wrongPort); reply[1] == 0 {
		t.Fatal("destination on a non-TLS port was accepted")
	}
}

func TestServerAllowsRegionalGatewaySuffixButRejectsLookalike(t *testing.T) {
	dialer := &fakeDialer{calls: make(chan string, 1)}
	server := &relay.Server{
		AllowedSuffixes: []string{"discord.gg"},
		AllowedPorts:    map[int]bool{443: true},
		Dial:            dialer.Dial,
		Timeout:         time.Second,
	}
	addr, closeServer, err := server.ListenAndServe(context.Background())
	if err != nil {
		t.Fatalf("ListenAndServe() error = %v", err)
	}
	t.Cleanup(closeServer)

	regional := connectAndHandshake(t, addr)
	writeConnectRequest(t, regional, "gateway-us-east1-b.discord.gg", 443)
	if reply := readReply(t, regional); reply[1] != 0 {
		t.Fatalf("regional gateway CONNECT reply = %d, want success", reply[1])
	}
	if got := <-dialer.calls; got != "gateway-us-east1-b.discord.gg:443" {
		t.Fatalf("dialer destination = %q", got)
	}
	_ = regional.Close()

	lookalike := connectAndHandshake(t, addr)
	defer lookalike.Close()
	writeConnectRequest(t, lookalike, "discord.gg.evil.example", 443)
	if reply := readReply(t, lookalike); reply[1] == 0 {
		t.Fatal("lookalike domain was accepted")
	}
}

func startTestRelay(t *testing.T, allowlist model.HostAllowlist, dialer *fakeDialer) string {
	t.Helper()
	server := &relay.Server{
		Allowlist: allowlist,
		Dial:      dialer.Dial,
		Timeout:   time.Second,
	}
	addr, closeServer, err := server.ListenAndServe(context.Background())
	if err != nil {
		t.Fatalf("ListenAndServe() error = %v", err)
	}
	t.Cleanup(closeServer)
	return addr
}

func connectAndHandshake(t *testing.T, addr string) net.Conn {
	t.Helper()
	client, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	if _, err := client.Write([]byte{5, 1, 0}); err != nil {
		t.Fatalf("write handshake = %v", err)
	}
	response := make([]byte, 2)
	if _, err := io.ReadFull(client, response); err != nil {
		t.Fatalf("read handshake = %v", err)
	}
	if response[0] != 5 || response[1] != 0 {
		t.Fatalf("handshake response = %#v", response)
	}
	return client
}

func writeConnectRequest(t *testing.T, client net.Conn, host string, port int) {
	t.Helper()
	request := append([]byte{5, 1, 0, 3, byte(len(host))}, []byte(host)...)
	request = append(request, byte(port>>8), byte(port))
	if _, err := client.Write(request); err != nil {
		t.Fatalf("write CONNECT = %v", err)
	}
}

func readReply(t *testing.T, client net.Conn) []byte {
	t.Helper()
	header := make([]byte, 4)
	if _, err := io.ReadFull(client, header); err != nil {
		t.Fatalf("read reply header = %v", err)
	}
	if header[3] != 1 {
		t.Fatalf("reply address type = %d, want IPv4", header[3])
	}
	reply := make([]byte, 10)
	copy(reply, header)
	if _, err := io.ReadFull(client, reply[4:]); err != nil {
		t.Fatalf("read reply body = %v", err)
	}
	return reply
}

func formatPort(port int) string {
	return strconv.Itoa(port)
}
