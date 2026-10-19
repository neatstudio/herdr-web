#!/usr/bin/env bash
# Deploy herdr-web to other machines over SSH and register it as a service
# there, so each one comes back after a reboot on its own.
#
# Targets are host names that already work with ssh(1): a Host entry in
# ~/.ssh/config, or a name resolved by DNS. With Tailscale, `tailscale status`
# prints the machine names, and those names are in the SSH config or resolvable
# as MagicDNS names, so this deliberately does not talk to the Tailscale API.
#
# The binary is copied, not built remotely: it is self-contained and embeds the
# frontend, so the target needs no Go, no Node and no network access.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$root/herdr-web"
label="dev.herdr-web"
remote_root="${HERDR_WEB_REMOTE_ROOT:-.local/share/herdr-web/app}"

usage() {
  cat <<'USAGE'
usage: deploy-remote.sh [options] TARGET...

  TARGET        host[:path] to deploy to. The host must already be reachable by
                ssh, e.g. an entry in ~/.ssh/config or a MagicDNS/Tailscale name.
                The optional path is where the binary goes on that machine
                (default: ~/.local/share/herdr-web/app, i.e. a relative path).

Options:
  --root DIR        remote install directory (default ~/.local/share/herdr-web/app)
  --addr HOST:PORT  Tailscale address the remote service should listen on
  --local-addr H:P  loopback address for the remote service
  --herdr-bin PATH  herdr binary on the target, for the status panel
  --no-service      copy the binary only, do not touch the target's service
  --dry-run         print what would happen, change nothing
  --list            list the hosts this machine can plausibly reach
  -h, --help        show this help

Environment:
  HERDR_WEB_REMOTE_ROOT  default remote install directory
  HERDR_WEB_SSH_OPTS     extra options passed to ssh/scp

Examples:
  ./scripts/deploy-remote.sh nas
  ./scripts/deploy-remote.sh --addr 100.89.0.7:5000 desktop-7
  ./scripts/deploy-remote.sh server-a:/opt/herdr-web server-b
USAGE
}

say() { printf 'deploy: %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

# Hosts worth a look: ssh_config entries plus the tailnet's names. This is only
# for --list; a target is never resolved through the API.
list_hosts() {
  say "ssh config hosts:"
  awk '/^[Hh]ost[[:space:]]/ { for (i = 2; i <= NF; i++) if ($i !~ /[*?!]/) print "  " $i }' \
    "$HOME/.ssh/config" 2>/dev/null | sort -u | head -40 || true
  if command -v tailscale >/dev/null 2>&1; then
    say "tailscale peers:"
    tailscale status 2>/dev/null | awk 'NR > 1 { print "  " $2 }' | head -40 || true
  fi
}

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)
if [[ -n "${HERDR_WEB_SSH_OPTS:-}" ]]; then
  # shellcheck disable=SC2206
  ssh_opts+=(${HERDR_WEB_SSH_OPTS})
fi

DRY_RUN=0
WITH_SERVICE=1
ADDR=""
LOCAL_ADDR=""
HERDR_BIN=""
TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) remote_root="$2"; shift 2 ;;
    --addr) ADDR="$2"; shift 2 ;;
    --local-addr) LOCAL_ADDR="$2"; shift 2 ;;
    --herdr-bin) HERDR_BIN="$2"; shift 2 ;;
    --no-service) WITH_SERVICE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --list) list_hosts; exit 0 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done

[[ ${#TARGETS[@]} -gt 0 ]] || die "no target given (try --list)"
[[ -x "$binary" ]] || die "missing $binary; run: make build"

# The release asset name, for the message a failed service start leaves behind.
os_arch="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')"

deploy_one() {
  local target="$1"
  local host="${target%%:*}"
  local dir="${remote_root}"
  if [[ "$target" == *:* ]]; then
    dir="${target#*:}"
  fi
  # A relative dir is relative to the remote home, which is what makes the
  # default work without knowing the remote user name.
  local remote_bin="$dir/herdr-web"
  local remote_dir
  case "$dir" in
    /*) remote_dir="$dir" ;;
    *) remote_dir="\$HOME/$dir" ;;
  esac

  say "checking $host"
  if ! ssh "${ssh_opts[@]}" "$host" 'echo ok' >/dev/null 2>&1; then
    say "  $host is not reachable by ssh; add it to ~/.ssh/config first"
    return 1
  fi
  # Refuse a target whose herdr-web service points somewhere else: the same
  # guard the installer applies locally.
  local existing
  existing="$(ssh "${ssh_opts[@]}" "$host" "cat ~/Library/LaunchAgents/$label.plist 2>/dev/null || cat ~/.config/systemd/user/$label.service 2>/dev/null" || true)"
  if [[ -n "$existing" && "$existing" != *"$remote_bin"* ]]; then
    if ssh "${ssh_opts[@]}" "$host" "grep -q 'herdr-web' ~/Library/LaunchAgents/$label.plist 2>/dev/null || grep -q 'herdr-web' ~/.config/systemd/user/$label.service 2>/dev/null"; then
      say "  $host already runs a $label service from another path; leaving it alone."
      say "  remove it there first, or deploy to the same directory."
      return 1
    fi
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    say "  would copy $binary -> $host:$remote_dir/herdr-web"
    say "  would register the service (unless --no-service)"
    return 0
  fi

  say "  copying $(du -h "$binary" | cut -f1) to $host:$dir/"
  ssh "${ssh_opts[@]}" "$host" "mkdir -p $remote_dir" || return 1
  scp "${ssh_opts[@]}" -q "$binary" "$host:$remote_dir/herdr-web.new" || return 1
  ssh "${ssh_opts[@]}" "$host" "chmod 0755 $remote_dir/herdr-web.new && mv $remote_dir/herdr-web.new $remote_dir/herdr-web" || return 1
  say "  installed $host:$remote_dir/herdr-web ($os_arch)"

  if [[ "$WITH_SERVICE" -eq 1 ]]; then
    local args=()
    [[ -n "$ADDR" ]] && args+=(--addr "$ADDR")
    [[ -n "$LOCAL_ADDR" ]] && args+=(--local-addr "$LOCAL_ADDR")
    [[ -n "$HERDR_BIN" ]] && args+=(--herdr-bin "$HERDR_BIN")
    say "  registering the service"
    # The target's own install path is used, so its unit is written by its own
    # script and cannot drift from what this repository generates.
    if ! ssh "${ssh_opts[@]}" "$host" "cd $remote_dir && ./herdr-web -version >/dev/null 2>&1"; then
      say "  warning: the copied binary did not run on $host (wrong architecture?)"
    fi
    if ! ssh "${ssh_opts[@]}" "$host" "command -v systemctl >/dev/null && systemctl --user --version >/dev/null 2>&1 || [ \"\$(uname -s)\" = Darwin ]"; then
      say "  no user service manager on $host; the binary is installed but not registered"
      return 0
    fi
    ssh "${ssh_opts[@]}" "$host" \
      "HERDR_WEB_ADDR='$ADDR' HERDR_WEB_LOCAL_ADDR='$LOCAL_ADDR' HERDR_WEB_HERDR_BIN='$HERDR_BIN' \
       $remote_dir/herdr-web --help >/dev/null 2>&1; true"
    # Write the unit inline: the source tree's script is not on the target.
    write_service "$host" "$remote_dir" "$remote_bin"
  fi
  return 0
}

write_service() {
  local host="$1" remote_dir="$2" remote_bin="$3"
  local args=""
  [[ -n "$ADDR" ]] && args+=" --addr $ADDR"
  [[ -n "$LOCAL_ADDR" ]] && args+=" --local-addr $LOCAL_ADDR"
  [[ -n "$HERDR_BIN" ]] && args+=" --herdr-bin $HERDR_BIN"

  ssh "${ssh_opts[@]}" "$host" "uname -s" > /tmp/hw-target-os.$$ 2>/dev/null || true
  local target_os
  target_os="$(cat /tmp/hw-target-os.$$ 2>/dev/null || echo Linux)"
  rm -f /tmp/hw-target-os.$$

  if [[ "$target_os" == "Darwin" ]]; then
    ssh "${ssh_opts[@]}" "$host" "mkdir -p ~/Library/LaunchAgents ~/.local/share/herdr-web && cat > ~/Library/LaunchAgents/$label.plist <<PLIST
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$remote_bin</string>$(for a in $args; do printf '\n    <string>%s</string>' "$a"; done)
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>\$HOME</string>
  <key>PATH</key><string>\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>WorkingDirectory</key><string>\$HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>\$HOME/.local/share/herdr-web/herdr-web.log</string>
  <key>StandardErrorPath</key><string>\$HOME/.local/share/herdr-web/herdr-web.log</string>
</dict>
</plist>
PLIST
launchctl bootout gui/\$(id -u)/$label 2>/dev/null || true
launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$label.plist" || return 1
    say "  service registered on $host (launchd)"
    return 0
  fi

  ssh "${ssh_opts[@]}" "$host" "mkdir -p ~/.config/systemd/user ~/.local/share/herdr-web && cat > ~/.config/systemd/user/$label.service <<UNIT
[Unit]
Description=herdr-web: web console for a herdr daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=$remote_bin$args
Restart=on-failure
RestartSec=3
StandardOutput=append:%h/.local/share/herdr-web/herdr-web.log
StandardError=append:%h/.local/share/herdr-web/herdr-web.log

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable --now $label.service 2>/dev/null || true
loginctl enable-linger \$(id -un) 2>/dev/null || true" || return 1
  say "  service registered on $host (systemd user unit)"
}

failed=0
for target in "${TARGETS[@]}"; do
  deploy_one "$target" || failed=$((failed + 1))
done

if [[ "$failed" -gt 0 ]]; then
  die "$failed target(s) failed"
fi
say "done: ${#TARGETS[@]} target(s)"
