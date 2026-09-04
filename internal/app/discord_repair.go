package app

import "errors"

var ErrProtectionDisabled = errors.New("a proteção está desativada nas configurações")

func repairDiscordPolicy(_ bool, disabled bool, launch func() error) error {
	if disabled {
		return ErrProtectionDisabled
	}
	if launch == nil {
		return ErrRuntimeUnavailable
	}
	return launch()
}
