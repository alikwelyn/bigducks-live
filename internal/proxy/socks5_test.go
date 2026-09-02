package proxy_test

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
)

func TestDialViaSOCKS5UsesDomainConnectAndRelaysBytes(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer listener.Close()
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	seenTarget := make(chan string, 1)
	serverErr := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(time.Second))

		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			serverErr <- err
			return
		}
		if string(greeting) != string([]byte{5, 1, 0}) {
			serverErr <- &testError{"unexpected greeting"}
			return
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			serverErr <- err
			return
		}

		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			serverErr <- err
			return
		}
		if header[0] != 5 || header[1] != 1 || header[3] != 3 {
			serverErr <- &testError{"unexpected CONNECT header"}
			return
		}
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			serverErr <- err
			return
		}
		host := make([]byte, int(length[0]))
		if _, err := io.ReadFull(conn, host); err != nil {
			serverErr <- err
			return
		}
		portBytes := make([]byte, 2)
		if _, err := io.ReadFull(conn, portBytes); err != nil {
			serverErr <- err
			return
		}
		seenTarget <- net.JoinHostPort(string(host), strconv.Itoa(int(binary.BigEndian.Uint16(portBytes))))
		if _, err := conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
			serverErr <- err
			return
		}

		request := make([]byte, 4)
		if _, err := io.ReadFull(conn, request); err != nil {
			serverErr <- err
			return
		}
		if string(request) != "ping" {
			serverErr <- &testError{"unexpected payload"}
			return
		}
		_, _ = conn.Write([]byte("pong"))
		serverErr <- nil
	}()

	endpoint := model.Endpoint{Scheme: "socks5", Host: "127.0.0.1", Port: port}
	conn, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err != nil {
		t.Fatalf("DialViaSOCKS5() error = %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write payload = %v", err)
	}
	response := make([]byte, 4)
	if _, err := io.ReadFull(conn, response); err != nil {
		t.Fatalf("read payload = %v", err)
	}
	if string(response) != "pong" {
		t.Fatalf("response = %q", response)
	}
	if target := <-seenTarget; target != "gateway.discord.gg:443" {
		t.Fatalf("target = %q", target)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("fake proxy error = %v", err)
	}
}

func TestProbeGatewayTargetsTheRealGatewayHost(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer listener.Close()
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	targets := make(chan string, 1)
	serverErr := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(time.Second))

		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			serverErr <- err
			return
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			serverErr <- err
			return
		}

		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			serverErr <- err
			return
		}
		if header[3] != 3 {
			serverErr <- &testError{"gateway target was not sent as a domain"}
			return
		}
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			serverErr <- err
			return
		}
		host := make([]byte, int(length[0]))
		if _, err := io.ReadFull(conn, host); err != nil {
			serverErr <- err
			return
		}
		portBytes := make([]byte, 2)
		if _, err := io.ReadFull(conn, portBytes); err != nil {
			serverErr <- err
			return
		}
		targets <- net.JoinHostPort(string(host), strconv.Itoa(int(binary.BigEndian.Uint16(portBytes))))
		_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
		serverErr <- nil
	}()

	endpoint := model.Endpoint{Scheme: "socks5", Host: "127.0.0.1", Port: port}
	if err := proxy.ProbeGateway(context.Background(), endpoint, time.Second); err == nil {
		t.Fatal("ProbeGateway() unexpectedly succeeded against a non-TLS fake proxy")
	}
	if target := <-targets; target != "gateway.discord.gg:443" {
		t.Fatalf("target = %q", target)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("fake proxy error = %v", err)
	}
}

type testError struct{ message string }

func (e *testError) Error() string { return e.message }

// serveSOCKS5 runs a fake SOCKS5 server on loopback and returns an endpoint
// pointing at it plus a channel that receives the handler's result.
func serveSOCKS5(t *testing.T, handler func(net.Conn) error) (model.Endpoint, chan error) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	handlerErr := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			handlerErr <- acceptErr
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		handlerErr <- handler(conn)
	}()
	return model.Endpoint{Scheme: "socks5", Host: "127.0.0.1", Port: port}, handlerErr
}

// readGreeting consumes the full SOCKS5 version-identifier/method-selection
// message so handlers do not leave trailing method bytes in the stream.
func readGreeting(conn net.Conn) ([]byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, err
	}
	if header[0] != 5 {
		return nil, &testError{"greeting did not start with SOCKS5 version"}
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return nil, err
	}
	return append(header, methods...), nil
}

func TestDialViaSOCKS5AuthenticatesWithCredentials(t *testing.T) {
	const user, pass = "alice", "secret-password"
	authSeen := make(chan []byte, 1)
	endpoint, handlerErr := serveSOCKS5(t, func(conn net.Conn) error {
		greeting, err := readGreeting(conn)
		if err != nil {
			return err
		}
		if string(greeting) != string([]byte{5, 2, 0, 2}) {
			return &testError{"credentials did not offer no-auth and user/pass"}
		}
		if _, err := conn.Write([]byte{5, 2}); err != nil {
			return err
		}
		auth := make([]byte, 2)
		if _, err := io.ReadFull(conn, auth); err != nil {
			return err
		}
		if auth[0] != 1 {
			return &testError{"missing RFC1929 auth version"}
		}
		userBytes := make([]byte, int(auth[1]))
		if _, err := io.ReadFull(conn, userBytes); err != nil {
			return err
		}
		passLength := make([]byte, 1)
		if _, err := io.ReadFull(conn, passLength); err != nil {
			return err
		}
		passBytes := make([]byte, int(passLength[0]))
		if _, err := io.ReadFull(conn, passBytes); err != nil {
			return err
		}
		authSeen <- append(userBytes, passBytes...)
		if _, err := conn.Write([]byte{1, 0}); err != nil {
			return err
		}
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return err
		}
		if header[3] != 3 {
			return &testError{"CONNECT target was not a domain"}
		}
		_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
		return nil
	})
	endpoint.User, endpoint.Pass = user, pass

	conn, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err != nil {
		t.Fatalf("DialViaSOCKS5() error = %v", err)
	}
	defer conn.Close()
	if err := <-handlerErr; err != nil {
		t.Fatalf("fake proxy error = %v", err)
	}
	if credentials := <-authSeen; string(credentials) != user+pass {
		t.Fatalf("authenticated with %q, want %q", credentials, user+pass)
	}
}

func TestDialViaSOCKS5UsesNoAuthWhenServerSelectsIt(t *testing.T) {
	endpoint, handlerErr := serveSOCKS5(t, func(conn net.Conn) error {
		if _, err := readGreeting(conn); err != nil {
			return err
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return err
		}
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return err
		}
		if header[1] != 1 {
			return &testError{"client skipped CONNECT after no-auth selection"}
		}
		_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
		return nil
	})
	endpoint.User, endpoint.Pass = "alice", "secret"

	conn, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err != nil {
		t.Fatalf("DialViaSOCKS5() error = %v", err)
	}
	defer conn.Close()
	if err := <-handlerErr; err != nil {
		t.Fatalf("fake proxy error = %v", err)
	}
}

func TestDialViaSOCKS5RejectsFailedAuthentication(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		if _, err := conn.Write([]byte{5, 2}); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{1, 1})
		return nil
	})
	endpoint.User, endpoint.Pass = "alice", "wrong"

	if _, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443); err == nil {
		t.Fatal("DialViaSOCKS5() unexpectedly succeeded after rejected authentication")
	}
}

func TestDialViaSOCKS5RejectsUnsupportedMethodSelection(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{5, 99})
		return nil
	})

	_, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err == nil || !strings.Contains(err.Error(), "unsupported SOCKS5 method 99") {
		t.Fatalf("DialViaSOCKS5() error = %v, want unsupported method", err)
	}
}

func TestDialViaSOCKS5RejectsInvalidGreetingVersion(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{4, 0})
		return nil
	})

	_, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err == nil || !strings.Contains(err.Error(), "invalid SOCKS5 greeting response") {
		t.Fatalf("DialViaSOCKS5() error = %v, want invalid greeting", err)
	}
}

func TestDialViaSOCKS5RejectsOverlongCredentials(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{5, 2})
		return nil
	})
	endpoint.User, endpoint.Pass = strings.Repeat("u", 256), "p"

	_, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err == nil || !strings.Contains(err.Error(), "credentials are too long") {
		t.Fatalf("DialViaSOCKS5() error = %v, want overlong credentials", err)
	}
}

func TestDialViaSOCKS5RejectsEmptyTargetHost(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{5, 0})
		return nil
	})

	_, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "", 443)
	if err == nil || !strings.Contains(err.Error(), "target host length is invalid") {
		t.Fatalf("DialViaSOCKS5() error = %v, want invalid target host", err)
	}
}

func TestDialViaSOCKS5RejectsConnectFailureCode(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return err
		}
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{5, 1, 0, 1, 0, 0, 0, 0, 0, 0})
		return nil
	})

	_, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err == nil || !strings.Contains(err.Error(), "SOCKS5 CONNECT failed with code 1") {
		t.Fatalf("DialViaSOCKS5() error = %v, want CONNECT failure code", err)
	}
}

func TestDialViaSOCKS5RejectsInvalidBindAddressType(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return err
		}
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{5, 0, 0, 9, 0, 0, 0, 0, 0, 0})
		return nil
	})

	_, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err == nil || !strings.Contains(err.Error(), "invalid SOCKS5 bind address type") {
		t.Fatalf("DialViaSOCKS5() error = %v, want invalid bind address", err)
	}
}

func TestDialViaSOCKS5RejectsTruncatedConnectReply(t *testing.T) {
	endpoint, _ := serveSOCKS5(t, func(conn net.Conn) error {
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return err
		}
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return err
		}
		_, _ = conn.Write([]byte{5, 0, 0})
		return nil
	})

	_, err := proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err == nil || !strings.Contains(err.Error(), "read SOCKS5 CONNECT response") {
		t.Fatalf("DialViaSOCKS5() error = %v, want truncated CONNECT reply", err)
	}
}

func TestDialViaSOCKS5ReportsConnectionFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	_ = listener.Close()
	endpoint := model.Endpoint{Scheme: "socks5", Host: "127.0.0.1", Port: port}

	_, err = proxy.DialViaSOCKS5(context.Background(), endpoint, "gateway.discord.gg", 443)
	if err == nil || !strings.Contains(err.Error(), "connect to proxy socks5://127.0.0.1:") {
		t.Fatalf("DialViaSOCKS5() error = %v, want redacted connection failure", err)
	}
}

func TestEndpointStringRedactsCredentials(t *testing.T) {
	endpoint := model.Endpoint{Scheme: "socks5", Host: "proxy.example", Port: 1080, User: "alice", Pass: "secret"}
	text := proxy.EndpointString(endpoint)
	if strings.Contains(text, "secret") {
		t.Fatalf("EndpointString() leaked the password: %q", text)
	}
	if !strings.Contains(text, "proxy.example:1080") {
		t.Fatalf("EndpointString() = %q, want host and port", text)
	}
}
