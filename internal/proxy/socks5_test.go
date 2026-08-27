package proxy_test

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
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
