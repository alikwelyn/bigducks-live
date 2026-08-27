//go:build windows

package discord

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func IsRunning() bool {
	output, err := exec.Command("tasklist.exe", "/FI", "IMAGENAME eq Discord.exe", "/NH").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.EqualFold(fields[0], "Discord.exe") {
			return true
		}
	}
	return false
}

func WaitForProcessTree(ctx context.Context, command *exec.Cmd) error {
	return waitForProcessTree(ctx, command, true)
}

func WaitForProcessTreePreserving(ctx context.Context, command *exec.Cmd) error {
	return waitForProcessTree(ctx, command, false)
}

func waitForProcessTree(ctx context.Context, command *exec.Cmd, killOnCancel bool) error {
	if command == nil || command.Process == nil {
		return errors.New("Discord process is missing")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	rootPID := uint32(command.Process.Pid)
	wait := make(chan error, 1)
	go func() { wait <- command.Wait() }()
	select {
	case err := <-wait:
		scanFailures := 0
		for {
			hasDescendants, scanErr := hasDescendants(rootPID)
			if scanErr != nil {
				scanFailures++
				if scanFailures >= 120 {
					return fmt.Errorf("scan Discord process tree: %w", scanErr)
				}
			} else {
				scanFailures = 0
				if !hasDescendants {
					return err
				}
			}
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			}
		}
	case <-ctx.Done():
		if killOnCancel {
			KillProcessTree(command.Process.Pid)
			select {
			case <-wait:
			case <-time.After(5 * time.Second):
			}
		}
		return ctx.Err()
	}
}

func KillProcessTree(pid int) {
	if pid < 1 {
		return
	}
	_ = exec.Command("taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}

type processRecord struct {
	pid    uint32
	parent uint32
}

func hasDescendants(rootPID uint32) (bool, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return false, err
	}
	records := []processRecord{{pid: entry.ProcessID, parent: entry.ParentProcessID}}
	for {
		err := windows.Process32Next(snapshot, &entry)
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			return false, err
		}
		records = append(records, processRecord{pid: entry.ProcessID, parent: entry.ParentProcessID})
	}

	tree := map[uint32]bool{rootPID: true}
	changed := true
	for changed {
		changed = false
		for _, record := range records {
			if tree[record.parent] && !tree[record.pid] {
				tree[record.pid] = true
				changed = true
			}
		}
	}
	for pid := range tree {
		if pid != rootPID {
			return true, nil
		}
	}
	return false, nil
}
