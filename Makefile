SHELL := /bin/sh
export PATH := $(HOME)/.local/bin:$(PATH)

PROJECTS_FILE ?= projects.json
DEPTH ?= 1
PROJECT ?=
JQ ?= jq

.PHONY: help clone clone-one status

help:
	@echo "Usage:"
	@echo "  make clone                 Clone every missing project (shallow by default)"
	@echo "  make clone DEPTH=0         Clone every missing project with full history"
	@echo "  make clone-one PROJECT=pi  Clone one project by name"
	@echo "  make status                Show the local state of every configured project"

clone:
	@set -eu; \
	depth_args=""; \
	if [ "$(DEPTH)" != "0" ]; then depth_args="--depth $(DEPTH)"; fi; \
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
			git clone $$depth_args -- "$$repo" "$$path"; \
		fi; \
	done

clone-one:
	@if [ -z "$(PROJECT)" ]; then echo "PROJECT is required, for example: make clone-one PROJECT=pi" >&2; exit 2; fi
	@set -eu; \
	depth_args=""; \
	if [ "$(DEPTH)" != "0" ]; then depth_args="--depth $(DEPTH)"; fi; \
	project="$$( $(JQ) -er --arg name "$(PROJECT)" '.projects[] | select(.name == $$name) | [.repo, .path] | @tsv' "$(PROJECTS_FILE)" )" || { echo "Unknown project: $(PROJECT)" >&2; exit 2; }; \
	IFS="$$(printf '\t')"; set -- $$project; repo="$$1"; path="$$2"; \
	if [ -d "$$path/.git" ]; then \
		echo "[skip] $(PROJECT) ($$path)"; \
	elif [ -e "$$path" ] && [ -n "$$(find "$$path" -mindepth 1 -maxdepth 1 ! -name .gitkeep -print -quit)" ]; then \
		echo "[error] $(PROJECT): $$path exists and is not empty" >&2; exit 1; \
	else \
		mkdir -p "$$(dirname "$$path")"; rm -f "$$path/.gitkeep"; \
		git clone $$depth_args -- "$$repo" "$$path"; \
	fi

status:
	@$(JQ) -r '.projects[] | [.name, .path] | @tsv' "$(PROJECTS_FILE)" | \
	while IFS="$$(printf '\t')" read -r name path; do \
		if [ -d "$$path/.git" ]; then state=cloned; else state=missing; fi; \
		printf '%s\t%s\t%s\n' "$$state" "$$name" "$$path"; \
	done
