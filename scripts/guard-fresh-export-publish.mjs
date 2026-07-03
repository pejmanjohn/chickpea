#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

if (!existsSync(join(REPO_ROOT, '.git'))) {
  console.log('No git metadata found; assuming a prepared export tree.');
  process.exit(0);
}

try {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    console.log('Not inside a git work tree; assuming a prepared export tree.');
    process.exit(0);
  }

  const sampledCommits = git(['rev-list', '--max-count=2', 'HEAD'])
    .split('\n')
    .filter(Boolean);
  if (sampledCommits.length < 1) {
    throw new Error('could not determine commit count');
  }

  if (sampledCommits.length > 1) {
    const commitCount = Number(git(['rev-list', '--count', 'HEAD']));
    console.error(
      [
        'Refusing to publish from this development repository.',
        'Publish only from a fresh squashed export with a single initial commit.',
        `Detected ${commitCount} commits in this checkout.`,
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log('Fresh single-commit export publish guard passed.');
} catch (error) {
  console.error(
    `Unable to verify fresh-export publish guard: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
