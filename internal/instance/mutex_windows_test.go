//go:build windows

package instance_test

import (
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/instance"
)

func TestAcquireNamedReportsSecondProcess(t *testing.T) {
	name := `Local\BigDucks.Test.` + time.Now().Format("20060102150405.000000000")
	releaseFirst, alreadyRunning, err := instance.AcquireNamed(name)
	if err != nil || alreadyRunning {
		t.Fatalf("first AcquireNamed() = already=%v err=%v", alreadyRunning, err)
	}
	defer releaseFirst()

	releaseSecond, alreadyRunning, err := instance.AcquireNamed(name)
	if err != nil {
		t.Fatalf("second AcquireNamed() error = %v", err)
	}
	if !alreadyRunning {
		t.Fatal("second AcquireNamed() should report an existing instance")
	}
	if releaseSecond != nil {
		releaseSecond()
	}
}
