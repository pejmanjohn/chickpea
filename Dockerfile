# Chickpea coding-sandbox image. Extends Cloudflare's Sandbox SDK base — the
# tag MUST equal the @cloudflare/sandbox npm version (0.12.4); the SDK checks
# compatibility at startup. Ubuntu 22.04, Node 22.23.1, git/curl/jq preinstalled.
# This vendor-owned runtime runs sandbox tools, not the Chickpea host/build.
# It is independent of the Node 24 policy in .nvmrc; preserve SDK/image parity.
#
# Cloudflare hard rules (verified 2026-07-23): never set USER, never override
# ENTRYPOINT (the base ENTRYPOINT runs the sandbox control-plane server). Extend
# only with RUN layers, ordered rarely-changing -> often-changing for cache hits.
FROM docker.io/cloudflare/sandbox:0.12.4

# Python + pytest — the default base is Node-only; needed to run Python repos'
# test suites (`pip install -r requirements.txt && pytest`). Per-project deps are
# NOT baked here — the agent installs them post-clone, matching every reference
# platform (Codex/Claude/Copilot bake the toolchain, not project dependencies).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir pytest==8.3.4

# Screenshot capability: Playwright + Chromium baked in (NOT installed on demand
# — screenshots are on the agent's hot path; a ~150 MB per-turn install would
# dominate latency). Installed into a fixed, require-able dir; NODE_PATH lets our
# screenshot helper `require("playwright")` from anywhere. Playwright 1.49.1 is
# validated against this base's Node 22.23.1 (spike screenshot passed). Chromium
# launches with --no-sandbox — the container is the isolation boundary (root by
# design, matching all reference platforms).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_PATH=/opt/chickpea/node_modules
RUN mkdir -p /opt/chickpea \
    && cd /opt/chickpea \
    && npm init -y >/dev/null 2>&1 \
    && npm install playwright@1.49.1 \
    && npx playwright install --with-deps chromium

EXPOSE 3000
