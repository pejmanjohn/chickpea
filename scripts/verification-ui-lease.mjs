#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { HostUiMutex, UiMutexError } from '../qa/live/safety/ui-mutex.ts';
import { outsideGit } from './lib/private-evidence.mjs';

export const DEFAULT_UI_ROOT = join(homedir(), '.chickpea', 'live-ui');

function sleep(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function integer(value, name, maximum = 120_000) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${name} must be 0..${maximum}.`);
  return parsed;
}
function atomicReceipt(file, receipt) {
  const path = outsideGit(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
  return path;
}
function readReceipt(file) {
  if (!isAbsolute(file)) throw new Error('Lease receipt path must be absolute.');
  const initial = lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.uid !== process.getuid?.()
    || (initial.mode & 0o077) || initial.size > 64 * 1024) {
    throw new Error('Lease receipt must be an owner-only regular file.');
  }
  const path = outsideGit(file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error('Lease receipt must be an owner-only regular file.');
  }
  const bytes = readFileSync(path);
  return { path, receipt: JSON.parse(bytes.toString('utf8')), bytes,
    identity: { dev: stat.dev, ino: stat.ino } };
}
function unlinkUnchangedReceipt(path, bytes, identity) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino
    || !readFileSync(path).equals(bytes)) throw new Error('Lease receipt changed before cleanup.');
  unlinkSync(path);
}
async function waitFor(acquire, timeoutMs, pollMs, isCancelled = () => false) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let attempted = false;
  let lastContention = 'UI_BUSY';
  while (true) {
    if (isCancelled()) return { waitedMs: Math.round(performance.now() - started), cancelled: true };
    if (attempted && performance.now() >= deadline) return {
      waitedMs: Math.round(performance.now() - started), contention: lastContention,
    };
    attempted = true;
    try { return { value: acquire(), waitedMs: Math.round(performance.now() - started) }; }
    catch (error) {
      if (!(error instanceof UiMutexError) || !['UI_BUSY', 'BROWSER_RESERVED'].includes(error.code)) throw error;
      lastContention = error.code;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { waitedMs: Math.round(performance.now() - started), contention: error.code };
      await sleep(Math.min(pollMs, Math.max(1, remaining)));
    }
  }
}

export async function runUiLeaseCli(argv, io = {}) {
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      run: { type: 'string' }, browser: { type: 'string' }, case: { type: 'string' }, step: { type: 'string' },
      action: { type: 'string' }, 'wait-ms': { type: 'string' }, 'poll-ms': { type: 'string' },
      receipt: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      stdout(`Usage:
  verification-ui-lease.mjs acquire --receipt /private/lease.json --run ID --browser ALIAS --case ID --step ID --action TEXT [--wait-ms MS] [--poll-ms MS]
  # Perform exactly one native browser action or readback; this command does not invoke it.
  verification-ui-lease.mjs release --receipt /private/lease.json
  verification-ui-lease.mjs pause --receipt /private/lease.json
  verification-ui-lease.mjs resume --receipt /private/lease.json [--wait-ms MS] [--poll-ms MS]
  # Resume recovers UI ownership only. Inspect and reconcile the visible state before any action.
  verification-ui-lease.mjs finish --receipt /private/lease.json
`);
      return 0;
    }
    if (positionals.length !== 1 || !['acquire', 'release', 'pause', 'resume', 'finish'].includes(positionals[0])) throw new Error('Choose acquire, release, pause, resume, or finish.');
    const command = positionals[0];
    const allowed = command === 'acquire' ? ['run', 'browser', 'case', 'step', 'action', 'wait-ms', 'poll-ms', 'receipt']
      : command === 'resume' ? ['wait-ms', 'poll-ms', 'receipt'] : ['receipt'];
    if (Object.keys(values).some((key) => key !== 'help' && !allowed.includes(key))) throw new Error(`Unsupported option for ${command}.`);
    if (!values.receipt) throw new Error('Pass --receipt with an absolute private path.');
    const root = resolve(io.uiRoot ?? DEFAULT_UI_ROOT);
    if (command === 'acquire') {
      const mutex = new HostUiMutex(root);
      for (const field of ['run', 'browser', 'case', 'step', 'action']) if (!values[field]) throw new Error(`Acquire needs --${field}.`);
      const timeoutMs = integer(values['wait-ms'] ?? '120000', '--wait-ms');
      const pollMs = integer(values['poll-ms'] ?? '100', '--poll-ms', 5_000);
      if (pollMs < 1) throw new Error('--poll-ms must be at least 1.');
      const result = await waitFor(() => mutex.acquirePortable({ runId: values.run, browserAlias: values.browser,
        caseId: values.case, stepId: values.step, actionDigest: digest(values.action) }), timeoutMs, pollMs, io.isCancelled);
      if (result.cancelled) {
        stdout(`${JSON.stringify({ status: 'cancelled', waitedMs: result.waitedMs, actionPerformed: false })}\n`);
        return 130;
      }
      if (!result.value) {
        stdout(`${JSON.stringify({ status: 'timeout', contention: result.contention, waitedMs: result.waitedMs,
          actionPerformed: false })}\n`);
        return 3;
      }
      let receiptPath;
      try { receiptPath = atomicReceipt(values.receipt, { ...result.value, waitMs: result.waitedMs }); }
      catch (error) { mutex.releasePortable(result.value); throw error; }
      stdout(`${JSON.stringify({ status: 'acquired', receipt: receiptPath, waitedMs: result.waitedMs,
        actionPerformed: false })}\n`);
      return 0;
    }
    const { path, receipt, bytes, identity } = readReceipt(values.receipt);
    if (receipt.root !== root) throw new Error('Lease receipt root does not match the canonical UI root.');
    const receiptMutex = new HostUiMutex(receipt.root);
    if (command === 'resume') {
      const timeoutMs = integer(values['wait-ms'] ?? '120000', '--wait-ms');
      const pollMs = integer(values['poll-ms'] ?? '100', '--poll-ms', 5_000);
      if (pollMs < 1) throw new Error('--poll-ms must be at least 1.');
      const result = await waitFor(() => receiptMutex.resumePortable(receipt), timeoutMs, pollMs, io.isCancelled);
      if (result.cancelled) {
        stdout(`${JSON.stringify({ status: 'cancelled', waitedMs: result.waitedMs, actionPerformed: false })}\n`);
        return 130;
      }
      if (result.contention) {
        stdout(`${JSON.stringify({ status: 'timeout', contention: result.contention, waitedMs: result.waitedMs,
          actionPerformed: false })}\n`);
        return 3;
      }
      stdout(`${JSON.stringify({ status: 'resumed', ownership: result.value, receipt: path,
        waitedMs: result.waitedMs, actionPerformed: false })}\n`);
      return 0;
    }
    if (command === 'pause') receiptMutex.pausePortable(receipt);
    else if (command === 'finish') receiptMutex.finishPortable(receipt);
    else receiptMutex.releasePortable(receipt);
    if (command !== 'pause') {
      io.beforeReceiptCleanup?.(path);
      unlinkUnchangedReceipt(path, bytes, identity);
    }
    stdout(`${JSON.stringify({ status: command === 'pause' ? 'paused' : command === 'finish' ? 'finished' : 'released',
      receipt: path, elapsedSinceAcquisitionMs: Date.now() - Date.parse(receipt.owner.acquiredAt), actionPerformed: false })}\n`);
    return 0;
  } catch (error) {
    stderr(`UI lease command failed: ${error instanceof Error ? error.message : 'Invalid input.'}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  process.exitCode = await runUiLeaseCli(process.argv.slice(2), { isCancelled: () => cancelled });
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
