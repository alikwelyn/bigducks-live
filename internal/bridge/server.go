package bridge

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/fileutil"
)

const ControlFileName = "bridge-control.json"

var (
	ErrUnavailable          = errors.New("Discord reload bridge is unavailable")
	ErrDisconnected         = errors.New("Discord reload bridge disconnected")
	ErrTelemetryUnsupported = errors.New("a bridge do Discord sem suporte a telemetria está instalada; use Corrigir Discord")
)

//go:embed assets/discord_bridge.js
var assets embed.FS

type ControlFile struct {
	Address string `json:"address"`
	Token   string `json:"token"`
}

type Status struct {
	Connected bool
	LastSeen  time.Time
}

type MediaEvent struct {
	Session string          `json:"session,omitempty"`
	Kind    string          `json:"event"`
	At      time.Time       `json:"at,omitempty"`
	Native  *NativeSnapshot `json:"native,omitempty"`
}

type protocolMessage struct {
	Type         string         `json:"type"`
	Token        string         `json:"token,omitempty"`
	ID           uint64         `json:"id,omitempty"`
	OK           bool           `json:"ok,omitempty"`
	Error        string         `json:"error,omitempty"`
	URL          string         `json:"url,omitempty"`
	Value        string         `json:"value,omitempty"`
	Session      string         `json:"session,omitempty"`
	Event        string         `json:"event,omitempty"`
	At           time.Time      `json:"at,omitempty"`
	Native       map[string]any `json:"native,omitempty"`
	Enabled      bool           `json:"enabled,omitempty"`
	Capabilities []string       `json:"capabilities,omitempty"`
}

type commandResult struct {
	value string
	err   error
}

type Server struct {
	dataDir string

	mu                 sync.Mutex
	listener           net.Listener
	conn               net.Conn
	encoder            *json.Encoder
	cancel             context.CancelFunc
	token              string
	lastSeen           time.Time
	nextID             uint64
	pending            map[uint64]chan commandResult
	onMediaEvent       func(MediaEvent)
	telemetryEnabled   bool
	telemetrySupported bool
	closed             bool

	closeOnce sync.Once
	closeErr  error
	wait      sync.WaitGroup
}

func NewServer(dataDir string) *Server {
	return &Server{dataDir: dataDir, pending: make(map[uint64]chan commandResult)}
}

func (s *Server) Start(ctx context.Context) error {
	if s == nil {
		return errors.New("bridge server is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if s.dataDir == "" {
		return errors.New("bridge data directory is empty")
	}
	if err := os.MkdirAll(s.dataDir, 0o700); err != nil {
		return fmt.Errorf("create bridge data directory: %w", err)
	}
	if err := secureUserOnly(s.dataDir); err != nil {
		return fmt.Errorf("protect bridge data directory: %w", err)
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return fmt.Errorf("generate bridge token: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for Discord bridge: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)
	controlData, err := json.Marshal(ControlFile{Address: listener.Addr().String(), Token: token})
	if err != nil {
		_ = listener.Close()
		return fmt.Errorf("encode bridge control file: %w", err)
	}
	controlPath := filepath.Join(s.dataDir, ControlFileName)
	temporary := controlPath + ".tmp"
	if err := os.WriteFile(temporary, controlData, 0o600); err != nil {
		_ = listener.Close()
		return fmt.Errorf("write bridge control file: %w", err)
	}
	if err := fileutil.Replace(temporary, controlPath); err != nil {
		_ = os.Remove(temporary)
		_ = listener.Close()
		return fmt.Errorf("replace bridge control file: %w", err)
	}
	if err := secureUserOnly(controlPath); err != nil {
		_ = os.Remove(controlPath)
		_ = listener.Close()
		return fmt.Errorf("protect bridge control file: %w", err)
	}

	serverCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if s.listener != nil || s.closed {
		s.mu.Unlock()
		cancel()
		_ = listener.Close()
		_ = os.Remove(controlPath)
		return errors.New("bridge server has already been started")
	}
	s.listener = listener
	s.token = token
	s.cancel = cancel
	s.mu.Unlock()

	s.wait.Add(1)
	go s.acceptLoop()
	s.wait.Add(1)
	go func() {
		defer s.wait.Done()
		<-serverCtx.Done()
		_ = s.Close()
	}()
	return nil
}

func (s *Server) SetMediaEventHandler(handler func(MediaEvent)) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.onMediaEvent = handler
	s.mu.Unlock()
}

func (s *Server) SetTelemetryEnabled(enabled bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.telemetryEnabled = enabled
	if s.encoder != nil && s.conn != nil && !s.closed {
		_ = s.encoder.Encode(protocolMessage{Type: "telemetry_sync", Enabled: enabled})
	}
	s.mu.Unlock()
}

func (s *Server) TestTelemetry(ctx context.Context) error {
	if err := s.requireTelemetrySupport(); err != nil {
		return err
	}
	_, err := s.command(ctx, protocolMessage{Type: "telemetry_test"})
	return err
}

func (s *Server) DisableTelemetry(ctx context.Context) error {
	s.SetTelemetryEnabled(false)
	if !s.supportsTelemetry() {
		return nil
	}
	_, err := s.command(ctx, protocolMessage{Type: "telemetry_disable"})
	return err
}

func (s *Server) PurgeTelemetry(ctx context.Context) error {
	if !s.supportsTelemetry() {
		return nil
	}
	_, err := s.command(ctx, protocolMessage{Type: "telemetry_purge"})
	return err
}

func (s *Server) Reload(ctx context.Context) error {
	_, err := s.command(ctx, protocolMessage{Type: "reload"})
	return err
}

func (s *Server) CloseConnections(ctx context.Context) error {
	_, err := s.command(ctx, protocolMessage{Type: "close_connections"})
	return err
}

func (s *Server) ResolveProxy(ctx context.Context, targetURL string) (string, error) {
	if targetURL == "" {
		return "", errors.New("proxy resolution URL is empty")
	}
	return s.command(ctx, protocolMessage{Type: "resolve_proxy", URL: targetURL})
}

func (s *Server) command(ctx context.Context, message protocolMessage) (string, error) {
	if s == nil {
		return "", ErrUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if s.conn == nil || s.encoder == nil || s.closed {
		s.mu.Unlock()
		return "", ErrUnavailable
	}
	s.nextID++
	id := s.nextID
	result := make(chan commandResult, 1)
	s.pending[id] = result
	message.ID = id
	if err := s.encoder.Encode(message); err != nil {
		delete(s.pending, id)
		conn := s.conn
		s.mu.Unlock()
		_ = conn.Close()
		return "", fmt.Errorf("send %s command: %w", message.Type, err)
	}
	s.mu.Unlock()

	select {
	case response := <-result:
		return response.value, response.err
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return "", ctx.Err()
	}
}

func (s *Server) Status() Status {
	if s == nil {
		return Status{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return Status{Connected: s.conn != nil && !s.closed, LastSeen: s.lastSeen}
}

func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		listener := s.listener
		conn := s.conn
		cancel := s.cancel
		s.listener = nil
		s.conn = nil
		s.encoder = nil
		s.cancel = nil
		s.failPendingLocked(ErrDisconnected)
		s.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
		if cancel != nil {
			cancel()
		}
		if listener != nil {
			s.closeErr = listener.Close()
			if errors.Is(s.closeErr, net.ErrClosed) {
				s.closeErr = nil
			}
		}
		_ = os.Remove(filepath.Join(s.dataDir, ControlFileName))
	})
	return s.closeErr
}

func Script() []byte {
	data, err := assets.ReadFile("assets/discord_bridge.js")
	if err != nil {
		return nil
	}
	return append([]byte(nil), data...)
}

func (s *Server) acceptLoop() {
	defer s.wait.Done()
	for {
		s.mu.Lock()
		listener := s.listener
		closed := s.closed
		s.mu.Unlock()
		if closed || listener == nil {
			return
		}
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		s.wait.Add(1)
		go s.handleClient(conn)
	}
}

func (s *Server) handleClient(conn net.Conn) {
	defer s.wait.Done()
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	decoder := json.NewDecoder(conn)
	var hello protocolMessage
	if err := decoder.Decode(&hello); err != nil || hello.Type != "hello" {
		return
	}
	s.mu.Lock()
	if s.closed || hello.Token != s.token || s.conn != nil {
		s.mu.Unlock()
		return
	}
	s.conn = conn
	s.encoder = json.NewEncoder(conn)
	s.telemetrySupported = hasCapability(hello.Capabilities, "telemetry")
	s.lastSeen = time.Now()
	_ = s.encoder.Encode(protocolMessage{Type: "telemetry_sync", Enabled: s.telemetryEnabled})
	s.mu.Unlock()
	_ = conn.SetReadDeadline(time.Time{})

	defer s.disconnect(conn)
	for {
		var message protocolMessage
		if err := decoder.Decode(&message); err != nil {
			return
		}
		if message.Type == "media_event" {
			var native *NativeSnapshot
			if message.Event == "native_rtc_snapshot" && message.Native != nil {
				normalized, normalizeErr := NormalizeNativeSnapshot(message.Native)
				if normalizeErr != nil {
					continue
				}
				native = &normalized
			}
			s.mu.Lock()
			handler := s.onMediaEvent
			s.lastSeen = time.Now()
			s.mu.Unlock()
			if handler != nil {
				handler(MediaEvent{Session: message.Session, Kind: message.Event, At: message.At, Native: native})
			}
			continue
		}
		if message.Type != "result" || message.ID == 0 {
			continue
		}
		s.mu.Lock()
		s.lastSeen = time.Now()
		result := s.pending[message.ID]
		delete(s.pending, message.ID)
		s.mu.Unlock()
		if result == nil {
			continue
		}
		if message.OK {
			result <- commandResult{value: message.Value}
		} else {
			messageError := message.Error
			if messageError == "" {
				messageError = "Discord rejected the reload command"
			}
			result <- commandResult{err: errors.New(messageError)}
		}
	}
}

func (s *Server) disconnect(conn net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != conn {
		return
	}
	s.conn = nil
	s.encoder = nil
	s.telemetrySupported = false
	s.failPendingLocked(ErrDisconnected)
}

func (s *Server) requireTelemetrySupport() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil || s.encoder == nil || s.closed {
		return ErrUnavailable
	}
	if !s.telemetrySupported {
		return ErrTelemetryUnsupported
	}
	return nil
}

func (s *Server) supportsTelemetry() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn != nil && s.encoder != nil && s.telemetrySupported && !s.closed
}

func hasCapability(capabilities []string, wanted string) bool {
	for _, capability := range capabilities {
		if capability == wanted {
			return true
		}
	}
	return false
}

func (s *Server) failPendingLocked(err error) {
	for id, result := range s.pending {
		delete(s.pending, id)
		select {
		case result <- commandResult{err: err}:
		default:
		}
	}
}
