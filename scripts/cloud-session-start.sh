#!/bin/bash
# Claude Code cloud session bootstrap (SessionStart hook; see .claude/settings.json).
#
# The cloud image ships Node 20/21/22, but this repository pins Node 24.20.0
# (.nvmrc) and refuses to install or test on anything else. Each cloud session
# starts from a fresh VM, so this hook installs the pinned Node from nodejs.org
# (on the default Trusted allowlist), puts it on the session PATH, and installs
# the locked dependencies when node_modules does not match package-lock.json.
# It never reads or prints credentials, and local sessions exit immediately.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$root"

version="$(tr -d '[:space:]' < .nvmrc)"
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "cloud-session-start: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
prefix="/opt/node-v${version}"
node_bin="${prefix}/bin/node"

if [ ! -x "$node_bin" ] || [ "$("$node_bin" --version)" != "v${version}" ]; then
  archive="node-v${version}-linux-${arch}.tar.xz"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  echo "cloud-session-start: installing Node v${version} (${arch})"
  curl -fsSL --retry 3 -o "${work}/${archive}" "https://nodejs.org/dist/v${version}/${archive}"
  curl -fsSL --retry 3 -o "${work}/SHASUMS256.txt" "https://nodejs.org/dist/v${version}/SHASUMS256.txt"
  (cd "$work" && grep " ${archive}\$" SHASUMS256.txt | sha256sum -c --quiet -)
  rm -rf "${prefix}.partial"
  mkdir -p "${prefix}.partial"
  tar -xJf "${work}/${archive}" --strip-components=1 -C "${prefix}.partial"
  rm -rf "$prefix"
  mv "${prefix}.partial" "$prefix"
fi

export PATH="${prefix}/bin:${PATH}"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"${prefix}/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# Reuse the repository's own drift check so a cached node_modules is kept.
if ! node --input-type=module -e '
  import { lockfileDrift } from "./scripts/lib/installed-dependencies.mjs";
  process.exit(lockfileDrift(process.cwd()).length === 0 ? 0 : 1);
'; then
  echo "cloud-session-start: installing locked dependencies"
  npm ci --strict-allow-scripts --no-audit --no-fund --loglevel=error
fi

echo "cloud-session-start: node $(node --version), npm $(npm --version), dependencies in sync"
