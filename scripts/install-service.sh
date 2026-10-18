#!/usr/bin/env bash
# Install (or remove) the launchd unit that keeps herdr-web running.
# The plist is generated from deploy/dev.herdr-web.plist with absolute paths,
# because launchd inherits neither the shell PATH nor a working directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
label="dev.herdr-web"
target="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/.local/share/herdr-web"
log="$log_dir/herdr-web.log"
binary="$root/herdr-web"

usage() {
  cat <<'USAGE'
usage: install-service.sh [install|uninstall|status|restart]

  install     bake absolute paths into ~/Library/LaunchAgents/dev.herdr-web.plist
  uninstall   stop and remove the unit
  status      show whether launchd runs it
  restart     kickstart the running unit (after `make build`)
USAGE
}

case "${1:-install}" in
  install)
    if [[ ! -x "$binary" ]]; then
      echo "missing $binary; run: make build" >&2
      exit 1
    fi
    mkdir -p "$log_dir" "$HOME/Library/LaunchAgents"
    sed -e "s|__BIN__|$binary|g" \
        -e "s|__HOME__|$HOME|g" \
        -e "s|__LOG__|$log|g" \
        "$root/deploy/dev.herdr-web.plist" > "$target"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$target"
    echo "installed $label -> $target"
    echo "log: $log"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$target"
    echo "removed $label"
    ;;
  status)
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      launchctl print "gui/$(id -u)/$label" | grep -E '^\s*(state|pid|program) =' || true
    else
      echo "$label is not loaded"
    fi
    ;;
  restart)
    launchctl kickstart -k "gui/$(id -u)/$label"
    echo "restarted $label"
    ;;
  *)
    usage
    exit 64
    ;;
esac
