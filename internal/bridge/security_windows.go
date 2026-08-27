//go:build windows

package bridge

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func secureUserOnly(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("inspect private path: %w", err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return fmt.Errorf("find current Windows user: %w", err)
	}
	flags := ""
	if info.IsDir() {
		flags = "OICI"
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + user.User.Sid.String() + ")(A;" + flags + ";FA;;;SY)")
	if err != nil {
		return fmt.Errorf("create private Windows security descriptor: %w", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return fmt.Errorf("read private Windows DACL: %w", err)
	}
	information := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION)
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, information, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("apply private Windows DACL: %w", err)
	}
	return nil
}

func ProtectDataDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create private data directory: %w", err)
	}
	if err := secureUserOnly(path); err != nil {
		return err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return fmt.Errorf("list private data directory: %w", err)
	}
	for _, entry := range entries {
		if err := secureUserOnly(path + string(os.PathSeparator) + entry.Name()); err != nil {
			return fmt.Errorf("repair private child %s: %w", entry.Name(), err)
		}
	}
	return nil
}
