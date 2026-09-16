import { spawn } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideGit } from './private-evidence.mjs';
import { assertPrivatePath, readPrivateJson, writePrivateJson } from './upgrade-receipt.mjs';
import { assertNodeVersion } from './node-version.mjs';

export class InstallationNodeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const STATE_FILES = {
  TAG_DB_PATH: 'transcripts.sqlite',
  SLACK_STATE_DB_PATH: 'state.sqlite',
  CHICKPEA_AUTH_DB_PATH: 'auth.sqlite',
  CHICKPEA_CREDENTIAL_KEYRING_PATH: 'credential-keyring.json',
};

export function nodeInstallationEnvironment(installation) {
  const directory = installation.statePath;
  assertStateParent(installation);
  outsideGit(directory);
  assertPrivatePath(directory, { directory: true });
  if (realpathSync(directory) !== directory
    || realpathSync(installation.installerPath) !== installation.installerPath) {
    throw new InstallationNodeError('INSTALLATION_STATE_PATH_UNSAFE');
  }
  const env = {};
  for (const [key, name] of Object.entries(STATE_FILES)) {
    const file = path.join(directory, name);
    // Include SQLite sidecars. A redirected WAL can damage unrelated state.
    for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      if (pathPresent(candidate)) assertPrivatePath(candidate);
    }
    env[key] = file;
  }
  return env;
}

export function nodeInstallationProcessPath(installation) {
  return `${installation.statePath}.process.json`;
}

export function assertNodeInstallationClean(installation) {
  assertStateParent(installation);
  if (pathPresent(nodeInstallationProcessPath(installation))) throw new InstallationNodeError('INSTALLATION_PROCESS_RECONCILIATION_REQUIRED');
  if (pathPresent(installation.statePath)) throw new InstallationNodeError('INSTALLATION_LOCAL_STATE_REMAINS');
}

// Never remove a receipt just because the launcher died: its child process
// group may still own SQLite files or receive Slack events.
export function reconcileNodeInstallationProcess(installation) {
  assertStateParent(installation);
  const file = nodeInstallationProcessPath(installation);
  const record = readPrivateJson(file);
  if (record.runId !== installation.runId || !Number.isSafeInteger(record.launcherPid)
    || record.launcherPid <= 0 || !Number.isSafeInteger(record.childPgid) || record.childPgid <= 0) {
    throw new InstallationNodeError('INSTALLATION_PROCESS_START_UNRESOLVED');
  }
  if (processPresent(record.launcherPid) || processPresent(-record.childPgid)) {
    throw new InstallationNodeError('INSTALLATION_PROCESS_STILL_RUNNING');
  }
  unlinkSync(file);
  return { reconciled: true, runId: installation.runId };
}

/** Run the release's unchanged production Node entry, with only run-owned
 * configuration and state. No Cloudflare build or deployment is involved. */
export async function runNodeInstallation(installation, runtimeEnvFile, withClaim) {
  assertNodeVersion();
  if (process.platform === 'win32') throw new InstallationNodeError('INSTALLATION_PROCESS_GROUP_UNSUPPORTED');
  outsideGit(runtimeEnvFile);
  const configured = readPrivateJson(runtimeEnvFile);
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)
    || Object.entries(configured).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string'
      || /^(?:NODE_OPTIONS|NODE_PATH|PATH|HOME|ENV|BASH_ENV|LD_.*|DYLD_.*)$/.test(key))) {
    throw new InstallationNodeError('INVALID_INSTALLATION_ENVIRONMENT');
  }
  const stateEnv = nodeInstallationEnvironment(installation);
  if (Object.entries(stateEnv).some(([key, value]) => configured[key] !== undefined && configured[key] !== value)) {
    throw new InstallationNodeError('INSTALLATION_STATE_PATH_MISMATCH');
  }
  const entry = path.join(installation.installerPath, 'dist', 'server.mjs');
  if (realpathSync(entry) !== entry) throw new InstallationNodeError('INSTALLATION_ENTRY_PATH_UNSAFE');
  const file = nodeInstallationProcessPath(installation);
  const record = { runId: installation.runId, launcherPid: process.pid, childPgid: null };
  let child;
  let ownsReceipt = false;
  const forward = (signal) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  try {
    withClaim((current) => {
      if (['runId', 'runtime', 'statePath', 'installerPath'].some((key) => current[key] !== installation[key])) {
        throw new InstallationNodeError('INSTALLATION_RESERVATION_CHANGED');
      }
      nodeInstallationEnvironment(current);
      let fd;
      try {
        fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        ownsReceipt = true;
        writeFileSync(fd, JSON.stringify(record));
        fsyncSync(fd);
      } catch (error) {
        if (error.code === 'EEXIST') throw new InstallationNodeError('INSTALLATION_PROCESS_RECONCILIATION_REQUIRED');
        throw error;
      } finally { if (fd !== undefined) closeSync(fd); }
      const previousUmask = process.umask(0o077);
      try {
        child = spawn(process.execPath, [entry], {
          cwd: installation.installerPath, detached: true, stdio: 'inherit',
          env: { PATH: process.env.PATH, ...configured, ...stateEnv, NODE_ENV: 'production' },
        });
      } finally { process.umask(previousUmask); }
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      if (child.pid) {
        record.childPgid = child.pid;
        writePrivateJson(file, record);
      }
    });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (child.pid && processPresent(-child.pid)) throw new InstallationNodeError('INSTALLATION_PROCESS_STILL_RUNNING');
    unlinkSync(file);
    return result;
  } catch (error) {
    // Unknown descendants retain the receipt and block restoration. An error
    // before spawn is safe to clear; it never started a customer process.
    if (ownsReceipt && (!child || !child.pid)) unlinkSync(file);
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

function pathPresent(file) {
  try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function assertStateParent(installation) {
  const parent = path.dirname(installation.statePath);
  outsideGit(parent);
  assertPrivatePath(parent, { directory: true });
  if (realpathSync(parent) !== parent) throw new InstallationNodeError('INSTALLATION_STATE_PATH_UNSAFE');
}

function processPresent(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
