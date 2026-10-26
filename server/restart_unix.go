//go:build !windows

package server

import (
	"os"
	"syscall"
)

// execSelf replaces the current process, keeping the terminal attached. This is
// only for a foreground console with no supervisor to start a fresh process.
func execSelf(path string) error {
	return syscall.Exec(path, os.Args, os.Environ())
}
