#!/bin/sh
# Version arithmetic for this repository.
#
# The rule, in the words of the person who asked for it: a component counts to
# 99 and only then rolls over. Small fixes bump the patch, a batch of features
# bumps the minor, and the major moves only when the minor is already 99 — so the
# version creeps upwards instead of leaping to 1.0, 2.0 on a good afternoon.
set -eu

usage() {
  cat <<'USAGE'
Usage:
  version.sh current            print the newest tag
  version.sh next [LEVEL]       print the next version (LEVEL: patch|minor|major)
  version.sh tag  [LEVEL]       create and print that tag (annotated)

LEVEL defaults to patch. A component at 99 rolls over into the next one.
USAGE
}

current() {
  git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0
}

# next_version LEVEL
next_version() {
  level="$1"
  base="$(current)"
  base="${base#v}"
  major="$(echo "$base" | cut -d. -f1)"
  minor="$(echo "$base" | cut -d. -f2)"
  patch="$(echo "$base" | cut -d. -f3 | sed 's/-.*//')"
  [ -n "$major" ] || major=0
  [ -n "$minor" ] || minor=0
  [ -n "$patch" ] || patch=0

  case "$level" in
    patch)
      patch=$((patch + 1))
      if [ "$patch" -gt 99 ]; then
        patch=0
        minor=$((minor + 1))
      fi
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      ;;
    major)
      major=$((major + 1))
      minor=0
      patch=0
      ;;
    *)
      echo "unknown level: $level" >&2
      exit 2
      ;;
  esac
  # The cap that keeps "1.0, 2.0" from arriving on a Tuesday: a minor that would
  # pass 99 carries into the major instead of sitting at 100.
  if [ "$minor" -gt 99 ]; then
    major=$((major + 1))
    minor=0
  fi
  printf 'v%s.%s.%s\n' "$major" "$minor" "$patch"
}

case "${1:-}" in
  current) current ;;
  next) next_version "${2:-patch}" ;;
  tag)
    version="$(next_version "${2:-patch}")"
    git tag -a "$version" -m "$version"
    echo "$version"
    ;;
  -h | --help | "") usage ;;
  *)
    usage
    exit 2
    ;;
esac
