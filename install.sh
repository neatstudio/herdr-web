#!/usr/bin/env sh
# Install herdr-web on a machine and register it as a service that starts at
# boot, so the console is there without anyone logging in first.
#
# Two ways in, because not every machine can reach GitHub:
#   curl -fsSL https://github.com/neatstudio/herdr-web/releases/latest/download/install.sh | sh
#   sh install.sh --from /path/to/herdr-web-<os>-<arch>   # a binary you copied over
#
# The binary is self-contained: it embeds the frontend, so nothing else is
# downloaded and no runtime dependency is needed.
set -eu

REPO="neatstudio/herdr-web"
SERVICE_LABEL="dev.herdr-web"
SERVICE_NAME="herdr-web"
DEFAULT_ROOT="${HERDR_WEB_ROOT:-$HOME/.local/share/herdr-web/app}"

die() {
  printf 'herdr-web install: %s\n' "$*" >&2
  exit 1
}

say() {
  printf 'herdr-web install: %s\n' "$*"
}

usage() {
  cat <<'USAGE'
herdr-web installer

Usage:
  curl -fsSL .../install.sh | sh
  sh install.sh [options]

Options:
  --from PATH        install this binary instead of downloading one (offline path)
  --url URL          download the binary from URL (a mirror, or a private host)
  --root DIR         where the binary is installed (default ~/.local/share/herdr-web/app)
  --no-service       install the binary only, do not register the service
  --service          register and start the service (the default)
  --addr HOST:PORT       Tailscale-facing address passed to the service
  --local-addr HOST:PORT loopback address passed to the service
  --herdr-bin PATH       herdr binary the console reports and updates
  --herdr-socket PATH    herdr daemon socket
  -h, --help         show this help

Without --from or --url the release asset for this platform is downloaded from
GitHub. If that host is unreachable, pass --from (or --url) with a copy you
already have; the binary needs nothing else.
USAGE
}

uname_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac
}

uname_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'amd64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

# release_asset prints the asset name for this platform, matching the release
# workflow: herdr-web-<os>-<arch>.
release_asset() {
  printf 'herdr-web-%s-%s' "$(uname_os)" "$(uname_arch)"
}

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 -o "$dest" "$url" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url" || return 1
  else
    die "neither curl nor wget is available to download $url"
  fi
}

verify_checksum() {
  file="$1"
  sum_url="$2"
  if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
    say "no checksum tool available; skipping verification"
    return 0
  fi
  tmp="$file.sha256"
  if ! download "$sum_url" "$tmp" 2>/dev/null; then
    say "no checksum published for this release; skipping verification"
    return 0
  fi
  want="$(awk '{print $1}' "$tmp" | head -1)"
  rm -f "$tmp"
  if command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    got="$(sha256sum "$file" | awk '{print $1}')"
  fi
  [ "$want" = "$got" ] || die "checksum mismatch: expected $want, got $got"
  say "checksum verified"
}

FROM=""
URL=""
ROOT="$DEFAULT_ROOT"
WITH_SERVICE=1
ADDR=""
LOCAL_ADDR=""
HERDR_BIN=""
HERDR_SOCKET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --no-service) WITH_SERVICE=0; shift ;;
    --service) WITH_SERVICE=1; shift ;;
    --addr) ADDR="$2"; shift 2 ;;
    --local-addr) LOCAL_ADDR="$2"; shift 2 ;;
    --herdr-bin) HERDR_BIN="$2"; shift 2 ;;
    --herdr-socket) HERDR_SOCKET="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

BIN="$ROOT/$SERVICE_NAME"
TMP="$BIN.incoming"

# Installing on a machine that already runs herdr-web from a source checkout
# would silently repoint that service at this copy and stop the one being used.
# Both service managers are checked: the guard has to hold on Linux as well.
existing_unit() {
  case "$(uname -s)" in
    Darwin) printf '%s' "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" ;;
    *) printf '%s' "$HOME/.config/systemd/user/$SERVICE_LABEL.service" ;;
  esac
}

if [ "$WITH_SERVICE" -eq 1 ]; then
  EXISTING="$(existing_unit)"
  if [ -f "$EXISTING" ] && ! grep -q "$BIN" "$EXISTING" 2>/dev/null; then
    case "$EXISTING" in
      *.plist) FOUND="$(sed -n 's|.*<string>\(/[^<]*herdr-web\)</string>.*|\1|p' "$EXISTING" | head -1)" ;;
      *) FOUND="$(sed -n 's|^ExecStart=\([^ ]*\).*|\1|p' "$EXISTING" | head -1)" ;;
    esac
    say "a $SERVICE_LABEL service already exists and points elsewhere:"
    say "  ${FOUND:-unknown}"
    say "pass --root to replace it, or --no-service to leave it alone."
    die "refusing to replace a running service that this installer did not create"
  fi
fi

if [ "$WITH_SERVICE" -eq 1 ]; then
  case "$(uname -s)" in
    Darwin)
      EXISTING="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
      if [ -f "$EXISTING" ] && ! grep -q "$BIN" "$EXISTING" 2>/dev/null; then
        say "a $SERVICE_LABEL service already exists and points elsewhere:"
        say "  $(grep -A1 ProgramArguments "$EXISTING" | tail -1 | sed 's/.*<string>\(.*\)<\/string>.*/  \1/')"
        say "pass --root to replace it, or --no-service to leave it alone."
        die "refusing to replace a running service that this installer did not create"
      fi
      ;;
  esac
fi

mkdir -p "$ROOT"

if [ -n "$FROM" ]; then
  [ -f "$FROM" ] || die "no such file: $FROM"
  say "installing from $FROM"
  cp "$FROM" "$TMP"
else
  ASSET="$(release_asset)"
  if [ -n "$URL" ]; then
    BASE="$URL"
  else
    BASE="https://github.com/$REPO/releases/latest/download"
  fi
  say "downloading $BASE/$ASSET"
  # The offline story: say what to do instead of dying with a curl error.
  if ! download "$BASE/$ASSET" "$TMP"; then
    rm -f "$TMP"
    die "could not download $BASE/$ASSET.
This machine cannot reach that host. Copy the binary over and re-run:
  sh install.sh --from /path/to/$ASSET
or point at a mirror:
  sh install.sh --url https://your-mirror/$ASSET"
  fi
  verify_checksum "$TMP" "$BASE/$ASSET.sha256" || true
fi

chmod 0755 "$TMP"
mv "$TMP" "$BIN"
# Clear the quarantine bit macOS puts on downloaded files, or the service cannot
# exec it.
if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
fi

INSTALLED_VERSION="$("$BIN" -version 2>/dev/null || echo "herdr-web unknown")"
say "installed $BIN ($INSTALLED_VERSION)"

if [ "$WITH_SERVICE" -eq 1 ]; then
  export HERDR_WEB_ADDR="$ADDR"
  export HERDR_WEB_LOCAL_ADDR="$LOCAL_ADDR"
  export HERDR_WEB_HERDR_BIN="$HERDR_BIN"
  export HERDR_WEB_SOCKET="$HERDR_SOCKET"
  # The service script lives next to the source tree, not in the release; the
  # release ships this installer, so write the unit from here instead.
  case "$(uname -s)" in
    Darwin)
      PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
      LOG_DIR="$HOME/.local/share/herdr-web"
      mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
      ARGS=""
      [ -n "$ADDR" ] && ARGS="$ARGS
    <string>--addr</string>
    <string>$ADDR</string>"
      [ -n "$LOCAL_ADDR" ] && ARGS="$ARGS
    <string>--local-addr</string>
    <string>$LOCAL_ADDR</string>"
      [ -n "$HERDR_BIN" ] && ARGS="$ARGS
    <string>--herdr-bin</string>
    <string>$HERDR_BIN</string>"
      [ -n "$HERDR_SOCKET" ] && ARGS="$ARGS
    <string>--herdr-socket</string>
    <string>$HERDR_SOCKET</string>"
      cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>$ARGS
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/herdr-web.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/herdr-web.log</string>
</dict>
</plist>
PLIST
      launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST"
      say "service registered: $PLIST"
      say "log: $LOG_DIR/herdr-web.log"
      ;;
    Linux)
      UNIT_DIR="$HOME/.config/systemd/user"
      LOG_DIR="$HOME/.local/share/herdr-web"
      mkdir -p "$UNIT_DIR" "$LOG_DIR"
      ARGS=""
      [ -n "$ADDR" ] && ARGS="$ARGS --addr $ADDR"
      [ -n "$LOCAL_ADDR" ] && ARGS="$ARGS --local-addr $LOCAL_ADDR"
      [ -n "$HERDR_BIN" ] && ARGS="$ARGS --herdr-bin $HERDR_BIN"
      [ -n "$HERDR_SOCKET" ] && ARGS="$ARGS --herdr-socket $HERDR_SOCKET"
      cat > "$UNIT_DIR/$SERVICE_LABEL.service" <<UNIT
[Unit]
Description=herdr-web: web console for a herdr daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=$BIN$ARGS
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOG_DIR/herdr-web.log
StandardError=append:$LOG_DIR/herdr-web.log

[Install]
WantedBy=default.target
UNIT
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user daemon-reload 2>/dev/null || true
        systemctl --user enable "$SERVICE_LABEL.service" 2>/dev/null || true
        # enable --now leaves an already-running unit alone, so an update would
        # replace the file and keep the old build in memory.
        systemctl --user restart "$SERVICE_LABEL.service" 2>/dev/null || \
          systemctl --user start "$SERVICE_LABEL.service" 2>/dev/null || \
          say "note: could not start the service; run: systemctl --user start $SERVICE_LABEL"
        loginctl enable-linger "$(id -un)" 2>/dev/null || true
        say "service registered: $UNIT_DIR/$SERVICE_LABEL.service"
      else
        say "systemctl not found; unit written to $UNIT_DIR/$SERVICE_LABEL.service"
      fi
      say "log: $LOG_DIR/herdr-web.log"
      ;;
  esac
else
  say "skipped the service (-no-service); start it yourself: $BIN"
fi

say "done. The console listens on the Tailscale address (port 5000) and 127.0.0.1 (port 5001)."
