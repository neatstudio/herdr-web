package server

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// hostResources is what this machine can offer a task right now. Memory is the
// resource a coding agent actually exhausts; CPU is the second signal.
type hostResources struct {
	CPUs           int     `json:"cpus"`
	MemTotalMB     int     `json:"memTotalMB"`
	MemAvailableMB int     `json:"memAvailableMB"`
	Load1          float64 `json:"load1"`
}

// readHostResources is a seam: tests can pretend this is a 1C1G box without
// controlling the machine running the test.
var readHostResources = func() hostResources {
	return currentHostResources()
}

func currentHostResources() hostResources {
	resources := hostResources{CPUs: runtime.NumCPU()}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			value, err := strconv.Atoi(fields[1])
			if err != nil {
				continue
			}
			switch fields[0] {
			case "MemTotal:":
				resources.MemTotalMB = value / 1024
			case "MemAvailable:":
				resources.MemAvailableMB = value / 1024
			}
		}
	}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		if fields := strings.Fields(string(raw)); len(fields) > 0 {
			if load, err := strconv.ParseFloat(fields[0], 64); err == nil {
				resources.Load1 = load
			}
		}
	}
	if resources.MemTotalMB == 0 && runtime.GOOS == "darwin" {
		// sysctl is the portable way to learn total memory on a Mac; available
		// memory is deliberately left unknown rather than guessed.
		if out, err := runSysctl("hw.memsize"); err == nil {
			if bytes, err := strconv.ParseInt(strings.TrimSpace(out), 10, 64); err == nil {
				resources.MemTotalMB = int(bytes / (1024 * 1024))
			}
		}
	}
	return resources
}

var runSysctl = func(name string) (string, error) {
	out, err := exec.Command("sysctl", "-n", name).Output()
	return string(out), err
}

// normalizeWeight keeps an unknown or empty weight at the safe default.
func normalizeWeight(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "light":
		return "light"
	case "heavy":
		return "heavy"
	default:
		return "standard"
	}
}

// weightAdmission is a best-effort gate at the moment a task is offered or
// started. An unknown memory reading (a Mac) is not treated as zero: the gate
// only refuses when it can see that the host is short.
func weightAdmission(weight string, resources hostResources) (bool, string) {
	if resources.MemAvailableMB <= 0 {
		return true, ""
	}
	switch weight {
	case "light":
		if resources.MemAvailableMB < 128 {
			return false, "needs at least 128 MiB free"
		}
	case "heavy":
		if resources.CPUs < 2 || resources.MemAvailableMB < 768 {
			return false, "needs at least 2 CPUs and 768 MiB free"
		}
	default:
		if resources.MemAvailableMB < 256 {
			return false, "needs at least 256 MiB free"
		}
	}
	return true, ""
}
