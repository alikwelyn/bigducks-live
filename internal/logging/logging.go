package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Logger struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
}

func New(path string, maxBytes int64) (*Logger, error) {
	if path == "" {
		return nil, fmt.Errorf("log path is empty")
	}
	if maxBytes < 1 {
		return nil, fmt.Errorf("log size must be positive")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}
	logger := &Logger{path: path, maxBytes: maxBytes}
	logger.mu.Lock()
	defer logger.mu.Unlock()
	if err := logger.trimLocked(); err != nil {
		return nil, err
	}
	return logger, nil
}

func (l *Logger) Printf(format string, args ...any) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	line := time.Now().Format("2006-01-02T15:04:05.000-07:00") + " " + fmt.Sprintf(format, args...) + "\n"
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	_, _ = file.WriteString(line)
	_ = file.Close()
	_ = l.trimLocked()
}

func (l *Logger) trimLocked() error {
	info, err := os.Stat(l.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("stat log file: %w", err)
	}
	if info.Size() <= l.maxBytes {
		return nil
	}

	data, err := os.ReadFile(l.path)
	if err != nil {
		return fmt.Errorf("read log file: %w", err)
	}
	keep := l.maxBytes / 2
	if keep < 1 {
		keep = 1
	}
	if int64(len(data)) > keep {
		data = data[len(data)-int(keep):]
	}
	if err := os.WriteFile(l.path, data, 0o600); err != nil {
		return fmt.Errorf("trim log file: %w", err)
	}
	return nil
}
