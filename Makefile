# herdr-web: standalone web UI + API bridge for a herdr daemon.
#
#   make build   # build the frontend, embed it, produce ./herdr-web
#   make run     # run from source (serves the embedded bundle)
#   make test    # Go tests + frontend unit tests
#   make e2e     # browser tests against a mocked herdr API
#   make clean

SHELL := /bin/bash
BIN := herdr-web
GO ?= go
GOFLAGS ?= -trimpath
LDFLAGS ?= -s -w
# The released binary should be able to say which release it is.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS += -X main.version=$(VERSION)

.PHONY: all build web go-build run test test-go test-web e2e fmt vet clean \
	install-service uninstall-service service-status service-restart \
	release-archives deploy-remote

all: build

## build: frontend bundle -> single self-contained binary
build: web go-build

## web: build the Vite bundle into web/dist (embedded by go-build)
web:
	@# npm ci, not install: it is lockfile-exact and does not re-resolve the
	@# optional platform packages that npm 11 mis-dedupes.
	cd web && npm ci --no-audit --no-fund
	cd web && npm run build
	@# Vite empties web/dist; restore the placeholder so a later `git status`
	@# does not look like the tracked file was deleted.
	@touch web/dist/.gitkeep

## go-build: compile the bridge with the bundle embedded
go-build:
	$(GO) build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(BIN) .
	@echo "built ./$(BIN) ($$(du -h $(BIN) | cut -f1))"

## run: run the bridge from source; needs web/dist to exist for a real UI
run:
	go run . -addr 127.0.0.1:18080

test: test-go test-web

test-go:
	go test ./... -count=1

test-web:
	cd web && npm run test:unit

e2e:
	cd web && npm run test:e2e:browser

fmt:
	gofmt -w $$(find . -name '*.go' -not -path './web/*')

vet:
	go vet ./...

clean:
	rm -f $(BIN)
	find web/dist -mindepth 1 ! -name .gitkeep -delete 2>/dev/null || true
	rm -rf web/test-results web/playwright-report

## install-service: run at login on the Tailscale and loopback ports
install-service: build
	./scripts/install-service.sh install

uninstall-service:
	./scripts/install-service.sh uninstall

service-status:
	./scripts/install-service.sh status

service-restart:
	./scripts/install-service.sh restart

## release-archives: the per-platform binaries install.sh downloads
# Deliberately does not depend on `clean`: cleaning removes web/dist, and these
# binaries must embed the frontend built just before.
release-archives: go-build web
	@if find web/dist -name '*.map' -print -quit | grep -q .; then \
		echo "release: source maps are not allowed in the embedded bundle" >&2; exit 1; \
	fi
	mkdir -p dist/release
	@for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do \
		os=$${target%/*}; arch=$${target#*/}; \
		echo "building $$os/$$arch"; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 $(GO) build $(GOFLAGS) -trimpath \
			-ldflags="$(LDFLAGS)" -o dist/release/herdr-web-$$os-$$arch . || exit 1; \
		( cd dist/release && shasum -a 256 herdr-web-$$os-$$arch > herdr-web-$$os-$$arch.sha256 2>/dev/null \
			|| sha256sum herdr-web-$$os-$$arch > herdr-web-$$os-$$arch.sha256 ); \
	done
	@echo "archives in dist/release"

## deploy-remote: copy to other hosts and register the service there
##   make deploy-remote TARGETS="nas desktop-7"
# release-archives, not build: the script sends the release artifact for the
# target's platform, and a stale one would ship an old frontend without saying so.
deploy-remote: release-archives
	@test -n "$(TARGETS)" || { echo "usage: make deploy-remote TARGETS=\"host [host:path ...]\"" >&2; exit 64; }
	./scripts/deploy-remote.sh $(TARGETS)

## release-publish: keep the release files where the console serves them from
##   makes this host a release source for every platform, not just its own
release-publish: release-archives
	@dir="$${HERDR_WEB_RELEASE_DIR:-$$HOME/.local/share/herdr-web/releases}"; \
	mkdir -p "$$dir"; \
	cp dist/release/herdr-web-* "$$dir/"; \
	printf '%s\n' "$$(git describe --tags --abbrev=0 2>/dev/null || echo dev)" > "$$dir/version"; \
	echo "published to $$dir:"; ls "$$dir" | head -10
