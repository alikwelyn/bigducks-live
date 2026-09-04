package app

// DiscordLifecycleState describes the observed Discord process lifecycle.
type DiscordLifecycleState string

const (
	DiscordClosed   DiscordLifecycleState = "discord_closed"
	DiscordStarting DiscordLifecycleState = "discord_starting"
	DiscordRunning  DiscordLifecycleState = "discord_running"
)

// DiscordIdentity identifies one Discord main-process session.
type DiscordIdentity struct {
	PID   uint32
	Token string
}

// LifecycleTracker filters transient process-enumeration gaps and detects new sessions.
type LifecycleTracker struct {
	absenceLimit int
	identity     DiscordIdentity
	absences     int
	seen         bool
}

func NewLifecycleTracker(absenceLimit int) *LifecycleTracker {
	if absenceLimit < 1 {
		absenceLimit = 1
	}
	return &LifecycleTracker{absenceLimit: absenceLimit}
}

func (t *LifecycleTracker) Observe(identity DiscordIdentity) DiscordLifecycleState {
	if t == nil {
		return DiscordClosed
	}
	if identity.PID == 0 {
		if !t.seen {
			return DiscordClosed
		}
		t.absences++
		if t.absences < t.absenceLimit {
			return DiscordRunning
		}
		t.seen = false
		t.identity = DiscordIdentity{}
		return DiscordClosed
	}

	t.absences = 0
	if !t.seen {
		t.identity = identity
		t.seen = true
		return DiscordStarting
	}
	if t.identity != identity {
		t.identity = identity
		return DiscordStarting
	}
	return DiscordRunning
}
