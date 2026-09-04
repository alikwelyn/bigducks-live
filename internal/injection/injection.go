package injection

import (
	"errors"
	"strings"
)

const (
	MetadataFileName = "injection.json"
	BridgeFileName   = "discord_bridge.js"
	Marker           = "discordstream-electron-bridge-v2"
)

var ErrUnsupported = errors.New("Discord injection is not supported on this platform")

type State string

const (
	StateVanilla       State = "vanilla"
	StateRecognizedMod State = "recognized_mod"
	StateOurs          State = "ours"
	StateUnknownMod    State = "unknown_mod"
	StateUnavailable   State = "unavailable"
)

type Result struct {
	State          State
	Installed      bool
	RepairRequired bool
	Reason         string
}

// IsRetryable identifies an installation result that can be caused by an
// in-progress Discord update rather than a permanent integration problem.
func IsRetryable(result Result) bool {
	return result.State == StateUnavailable && strings.Contains(strings.ToLower(result.Reason), "app.asar was not found")
}
