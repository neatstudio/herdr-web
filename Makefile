# herdr-web: standalone web UI + API bridge for a herdr daemon.
#
#   make build   # build the frontend, embed it, produce ./herdr-web
#   make run     # run from source (serves the embedded bundle)
#   make test    # Go tests + frontend unit tests
#   make e2e     # browser tests against a mocked herdr API
#   make clean

SHELL := /bin/bash
BIN := herdr-web

.PHONY: all build web go-build run test test-go test-web e2e fmt vet clean

all: build

## build: frontend bundle -> single self-contained binary
build: web go-build

## web: build the Vite bundle into web/dist (embedded by go-build)
web:
	cd web && npm install --no-audit --no-fund
	cd web && npm run build
	@# Vite empties web/dist; restore the placeholder so a later `git status`
	@# does not look like the tracked file was deleted.
	@touch web/dist/.gitkeep

## go-build: compile the bridge with the bundle embedded
go-build:
	go build -trimpath -o $(BIN) .
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
