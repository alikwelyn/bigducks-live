package app

import "testing"

func TestExplicitDiscordRepairLaunchesWhenAutomaticStartupIsDisabled(t *testing.T) {
	launched := false
	err := repairDiscordPolicy(false, false, func() error {
		launched = true
		return nil
	})
	if err != nil {
		t.Fatalf("repairDiscordPolicy() error = %v", err)
	}
	if !launched {
		t.Fatal("explicit Discord repair did not launch Discord")
	}
}

func TestExplicitDiscordRepairRefusesDisabledProtection(t *testing.T) {
	launched := false
	err := repairDiscordPolicy(false, true, func() error {
		launched = true
		return nil
	})
	if err == nil {
		t.Fatal("repairDiscordPolicy() unexpectedly allowed disabled protection")
	}
	if launched {
		t.Fatal("explicit Discord repair launched while protection was disabled")
	}
}
