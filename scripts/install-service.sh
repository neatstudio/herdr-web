#!/usr/bin/env bash
# Install (or remove) the service that keeps herdr-web running, so it comes back
# after a reboot without anyone logging in.
#
# Two platforms, one interface: launchd on macOS (a LaunchAgent in the user's
# session) and systemd on Linux (a user unit, so it needs no root; enable-linger
# makes it start at boot rather than at login).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$root/herdr-web"
label="dev.herdr-web"
log_dir="$HOME/.local/share/herdr-web"
log="$log_dir/herdr-web.log"

usage() {
  cat <<'USAGE'
usage: install-service.sh [install|uninstall|status|restart]

  install     register the service and start it now (macOS launchd, Linux systemd)
  uninstall   stop the service and remove it
  status      show whether the platform's service manager runs it
  restart     restart it, e.g. after `make build`

Environment:
  HERDR_WEB_ADDR        Tailscale-facing address (default: first Tailscale IPv4 :5000)
  HERDR_WEB_LOCAL_ADDR  loopback address (default 127.0.0.1:5001)
  HERDR_WEB_HERDR_BIN   herdr binary to inspect and update (default: found on PATH)
  HERDR_WEB_SOCKET      herdr socket path (default ~/.config/herdr/herdr.sock)

The service runs this directory's ./herdr-web, so rebuild before restarting:
  make build && make service-restart
USAGE
}

die() {
  printf 'install-service: %s\n' "$*" >&2
  exit 1
}

# The service managers inherit neither the shell PATH nor a working directory,
# and herdr may live in a per-user bin directory, so the PATH is spelled out.
service_path() {
  printf '%s/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' "$HOME"
}

# Arguments shared by both platforms, so the two units cannot drift apart.
service_args() {
  [[ -n "${HERDR_WEB_SOCKET:-}" ]] && printf '%s\n' "--herdr-socket" "$HERDR_WEB_SOCKET"
  [[ -n "${HERDR_WEB_HERDR_BIN:-}" ]] && printf '%s\n' "--herdr-bin" "$HERDR_WEB_HERDR_BIN"
  [[ -n "${HERDR_WEB_ADDR:-}" ]] && printf '%s\n' "--addr" "$HERDR_WEB_ADDR"
  [[ -n "${HERDR_WEB_LOCAL_ADDR:-}" ]] && printf '%s\n' "--local-addr" "$HERDR_WEB_LOCAL_ADDR"
  return 0
}

install_macos() {
  local target="$HOME/Library/LaunchAgents/$label.plist"
  [[ -x "$binary" ]] || die "missing $binary; run: make build"
  mkdir -p "$log_dir" "$HOME/Library/LaunchAgents"
  # One <string> per argument, and none at all when there are no arguments: an
  # empty <string/> would be passed to the program as an empty argument.
  local args_xml=""
  while IFS= read -r arg; do
    [[ -z "$arg" ]] && continue
    args_xml+="    <string>$arg</string>"$'\n'
  done < <(service_args)
  sed -e "s|__BIN__|$binary|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__LOG__|$log|g" \
      -e "s|__PATH__|$(service_path)|g" \
      "$root/deploy/dev.herdr-web.plist" > "$target"
  # The placeholder line is replaced (or dropped) after the sed, because the
  # replacement itself contains newlines and slashes.
  python3 - "$target" "$args_xml" <<'PY'
import sys
path, args = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
text = text.replace("    <string>__ARGS__</string>\n", args)
open(path, "w", encoding="utf-8").write(text)
PY
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$target"
  echo "installed $label -> $target"
  echo "log: $log"
}

install_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/$label.service"
  [[ -x "$binary" ]] || die "missing $binary; run: make build"
  mkdir -p "$unit_dir" "$log_dir"
  {
    echo "[Unit]"
    echo "Description=herdr-web: web console for a herdr daemon"
    echo "After=network-online.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "WorkingDirectory=$HOME"
    echo "Environment=PATH=$(service_path)"
    echo "ExecStart=$binary$(service_args | sed 's/^/ /' | tr '\n' ' ')"
    echo "Restart=on-failure"
    echo "RestartSec=3"
    echo "StandardOutput=append:$log"
    echo "StandardError=append:$log"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$unit"
  systemctl --user daemon-reload
  systemctl --user enable "$label.service"
  # enable --now leaves an already-running unit alone, so a rebuild would keep
  # the old binary in memory.
  systemctl --user restart "$label.service" 2>/dev/null || systemctl --user start "$label.service"
  # Without lingering a user unit starts at login, not at boot.
  loginctl enable-linger "$(id -un)" 2>/dev/null || \
    echo "note: enable-linger failed; the service starts at login, not at boot" >&2
  echo "installed $label -> $unit"
  echo "log: $log"
}

case "${1:-install}" in
  install)
    case "$(uname -s)" in
      Darwin) install_macos ;;
      Linux) install_systemd ;;
      *) die "unsupported platform: $(uname -s)" ;;
    esac
    ;;
  uninstall)
    case "$(uname -s)" in
      Darwin)
        launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
        rm -f "$HOME/Library/LaunchAgents/$label.plist"
        ;;
      Linux)
        systemctl --user disable --now "$label.service" 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/$label.service"
        systemctl --user daemon-reload 2>/dev/null || true
        ;;
      *) die "unsupported platform: $(uname -s)" ;;
    esac
    echo "removed $label"
    ;;
  status)
    case "$(uname -s)" in
      Darwin)
        if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
          launchctl print "gui/$(id -u)/$label" | grep -E '^\s*(state|pid|program) =' || true
        else
          echo "$label is not loaded"
        fi
        ;;
      Linux)
        systemctl --user status "$label.service" --no-pager 2>/dev/null | head -12 || \
          echo "$label is not loaded"
        ;;
      *) die "unsupported platform: $(uname -s)" ;;
    esac
    ;;
  restart)
    case "$(uname -s)" in
      Darwin) launchctl kickstart -k "gui/$(id -u)/$label" ;;
      Linux) systemctl --user restart "$label.service" ;;
      *) die "unsupported platform: $(uname -s)" ;;
    esac
    echo "restarted $label"
    ;;
  *)
    usage
    exit 64
    ;;
esac
