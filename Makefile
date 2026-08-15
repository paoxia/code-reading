SHELL := /bin/sh
export PATH := $(HOME)/.local/bin:$(PATH)

PROJECTS_FILE ?= projects.json
DEPTH ?= 1
PROJECT ?=
JQ ?= jq
NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 5173
PREVIEW_PORT ?= 4173

.PHONY: help install dev serve build preview site-check clone clone-one status

help:
	@echo "Code Reading"
	@echo ""
	@echo "Page:"
	@echo "  make install                         Install locked frontend dependencies"
	@echo "  make dev                             Start VitePress at http://127.0.0.1:5173"
	@echo "  make dev HOST=0.0.0.0 PORT=8080      Start on a custom address"
	@echo "  make build                           Build the static site into html/"
	@echo "  make preview                         Preview the build at http://127.0.0.1:4173"
	@echo "  make site-check                      Build and verify expected pages"
	@echo ""
	@echo "Source projects:"
	@echo "  make clone                           Clone every missing project (shallow by default)"
	@echo "  make clone DEPTH=0                   Clone every project with full history"
	@echo "  make clone-one PROJECT=pi            Clone one project by name"
	@echo "  make status                          Show every configured project's local state"

install:
	@command -v "$(NPM)" >/dev/null 2>&1 || { echo "[error] npm is required" >&2; exit 127; }
	$(NPM) ci

dev:
	@command -v "$(NPM)" >/dev/null 2>&1 || { echo "[error] npm is required" >&2; exit 127; }
	@test -d node_modules/vitepress || { echo "[error] dependencies are missing; run 'make install' first" >&2; exit 2; }
	$(NPM) run dev -- --host "$(HOST)" --port "$(PORT)"

serve: dev

build:
	@command -v "$(NPM)" >/dev/null 2>&1 || { echo "[error] npm is required" >&2; exit 127; }
	@test -d node_modules/vitepress || { echo "[error] dependencies are missing; run 'make install' first" >&2; exit 2; }
	$(NPM) run build

preview:
	@command -v "$(NPM)" >/dev/null 2>&1 || { echo "[error] npm is required" >&2; exit 127; }
	@test -d node_modules/vitepress || { echo "[error] dependencies are missing; run 'make install' first" >&2; exit 2; }
	@test -f html/index.html || { echo "[error] html/ is missing; run 'make build' first" >&2; exit 2; }
	$(NPM) run preview -- --host "$(HOST)" --port "$(PREVIEW_PORT)"

site-check: build
	@test -f html/index.html
	@test -f html/deer-flow/index.html
	@test -f html/deepseek-harness/index.html
	@echo "[ok] VitePress site and project pages were generated"

clone:
	@set -eu; \
	$(JQ) -r '.projects[] | [.name, .repo, .path] | @tsv' "$(PROJECTS_FILE)" | \
	while IFS="$$(printf '\t')" read -r name repo path; do \
		if [ -d "$$path/.git" ]; then \
			echo "[skip]  $$name ($$path)"; \
		elif [ -e "$$path" ] && [ -n "$$(find "$$path" -mindepth 1 -maxdepth 1 ! -name .gitkeep -print -quit)" ]; then \
			echo "[error] $$name: $$path exists and is not empty" >&2; \
			exit 1; \
		else \
			echo "[clone] $$name -> $$path"; \
			mkdir -p "$$(dirname "$$path")"; \
			rm -f "$$path/.gitkeep"; \
			if [ "$(DEPTH)" = "0" ]; then \
				git clone -- "$$repo" "$$path"; \
			else \
				git clone --depth "$(DEPTH)" -- "$$repo" "$$path"; \
			fi; \
		fi; \
	done

clone-one:
	@if [ -z "$(PROJECT)" ]; then echo "PROJECT is required, for example: make clone-one PROJECT=pi" >&2; exit 2; fi
	@set -eu; \
	project="$$( $(JQ) -er --arg name "$(PROJECT)" '.projects[] | select(.name == $$name) | [.repo, .path] | @tsv' "$(PROJECTS_FILE)" )" || { echo "Unknown project: $(PROJECT)" >&2; exit 2; }; \
	IFS="$$(printf '\t')"; set -- $$project; repo="$$1"; path="$$2"; \
	if [ -d "$$path/.git" ]; then \
		echo "[skip] $(PROJECT) ($$path)"; \
	elif [ -e "$$path" ] && [ -n "$$(find "$$path" -mindepth 1 -maxdepth 1 ! -name .gitkeep -print -quit)" ]; then \
		echo "[error] $(PROJECT): $$path exists and is not empty" >&2; exit 1; \
	else \
		mkdir -p "$$(dirname "$$path")"; rm -f "$$path/.gitkeep"; \
		if [ "$(DEPTH)" = "0" ]; then \
			git clone -- "$$repo" "$$path"; \
		else \
			git clone --depth "$(DEPTH)" -- "$$repo" "$$path"; \
		fi; \
	fi

status:
	@$(JQ) -r '.projects[] | [.name, .path] | @tsv' "$(PROJECTS_FILE)" | \
	while IFS="$$(printf '\t')" read -r name path; do \
		if [ -d "$$path/.git" ]; then state=cloned; else state=missing; fi; \
		printf '%s\t%s\t%s\n' "$$state" "$$name" "$$path"; \
	done
