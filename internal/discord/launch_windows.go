//go:build windows

package discord

import (
	"errors"
	"fmt"
	"os/exec"
)

const mediaBypassList = "cdn.discordapp.com;*.discord.media;*.discordapp.net;<local>"

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
