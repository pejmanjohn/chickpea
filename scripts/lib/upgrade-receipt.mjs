import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function assertPrivatePath(file, { directory = false } = {}) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) || (!directory && stat.nlink !== 1)) {
    throw new Error('Upgrade state must be a private, owner-controlled regular file or directory.');
  }
  return stat;
}

export function readPrivateJson(file) {
  assertPrivatePath(path.dirname(file), { directory: true });
  const stat = assertPrivatePath(file);
  if (stat.size > 1024 * 1024) throw new Error('Upgrade state exceeds its size limit.');
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Upgrade state is not readable JSON. Preserve it for investigation.'); }
}

export function writePrivateJson(file, value) {
  assertPrivatePath(path.dirname(file), { directory: true });
  if (existsSync(file)) assertPrivatePath(file);
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
    const directoryFd = openSync(path.dirname(file), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function writeDeploymentEvent(contextPath, stage, workerVersion) {
  if (!['deploying', 'uploaded', 'ready'].includes(stage) || (workerVersion !== undefined && !/^[A-Za-z0-9-]{1,128}$/.test(workerVersion))) {
    throw new Error('Invalid deployment event.');
  }
  const file = path.join(path.dirname(contextPath), 'deployment.json');
  const prior = existsSync(file) ? readPrivateJson(file) : undefined;
  const knownVersions = prior?.knownVersions ?? [];
  if (!Array.isArray(knownVersions) || knownVersions.length > 32) throw new Error('Invalid deployment history.');
  if (workerVersion) {
    const { source } = readPrivateJson(contextPath);
    if (!source || typeof source.version !== 'string' || typeof source.commit !== 'string') throw new Error('Missing deployment source identity.');
    const known = knownVersions.find((entry) => entry.workerVersion === workerVersion);
    if (known && (known.version !== source.version || known.commit !== source.commit)) throw new Error('Deployment identity changed.');
    if (!known) knownVersions.push({ workerVersion, version: source.version, commit: source.commit });
  }
  // Keep the most recent uploads across interruptions, including a new attempt
  // which fails before Wrangler returns an upload ID. Readiness stays specific
  // to the latest event; a historical upload alone never proves health.
  writePrivateJson(file, { schema: 1, stage, knownVersions: knownVersions.slice(-32), ...(workerVersion ? { workerVersion } : {}), at: new Date().toISOString() });
}
