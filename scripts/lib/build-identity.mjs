import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function readBuildIdentity(root) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Application package version must be a stable semantic version.');
  }
  let sourceCommit = null;
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(root)) {
      sourceCommit = git('rev-parse', 'HEAD');
    }
  } catch { /* A source archive intentionally has no Git metadata. */ }
  if (!sourceCommit) {
    try { sourceCommit = JSON.parse(readFileSync(join(root, 'release-source.json'), 'utf8')).commit; }
    catch { /* Development copies without provenance report unknown. */ }
  }
  return { version, sourceCommit: /^[a-f0-9]{40}$/.test(sourceCommit ?? '') ? sourceCommit : null };
}

export function buildIdentityDefines(root) {
  return { __CHICKPEA_BUILD_IDENTITY__: JSON.stringify(readBuildIdentity(root)) };
}
