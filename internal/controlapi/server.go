package controlapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/app"
	"github.com/alikwelyn/bigducks-live/internal/bridge"
	"github.com/alikwelyn/bigducks-live/internal/fileutil"
)

const ControlFileName = "core-control.json"

type ControlFile struct {
	Address string `json:"address"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
}

type ServerOptions struct {
	DataDir  string
	Runtime  *app.RuntimeControl
	Shutdown func()
}

type Server struct {
	options    ServerOptions
	mu         sync.Mutex
	listener   net.Listener
	httpServer *http.Server
	control    ControlFile
	closeOnce  sync.Once
}

func NewServer(options ServerOptions) *Server {
	return &Server{options: options}
}

func (s *Server) Start(ctx context.Context) error {
	if s == nil || s.options.Runtime == nil {
		return errors.New("core control runtime is unavailable")
	}
	if s.options.DataDir == "" {
		return errors.New("core control data directory is empty")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := bridge.ProtectDataDirectory(s.options.DataDir); err != nil {
		return err
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return fmt.Errorf("generate core control token: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for core control: %w", err)
	}
	control := ControlFile{Address: listener.Addr().String(), Token: hex.EncodeToString(tokenBytes), PID: os.Getpid()}
	if err := writeControlFile(filepath.Join(s.options.DataDir, ControlFileName), control); err != nil {
		_ = listener.Close()
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/status", s.auth(s.status))
	mux.HandleFunc("/v1/reconnect", s.auth(s.action(s.options.Runtime.Reconnect)))
	mux.HandleFunc("/v1/reload", s.auth(s.action(s.options.Runtime.Reload)))
	mux.HandleFunc("/v1/test-route", s.auth(s.action(s.options.Runtime.TestRoute)))
	mux.HandleFunc("/v1/shutdown", s.auth(s.shutdown))
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	s.mu.Lock()
	s.listener = listener
	s.httpServer = httpServer
	s.control = control
	s.mu.Unlock()
	go func() { _ = httpServer.Serve(listener) }()
	go func() {
		<-ctx.Done()
		_ = s.Close()
	}()
	return nil
}

func (s *Server) Address() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.control.Address
}

func (s *Server) ControlPath() string {
	if s == nil {
		return ""
	}
	return filepath.Join(s.options.DataDir, ControlFileName)
}

func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	var result error
	s.closeOnce.Do(func() {
		s.mu.Lock()
		server := s.httpServer
		listener := s.listener
		s.httpServer = nil
		s.listener = nil
		s.mu.Unlock()
		if server != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			result = server.Shutdown(ctx)
			cancel()
		} else if listener != nil {
			result = listener.Close()
		}
		_ = os.Remove(s.ControlPath())
	})
	return result
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		provided := request.Header.Get("Authorization")
		expected := "Bearer " + s.control.Token
		if len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			writeError(writer, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(writer, request)
	}
}

func (s *Server) status(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(writer, http.StatusOK, s.options.Runtime.Status())
}

func (s *Server) action(action func(context.Context) error) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writeError(writer, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if action == nil {
			writeError(writer, http.StatusServiceUnavailable, app.ErrRuntimeUnavailable.Error())
			return
		}
		if err := action(request.Context()); err != nil {
			status := http.StatusServiceUnavailable
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				status = http.StatusGatewayTimeout
			}
			writeError(writer, status, err.Error())
			return
		}
		writeJSON(writer, http.StatusOK, map[string]bool{"ok": true})
	}
}

func (s *Server) shutdown(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(writer, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"ok": true})
	if s.options.Shutdown != nil {
		go s.options.Shutdown()
	}
}

func writeControlFile(path string, control ControlFile) error {
	data, err := json.Marshal(control)
	if err != nil {
		return fmt.Errorf("encode core control file: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return fmt.Errorf("write core control file: %w", err)
	}
	if err := fileutil.Replace(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace core control file: %w", err)
	}
	return nil
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
