import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

// @ts-expect-error The cross-platform executable .mjs intentionally has no declaration file.
import { runUiLeaseCli } from '../scripts/verification-ui-lease.mjs';

function setup(context: test.TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-ui-cli-')));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { root: join(base, 'root'), receipt: join(base, 'private', 'lease.json') };
}
async function run(args: string[], uiRoot: string) {
  let stdout = '', stderr = '';
  const code = await runUiLeaseCli(args, { uiRoot,
    stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; } });
  return { code, stdout, stderr };
}
async function acquire(paths: ReturnType<typeof setup>, runId = 'run-one') {
  return run(['acquire', '--receipt', paths.receipt, '--run', runId,
    '--browser', 'chrome', '--case', 'routing', '--step', 'readback-1', '--action', 'Read exact Slack reply', '--wait-ms', '0'], paths.root);
}

test('CLI keeps token private and releases a cross-process receipt-owned lease', async (context) => {
  const paths = setup(context);
  const acquired = await acquire(paths);
  assert.equal(acquired.code, 0, acquired.stderr);
  assert.doesNotMatch(acquired.stdout, /token/u);
  const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
  assert.equal(typeof receipt.token, 'string');
  const released = await run(['release', '--receipt', paths.receipt], paths.root);
  assert.equal(released.code, 0, released.stderr);
  assert.equal(existsSync(paths.receipt), false);
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), false);
});

test('CLI bounded wait reports contention without invoking or replaying an action', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  const second = { ...paths, receipt: join(dirname(paths.receipt), 'second.json') };
  const blocked = await acquire(second, 'run-two');
  assert.equal(blocked.code, 3);
  assert.deepEqual(JSON.parse(blocked.stdout).actionPerformed, false);
  assert.equal(existsSync(second.receipt), false);
  assert.equal((await run(['release', '--receipt', paths.receipt], paths.root)).code, 0);
});

test('pause and resume retain only the browser reservation until finish', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  assert.equal((await run(['pause', '--receipt', paths.receipt], paths.root)).code, 0);
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), false);
  assert.equal((await run(['resume', '--receipt', paths.receipt, '--wait-ms', '0'], paths.root)).code, 0);
  assert.equal((await run(['finish', '--receipt', paths.receipt], paths.root)).code, 0);
  assert.equal(existsSync(paths.receipt), false);
});

test('repeated resume and mistaken release cannot strand a paused browser reservation', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  assert.equal((await run(['pause', '--receipt', paths.receipt], paths.root)).code, 0);
  assert.equal((await run(['resume', '--receipt', paths.receipt, '--wait-ms', '0'], paths.root)).code, 0);
  const repeated = await run(['resume', '--receipt', paths.receipt, '--wait-ms', '0'], paths.root);
  assert.equal(repeated.code, 3);
  assert.equal(JSON.parse(repeated.stdout).actionPerformed, false);
  const refused = await run(['release', '--receipt', paths.receipt], paths.root);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /BROWSER_RESERVED/u);
  assert.equal(existsSync(paths.receipt), true);
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), true);
  assert.equal(readdirSync(paths.root).filter((name) => name.startsWith('browser-')).length, 1);
  assert.equal((await run(['finish', '--receipt', paths.receipt], paths.root)).code, 0);
  assert.equal(readdirSync(paths.root).filter((name) => name.endsWith('.lock')).length, 0);
});

test('receipt publication failure rolls back the acquired host lock', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  assert.equal((await run(['release', '--receipt', paths.receipt], paths.root)).code, 0);
  // A directory cannot be replaced by the receipt hard link.
  const badReceipt = join(paths.root, 'bad-receipt');
  mkdirSync(badReceipt);
  const result = await run(['acquire', '--receipt', badReceipt, '--run', 'rollback-run',
    '--browser', 'chrome', '--case', 'routing', '--step', 'act-1', '--action', 'Act', '--wait-ms', '0'], paths.root);
  assert.equal(result.code, 2);
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), false);
});

test('receipt readers reject symlinks before canonical resolution', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  const linked = join(dirname(paths.receipt), 'linked.json');
  symlinkSync(paths.receipt, linked);
  const refused = await run(['release', '--receipt', linked], paths.root);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /owner-only regular file/u);
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), true);
  assert.equal((await run(['release', '--receipt', paths.receipt], paths.root)).code, 0);
});

test('cancellation does not remove a foreign held lease', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  const other = join(dirname(paths.receipt), 'other.json');
  let stdout = '';
  const code = await runUiLeaseCli(['acquire', '--receipt', other, '--run', 'run-two', '--browser', 'chrome',
    '--case', 'routing', '--step', 'readback-2', '--action', 'Read', '--wait-ms', '1000'], {
    uiRoot: paths.root, isCancelled: () => true, stdout: (value: string) => { stdout += value; }, stderr: () => {},
  });
  assert.equal(code, 130);
  assert.equal(JSON.parse(stdout).status, 'cancelled');
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), true);
  assert.equal(existsSync(other), false);
  assert.equal((await run(['release', '--receipt', paths.receipt], paths.root)).code, 0);
});

test('command-specific options reject an acquire-only flag on release', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  const refused = await run(['release', '--receipt', paths.receipt, '--wait-ms', '1'], paths.root);
  assert.equal(refused.code, 2);
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), true);
  assert.equal((await run(['release', '--receipt', paths.receipt], paths.root)).code, 0);
});

test('a real SIGTERM cancels bounded waiting without disturbing the holder', async (context) => {
  const paths = setup(context);
  const home = join(dirname(paths.root), 'home');
  const canonicalRoot = join(home, '.chickpea', 'live-ui');
  const holder = { root: canonicalRoot, receipt: paths.receipt };
  assert.equal((await acquire(holder)).code, 0);
  const otherReceipt = join(dirname(paths.receipt), 'signal-waiter.json');
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../scripts/verification-ui-lease.mjs', import.meta.url).pathname,
    'acquire', '--receipt', otherReceipt, '--run', 'signal-run', '--browser', 'chrome', '--case', 'routing',
    '--step', 'readback-2', '--action', 'Read', '--wait-ms', '5000', '--poll-ms', '10'], {
    env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
  // Allow the tsx loader and CLI signal handlers to initialize before interruption.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
  assert.equal(code, 130, stderr);
  assert.equal(JSON.parse(stdout).status, 'cancelled');
  assert.equal(existsSync(join(canonicalRoot, 'interaction.lock')), true);
  assert.equal(existsSync(otherReceipt), false);
  assert.equal((await run(['release', '--receipt', paths.receipt], canonicalRoot)).code, 0);
});

test('release does not unlink a receipt changed concurrently', async (context) => {
  const paths = setup(context);
  assert.equal((await acquire(paths)).code, 0);
  let stderr = '';
  const code = await runUiLeaseCli(['release', '--receipt', paths.receipt], {
    uiRoot: paths.root, stdout: () => {}, stderr: (value: string) => { stderr += value; },
    beforeReceiptCleanup: (path: string) => { writeFileSync(path, `${readFileSync(path, 'utf8')} `); },
  });
  assert.equal(code, 2);
  assert.match(stderr, /changed before cleanup/u);
  assert.equal(existsSync(paths.receipt), true);
  assert.equal(existsSync(join(paths.root, 'interaction.lock')), false);
});
