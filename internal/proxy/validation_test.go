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

func TestProbeDiscordLatencyTargetsDiscordRegionEndpoint(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer listener.Close()
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	target := make(chan string, 1)
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
		length := []byte{0}
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
		target <- net.JoinHostPort(string(host), strconv.Itoa(int(binary.BigEndian.Uint16(portBytes))))
		_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
		serverErr <- nil
	}()

	endpoint := model.Endpoint{Scheme: "socks5", Host: "127.0.0.1", Port: port}
	if err := proxy.ProbeDiscordLatency(context.Background(), endpoint, time.Second); err == nil {
		t.Fatal("ProbeDiscordLatency() unexpectedly succeeded against a non-TLS fake proxy")
	}
	if got := <-target; got != "latency.discord.media:443" {
		t.Fatalf("target = %q, want latency.discord.media:443", got)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("fake proxy error = %v", err)
	}
}
