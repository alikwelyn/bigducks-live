//go:build !windows

package injection

func Inspect(_, _ string) (Result, error) {
	return Result{State: StateUnavailable, Reason: ErrUnsupported.Error()}, nil
}

func Ensure(_, _ string, _ []byte) (Result, error) {
	return Result{State: StateUnavailable, Reason: ErrUnsupported.Error()}, nil
}

func Repair(_, _ string) error {
	return ErrUnsupported
}

func RestoreAll(_ string) error {
	return nil
}
