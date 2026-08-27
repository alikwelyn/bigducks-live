//go:build windows

package bridge

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestSecureUserOnlyProtectsFileDACL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token.json")
	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if err := secureUserOnly(path); err != nil {
		t.Fatalf("secureUserOnly() error = %v", err)
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo() error = %v", err)
	}
	control, _, err := descriptor.Control()
	if err != nil {
		t.Fatalf("Control() error = %v", err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("security descriptor control = %#x, want protected DACL", control)
	}
}

func TestProtectDataDirectoryAddsInheritableACEsAndRepairsChildren(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	child := filepath.Join(path, "discordstream.log")
	if err := os.WriteFile(child, []byte("readable"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	empty, err := windows.SecurityDescriptorFromString("D:P")
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString() error = %v", err)
	}
	emptyDACL, _, err := empty.DACL()
	if err != nil {
		t.Fatalf("DACL() error = %v", err)
	}
	if err := windows.SetNamedSecurityInfo(child, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, emptyDACL, nil); err != nil {
		t.Fatalf("SetNamedSecurityInfo() error = %v", err)
	}

	if err := ProtectDataDirectory(path); err != nil {
		t.Fatalf("ProtectDataDirectory() error = %v", err)
	}
	if data, err := os.ReadFile(child); err != nil || string(data) != "readable" {
		t.Fatalf("ReadFile() = %q, %v", data, err)
	}

	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo() error = %v", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatalf("DACL() error = %v", err)
	}
	foundInheritable := false
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil {
			t.Fatalf("GetAce(%d) error = %v", index, err)
		}
		flags := ace.Header.AceFlags
		if flags&windows.OBJECT_INHERIT_ACE != 0 && flags&windows.CONTAINER_INHERIT_ACE != 0 {
			foundInheritable = true
		}
	}
	if !foundInheritable {
		t.Fatal("private directory DACL has no inheritable ACE")
	}
}
