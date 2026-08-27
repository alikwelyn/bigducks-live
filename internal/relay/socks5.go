package relay

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
)

type DialFunc func(ctx context.Context, host string, port int) (net.Conn, error)

type Server struct {
	Address         string
	Allowlist       model.HostAllowlist
	AllowedSuffixes []string
	AllowedPorts    map[int]bool
	Dial            DialFunc
	Timeout         time.Duration
}

func (s *Server) ListenAndServe(ctx context.Context) (string, func(), error) {
	if s == nil || s.Dial == nil {
		return "", nil, fmt.Errorf("relay dialer is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if s.Timeout <= 0 {
		s.Timeout = 10 * time.Second
	}
	address := s.Address
	if address == "" {
		address = "127.0.0.1:0"
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return "", nil, fmt.Errorf("listen for relay: %w", err)
	}
	serverCtx, cancel := context.WithCancel(ctx)
	var once sync.Once
	closeServer := func() {
		once.Do(func() {
			cancel()
			_ = listener.Close()
		})
	}
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				select {
				case <-serverCtx.Done():
					return
				default:
				}
				continue
			}
			go s.handle(serverCtx, conn)
		}
	}()
	return listener.Addr().String(), closeServer, nil
}

func (s *Server) handle(ctx context.Context, client net.Conn) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(s.Timeout))
	if !negotiateNoAuth(client) {
		return
	}
	host, port, ok := readConnectRequest(client)
	if !ok {
		writeReply(client, 8)
		return
	}
	if !s.allows(host, port) {
		writeReply(client, 2)
		return
	}
	dialCtx, cancel := context.WithTimeout(ctx, s.Timeout)
	remote, err := s.Dial(dialCtx, host, port)
	cancel()
	if err != nil || remote == nil {
		writeReply(client, 5)
		return
	}
	defer remote.Close()
	if _, err := client.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	_ = client.SetDeadline(time.Time{})
	_ = remote.SetDeadline(time.Time{})

	done := make(chan struct{}, 2)
	go copyAndSignal(done, remote, client)
	go copyAndSignal(done, client, remote)
	<-done
	_ = client.Close()
	_ = remote.Close()
	<-done
}

func (s *Server) allows(host string, port int) bool {
	if len(s.AllowedPorts) > 0 && !s.AllowedPorts[port] {
		return false
	}
	if s.Allowlist.Contains(host) {
		return true
	}
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	for _, suffix := range s.AllowedSuffixes {
		suffix = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(suffix), "."))
		if suffix != "" && (host == suffix || strings.HasSuffix(host, "."+suffix)) {
			return true
		}
	}
	return false
}

func copyAndSignal(done chan<- struct{}, destination net.Conn, source net.Conn) {
	_, _ = io.Copy(destination, source)
	done <- struct{}{}
}

func negotiateNoAuth(conn net.Conn) bool {
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil || header[0] != 5 {
		return false
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return false
	}
	for _, method := range methods {
		if method == 0 {
			_, err := conn.Write([]byte{5, 0})
			return err == nil
		}
	}
	_, _ = conn.Write([]byte{5, 0xff})
	return false
}

func readConnectRequest(conn net.Conn) (string, int, bool) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil || header[0] != 5 || header[2] != 0 {
		return "", 0, false
	}
	if header[1] != 1 || header[3] != 3 {
		return "", 0, false
	}
	length := make([]byte, 1)
	if _, err := io.ReadFull(conn, length); err != nil || length[0] == 0 {
		return "", 0, false
	}
	hostBytes := make([]byte, int(length[0]))
	if _, err := io.ReadFull(conn, hostBytes); err != nil {
		return "", 0, false
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(conn, portBytes); err != nil {
		return "", 0, false
	}
	port := int(binary.BigEndian.Uint16(portBytes))
	if port < 1 {
		return "", 0, false
	}
	return string(hostBytes), port, true
}

func writeReply(conn net.Conn, code byte) {
	_, _ = conn.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
}

func FormatDestination(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}
