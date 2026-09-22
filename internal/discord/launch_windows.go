//go:build windows

package discord

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

const mediaBypassList = "cdn.discordapp.com;*.discord.media;*.discordapp.net;<local>"

// companionInstallNames are the secondary Discord flavors that can run next to
// the Stable install. Each has its own user data, single-instance lock, and
// resources directory.
var companionInstallNames = []string{"DiscordCanary", "DiscordPTB", "DiscordDevelopment"}

// CompanionRoots returns the install roots that exist on disk next to the
// primary install. BigDucks launches them with the same protected routing so a
// Canary/PTB session is also born off the restricted IP.
func CompanionRoots(primaryRoot string) []string {
	primary := filepath.Clean(primaryRoot)
	base := filepath.Dir(primary)
	roots := make([]string, 0, len(companionInstallNames))
	for _, name := range companionInstallNames {
		root := filepath.Join(base, name)
		if filepath.Clean(root) == primary {
			continue
		}
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			roots = append(roots, root)
		}
	}
	return roots
}

// LaunchCompanions starts every installed companion Discord with the same
// routing as the primary. Failures are returned for logging but never block
// the primary launch.
func LaunchCompanions(primaryRoot, pacURL, fullProxyURL string) []error {
	var errs []error
	for _, root := range CompanionRoots(primaryRoot) {
		path, err := FindLatest(root)
		if err != nil {
			continue
		}
		if fullProxyURL != "" {
			if _, err := LaunchFull(path, fullProxyURL); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", root, err))
			}
			continue
		}
		if pacURL != "" {
			if _, err := Launch(path, pacURL); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", root, err))
			}
		}
	}
	return errs
}

func BuildArgs(pacURL string) []string {
	return []string{"--proxy-pac-url=" + pacURL}
}

func BuildFullProxyArgs(proxyURL string) []string {
	return []string{
		"--proxy-server=" + proxyURL,
		"--proxy-bypass-list=" + mediaBypassList,
	}
}

func Launch(path, pacURL string) (*exec.Cmd, error) {
	if path == "" {
		return nil, errors.New("Discord executable path is empty")
	}
	if pacURL == "" {
		return nil, errors.New("PAC URL is empty")
	}
	command := exec.Command(path, BuildArgs(pacURL)...)
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start Discord: %w", err)
	}
	return command, nil
}

func LaunchFull(path, proxyURL string) (*exec.Cmd, error) {
	if path == "" {
		return nil, errors.New("Discord executable path is empty")
	}
	if proxyURL == "" {
		return nil, errors.New("proxy URL is empty")
	}
	command := exec.Command(path, BuildFullProxyArgs(proxyURL)...)
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start Discord: %w", err)
	}
	return command, nil
}

func LaunchDirect(path string) (*exec.Cmd, error) {
	if path == "" {
		return nil, errors.New("Discord executable path is empty")
	}
	command := exec.Command(path)
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start Discord: %w", err)
	}
	return command, nil
}
