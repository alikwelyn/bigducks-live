package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/controlapi"
	"github.com/alikwelyn/bigducks-live/internal/logging"
)

type Options struct {
	Executable string
	DataDir    string
	Logger     *logging.Logger
	ReadyWait  time.Duration
	StopWait   time.Duration
}

type coreProcess struct {
	command *exec.Cmd
	done    chan struct{}
	mu      sync.Mutex
	err     error
}

type Supervisor struct {
	options Options
	mu      sync.Mutex
	process *coreProcess
}

func New(options Options) *Supervisor {
	if options.ReadyWait <= 0 {
		options.ReadyWait = 20 * time.Second
	}
	if options.StopWait <= 0 {
		options.StopWait = 8 * time.Second
	}
	return &Supervisor{options: options}
}

func (s *Supervisor) Start(ctx context.Context) error {
	if s == nil || s.options.Executable == "" || s.options.DataDir == "" {
		return errors.New("core supervisor is not configured")
	}
	s.mu.Lock()
	if s.process != nil {
		s.mu.Unlock()
		return nil
	}
	_ = os.Remove(filepath.Join(s.options.DataDir, controlapi.ControlFileName))
	command := exec.Command(s.options.Executable, "--core")
	configureProcess(command)
	if err := command.Start(); err != nil {
		s.mu.Unlock()
		return fmt.Errorf("start protection core: %w", err)
	}
	process := &coreProcess{command: command, done: make(chan struct{})}
	s.process = process
	s.mu.Unlock()
	go func() {
		process.mu.Lock()
		process.err = command.Wait()
		process.mu.Unlock()
		close(process.done)
		s.clearProcess(process)
	}()
	if err := s.waitReady(ctx, process); err != nil {
		_ = command.Process.Kill()
		<-process.done
		s.mu.Lock()
		if s.process == process {
			s.process = nil
		}
		s.mu.Unlock()
		return err
	}
	if s.options.Logger != nil {
		s.options.Logger.Printf("protection core started with pid %d", command.Process.Pid)
	}
	return nil
}

func (s *Supervisor) Restart(ctx context.Context) error {
	if err := s.stop(ctx); err != nil && s.options.Logger != nil {
		s.options.Logger.Printf("graceful core stop failed before restart: %v", err)
	}
	return s.Start(ctx)
}

func (s *Supervisor) Stop(ctx context.Context) error {
	return s.stop(ctx)
}

func (s *Supervisor) Client() (*controlapi.Client, error) {
	if s == nil {
		return nil, errors.New("core supervisor is unavailable")
	}
	return controlapi.LoadClient(filepath.Join(s.options.DataDir, controlapi.ControlFileName))
}

func (s *Supervisor) PID() int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.process == nil || s.process.command == nil || s.process.command.Process == nil {
		return 0
	}
	return s.process.command.Process.Pid
}

func (s *Supervisor) Running() bool {
	return s != nil && s.PID() > 0
}

func (s *Supervisor) stop(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	process := s.process
	s.mu.Unlock()
	if process == nil {
		return nil
	}
	client, err := s.Client()
	if err == nil {
		shutdownCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		err = client.Shutdown(shutdownCtx)
		cancel()
	}
	timer := time.NewTimer(s.options.StopWait)
	defer timer.Stop()
	select {
	case <-process.done:
		s.clearProcess(process)
		waitErr := process.waitErr()
		if waitErr != nil && !isExpectedExit(waitErr) {
			return waitErr
		}
		return err
	case <-ctx.Done():
		_ = process.command.Process.Kill()
		<-process.done
		s.clearProcess(process)
		return ctx.Err()
	case <-timer.C:
		_ = process.command.Process.Kill()
		<-process.done
		s.clearProcess(process)
		return errors.New("protection core did not stop within the deadline")
	}
}

func (s *Supervisor) waitReady(ctx context.Context, process *coreProcess) error {
	deadline := time.NewTimer(s.options.ReadyWait)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-process.done:
			err := process.waitErr()
			if err == nil {
				return errors.New("protection core exited before becoming ready")
			}
			return fmt.Errorf("protection core exited before becoming ready: %w", err)
		case <-ticker.C:
			client, err := s.Client()
			if err != nil {
				continue
			}
			probeCtx, cancel := context.WithTimeout(ctx, time.Second)
			_, err = client.Status(probeCtx)
			cancel()
			if err == nil {
				return nil
			}
		case <-deadline.C:
			return errors.New("protection core did not become ready within the deadline")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (p *coreProcess) waitErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

func (s *Supervisor) clearProcess(process *coreProcess) {
	s.mu.Lock()
	if s.process == process {
		s.process = nil
	}
	s.mu.Unlock()
}

func isExpectedExit(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 0
}
