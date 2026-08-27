package fileutil

import "fmt"

func Replace(source, destination string) error {
	if source == "" || destination == "" {
		return fmt.Errorf("source and destination are required")
	}
	return replace(source, destination)
}
