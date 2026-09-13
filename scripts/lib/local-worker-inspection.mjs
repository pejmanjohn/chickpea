import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import {
  localLaneLockPath,
  readLocalLaneManifest,
  resolveLocalLanePaths,
  worktreeDevVarsLinkStatus,
} from './local-worker-lane.mjs';

export function assertRunnerRootReadOnly(command, runnerRoot) {
  if (runnerRoot !== undefined && command !== 'status') {
    throw new Error('--runner-root is read-only and may be used only with status.');
  }
}

export function inspectLocalWorkerRunner(input, options = {}) {
  const runner = inspectGitWorktree(input.runnerRoot, options);
  const candidate = inspectGitWorktree(input.candidateRoot, options);
  if (runner.gitCommonDirectory !== candidate.gitCommonDirectory) {
    throw new Error('Local Worker runner and calling candidate must be worktrees of the same Git repository.');
  }
  const manifest = readLocalLaneManifest(runner.root, input.lane);
  const paths = resolveLocalLanePaths(runner.root, manifest.lane);
  const lock = readEndpointLock(localLaneLockPath(manifest.publicUrl), options);
  const capturedAt = new Date(options.now ? options.now() : Date.now()).toISOString();
  return Object.freeze({
    schemaVersion: 'chickpea-local-worker-runner-status/v1',
    capturedAt,
    readiness: Object.freeze({
      stateSchemaGeneration: 'unrecorded',
      crossWorktreeStart: 'blocked',
      reason: 'runner-state-schema-contract-unavailable',
    }),
    runner: Object.freeze({
      observedAt: capturedAt,
      root: runner.root,
      branch: runner.branch,
      headRevision: runner.headRevision,
      workingContentFingerprint: runner.workingContentFingerprint,
      dirty: runner.dirty,
      lane: manifest.lane,
      runtime: manifest.runtime,
      transport: manifest.transport,
      publicUrl: manifest.publicUrl,
      tunnelName: manifest.tunnelName,
      port: manifest.port,
      statePath: manifest.statePath,
      d1DatabaseId: manifest.d1DatabaseId,
      slack: manifest.slack ?? 'not-bound',
      model: Object.freeze({
        configuredDefault: manifest.model,
        effective: 'unverified',
      }),
      devVarsLink: worktreeDevVarsLinkStatus(paths),
    }),
    candidate: Object.freeze({
      observedAt: capturedAt,
      root: candidate.root,
      branch: candidate.branch,
      headRevision: candidate.headRevision,
      workingContentFingerprint: candidate.workingContentFingerprint,
      dirty: candidate.dirty,
    }),
    process: lock ?? 'stopped',
  });
}

export function inspectGitWorktree(rootValue, options = {}) {
  if (typeof rootValue !== 'string' || !path.isAbsolute(rootValue) || path.resolve(rootValue) !== rootValue) {
    throw new Error('Local Worker runner root must be an absolute canonical path.');
  }
  let root;
  try { root = realpathSync(rootValue); } catch { throw new Error('Local Worker worktree is unavailable.'); }
  const stat = lstatSync(rootValue);
  if (root !== rootValue || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Local Worker worktree path must name its canonical directory.');
  }
  const expectedUid = options.expectedUid
    ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    throw new Error('Local Worker worktree must belong to the current user.');
  }
  if ((stat.mode & 0o022) !== 0) throw new Error('Local Worker worktree permissions are unsafe.');
  const runGit = options.runGit ?? gitOutput;
  const top = runGit(root, ['rev-parse', '--show-toplevel']);
  if (realpathSync(top) !== root) throw new Error('Local Worker path is not a complete Git worktree root.');
  const branch = runGit(root, ['branch', '--show-current']);
  const headRevision = runGit(root, ['rev-parse', 'HEAD']);
  if (!branch || !/^[0-9a-f]{7,64}$/u.test(headRevision)) {
    throw new Error('Local Worker status requires a named Git worktree revision.');
  }
  const commonRaw = runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitCommonDirectory = realpathSync(path.resolve(root, commonRaw));
  const status = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = runGit(root, ['diff', '--binary', 'HEAD', '--']);
  const untracked = status.split('\0').filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3)).sort();
  const fingerprint = createHash('sha256').update(`${headRevision}\0${status}\0${diff}\0`);
  for (const relativePath of untracked) {
    const filePath = path.join(root, relativePath);
    const fileStat = lstatSync(filePath);
    fingerprint.update(`${relativePath}\0${fileStat.mode}\0`);
    fingerprint.update(fileStat.isSymbolicLink() ? readlinkSync(filePath) : readFileSync(filePath));
    fingerprint.update('\0');
  }
  return Object.freeze({
    root,
    branch,
    headRevision,
    gitCommonDirectory,
    dirty: status.length > 0,
    workingContentFingerprint: `sha256:${fingerprint.digest('hex')}`,
  });
}

function readEndpointLock(lockPath, options) {
  if (!existsSync(lockPath)) return null;
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch {
    throw new Error(`Local endpoint lock is unreadable: ${lockPath}`);
  }
  const pidIsLive = options.pidIsLive ?? defaultPidIsLive;
  const live = pidIsLive(lock.pid);
  return Object.freeze({
    pid: lock.pid,
    lane: lock.lane,
    publicUrl: lock.publicUrl,
    owningWorktree: lock.owningWorktree,
    sourceSha: lock.sourceSha,
    worktreeFingerprint: lock.worktreeFingerprint,
    acquiredAt: lock.acquiredAt,
    live,
    status: live ? 'running' : 'stale-lock',
  });
}

function defaultPidIsLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed.`);
  return result.stdout.trim();
}
