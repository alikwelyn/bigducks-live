package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
)

func DialViaSOCKS5(ctx context.Context, endpoint model.Endpoint, host string, port int) (net.Conn, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", endpoint.Address())
	if err != nil {
		return nil, fmt.Errorf("connect to proxy %s: %w", endpoint.RedactedURL(), err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = conn.Close()
		}
	}()

	methods := []byte{5, 1, 0}
	if endpoint.User != "" {
		methods = []byte{5, 2, 0, 2}
	}
	if _, err := conn.Write(methods); err != nil {
		return nil, fmt.Errorf("write SOCKS5 greeting: %w", err)
	}
	selection := make([]byte, 2)
	if _, err := io.ReadFull(conn, selection); err != nil || selection[0] != 5 {
		if err == nil {
			err = errors.New("invalid SOCKS5 greeting response")
		}
		return nil, err
	}
	switch selection[1] {
	case 0:
	case 2:
		if endpoint.User == "" {
			return nil, errors.New("proxy requested unsupported credentials")
		}
		user, pass := []byte(endpoint.User), []byte(endpoint.Pass)
		if len(user) > 255 || len(pass) > 255 {
			return nil, errors.New("proxy credentials are too long")
		}
		auth := append([]byte{1, byte(len(user))}, user...)
		auth = append(auth, byte(len(pass)))
		auth = append(auth, pass...)
		if _, err := conn.Write(auth); err != nil {
			return nil, fmt.Errorf("write proxy credentials: %w", err)
		}
		response := make([]byte, 2)
		if _, err := io.ReadFull(conn, response); err != nil || response[1] != 0 {
			if err == nil {
				err = errors.New("proxy authentication failed")
			}
			return nil, err
		}
	default:
		return nil, fmt.Errorf("proxy selected unsupported SOCKS5 method %d", selection[1])
	}

	hostBytes := []byte(host)
	if len(hostBytes) == 0 || len(hostBytes) > 255 {
		return nil, errors.New("target host length is invalid")
	}
	request := append([]byte{5, 1, 0, 3, byte(len(hostBytes))}, hostBytes...)
	portBytes := []byte{0, 0}
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	request = append(request, portBytes...)
	if _, err := conn.Write(request); err != nil {
		return nil, fmt.Errorf("write SOCKS5 CONNECT: %w", err)
	}
	if err := readConnectReply(conn); err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	closeOnError = false
	return conn, nil
}

func readConnectReply(conn net.Conn) error {
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return fmt.Errorf("read SOCKS5 CONNECT response: %w", err)
	}
	if header[0] != 5 {
		return errors.New("invalid SOCKS5 CONNECT response version")
	}
	if header[1] != 0 {
		return fmt.Errorf("SOCKS5 CONNECT failed with code %d", header[1])
	}
	var addressLength int
	switch header[3] {
	case 1:
		addressLength = 4
	case 3:
		length := []byte{0}
		if _, err := io.ReadFull(conn, length); err != nil {
			return fmt.Errorf("read SOCKS5 domain length: %w", err)
		}
		addressLength = int(length[0])
	case 4:
		addressLength = 16
	default:
		return errors.New("invalid SOCKS5 bind address type")
	}
	address := make([]byte, addressLength+2)
	if _, err := io.ReadFull(conn, address); err != nil {
		return fmt.Errorf("read SOCKS5 bind address: %w", err)
	}
	return nil
}

func Probe(ctx context.Context, endpoint model.Endpoint, timeout time.Duration) error {
	status, _, err := requestThrough(ctx, endpoint, "discord.com", "/api/v9/gateway", timeout)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("gateway probe status %d", status)
	}
	return nil
}

func ProbeGateway(ctx context.Context, endpoint model.Endpoint, timeout time.Duration) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		timeout = 6 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := DialViaSOCKS5(requestCtx, endpoint, "gateway.discord.gg", 443)
	if err != nil {
		return err
	}
	defer conn.Close()
	tlsConn := tls.Client(conn, &tls.Config{ServerName: "gateway.discord.gg", MinVersion: tls.VersionTLS12})
	defer tlsConn.Close()
	if err := tlsConn.HandshakeContext(requestCtx); err != nil {
		return fmt.Errorf("gateway TLS handshake through proxy: %w", err)
	}
	return nil
}

func ProbeCountry(ctx context.Context, endpoint model.Endpoint, timeout time.Duration) (string, error) {
	status, body, err := requestThrough(ctx, endpoint, "cloudflare.com", "/cdn-cgi/trace", timeout)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("country probe status %d", status)
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, "loc=") {
			country := strings.ToUpper(strings.TrimSpace(strings.TrimPrefix(line, "loc=")))
			if len(country) == 2 {
				return country, nil
			}
		}
	}
	return "", errors.New("country probe did not return a country")
}

func ProbeEndpoint(ctx context.Context, endpoint model.Endpoint, timeout time.Duration) (model.VerifiedEndpoint, error) {
	return probeEndpoint(ctx, endpoint, timeout, false)
}

func ProbeFullEndpoint(ctx context.Context, endpoint model.Endpoint, timeout time.Duration) (model.VerifiedEndpoint, error) {
	return probeEndpoint(ctx, endpoint, timeout, true)
}

func probeEndpoint(ctx context.Context, endpoint model.Endpoint, timeout time.Duration, includeAPI bool) (model.VerifiedEndpoint, error) {
	started := time.Now()
	if includeAPI {
		if err := Probe(ctx, endpoint, timeout); err != nil {
			return model.VerifiedEndpoint{}, err
		}
	}
	if err := ProbeGateway(ctx, endpoint, timeout); err != nil {
		return model.VerifiedEndpoint{}, err
	}
	country, err := ProbeCountry(ctx, endpoint, timeout)
	if err != nil {
		return model.VerifiedEndpoint{}, err
	}
	return model.VerifiedEndpoint{
		Endpoint:  endpoint,
		LatencyMS: int(time.Since(started).Milliseconds()),
		Country:   country,
		CheckedAt: time.Now().Unix(),
	}, nil
}

func requestThrough(ctx context.Context, endpoint model.Endpoint, host, path string, timeout time.Duration) (int, []byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		timeout = 6 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := DialViaSOCKS5(requestCtx, endpoint, host, 443)
	if err != nil {
		return 0, nil, err
	}
	defer conn.Close()
	tlsConn := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err := tlsConn.HandshakeContext(requestCtx); err != nil {
		return 0, nil, fmt.Errorf("TLS handshake through proxy: %w", err)
	}
	defer tlsConn.Close()
	request := "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\nUser-Agent: BIG-DUCKS-LIVE/1.0\r\n\r\n"
	if _, err := tlsConn.Write([]byte(request)); err != nil {
		return 0, nil, fmt.Errorf("write probe request: %w", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(io.LimitReader(tlsConn, 2*1024*1024)), nil)
	if err != nil {
		return 0, nil, fmt.Errorf("read probe response: %w", err)
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	_ = response.Body.Close()
	if readErr != nil {
		return 0, nil, fmt.Errorf("read probe body: %w", readErr)
	}
	return response.StatusCode, body, nil
}

func EndpointString(endpoint model.Endpoint) string {
	return endpoint.RedactedURL() + " (" + endpoint.Host + ":" + strconv.Itoa(endpoint.Port) + ")"
}
