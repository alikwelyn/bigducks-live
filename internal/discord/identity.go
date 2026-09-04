package discord

// ProcessIdentity identifies one Discord main-process session.
type ProcessIdentity struct {
	PID   uint32
	Token string
}
