package injection

import "errors"

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
