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
	identity, err := CurrentProcess()
	return err == nil && identity.PID != 0
}

func CurrentProcess() (ProcessIdentity, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return ProcessIdentity{}, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return ProcessIdentity{}, err
	}
	var records []processRecord
	for {
		name := windows.UTF16ToString(entry.ExeFile[:])
		if strings.EqualFold(name, "Discord.exe") {
			records = append(records, processRecord{pid: entry.ProcessID, parent: entry.ParentProcessID})
		}
		err := windows.Process32Next(snapshot, &entry)
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			return ProcessIdentity{}, err
		}
	}
	if len(records) == 0 {
		return ProcessIdentity{}, nil
	}
	known := make(map[uint32]bool, len(records))
	for _, record := range records {
		known[record.pid] = true
	}
	// The main client is the matching process that is not a child of another
	// Discord.exe. This avoids selecting crash/update/renderer descendants.
	for _, record := range records {
		if !known[record.parent] {
			return ProcessIdentity{PID: record.pid, Token: strconv.FormatUint(uint64(record.pid), 10)}, nil
		}
	}
	return ProcessIdentity{PID: records[0].pid, Token: strconv.FormatUint(uint64(records[0].pid), 10)}, nil
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
