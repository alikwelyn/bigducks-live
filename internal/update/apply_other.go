//go:build !windows

package update

import (
	"context"
	"os/exec"
)

func waitForProcesses(context.Context, []int) error { return nil }

func configureDetachedProcess(*exec.Cmd) {}
