package server

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// selfRestart starts the binary now on disk. A supervised process exits after
// queueing a supervisor restart; a foreground process replaces itself with
// syscall.Exec so a local console does not stay on the old inode forever.
func selfRestart() error {
	execPath, err := selfExecutable()
	if err != nil {
		return err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(execPath); resolveErr == nil {
		execPath = resolved
	}
	if serviceManaged() {
		return requestSupervisorRestart()
	}
	return execSelf(execPath)
}

// serviceManaged reports whether exiting this process will be followed by a
// fresh one from a service manager. HERDR_WEB_SERVICE is set by the installer;
// the systemd/launchd checks keep units installed before that flag working.
func serviceManaged() bool {
	if strings.TrimSpace(os.Getenv("HERDR_WEB_SERVICE")) == "1" {
		return true
	}
	switch runtime.GOOS {
	case "linux":
		return os.Getenv("INVOCATION_ID") != "" || os.Getenv("SYSTEMD_EXEC_PID") != ""
	case "darwin":
		if strings.Contains(os.Getenv("XPC_SERVICE_NAME"), "dev.herdr-web") {
			return true
		}
		pid := strconv.Itoa(os.Getpid())
		for _, label := range []string{"dev.herdr-web", "homebrew.mxcl.herdr-web"} {
			out, err := exec.Command("launchctl", "print", "gui/"+strconv.Itoa(os.Getuid())+"/"+label).Output()
			if err == nil && strings.Contains(string(out), "pid = "+pid) {
				return true
			}
		}
	}
	return false
}

func requestSupervisorRestart() error {
	switch runtime.GOOS {
	case "linux":
		if os.Getuid() == 0 {
			return fleetSpawn("systemctl", []string{"--no-block", "restart", "dev.herdr-web"})
		}
		return fleetSpawn("systemctl", []string{"--user", "--no-block", "restart", "dev.herdr-web"})
	case "darwin":
		return fleetSpawn("launchctl", []string{"kickstart", "-k", "gui/" + currentUID() + "/dev.herdr-web"})
	default:
		return errors.New("no service manager")
	}
}

func currentUID() string {
	return strconv.Itoa(os.Getuid())
}
