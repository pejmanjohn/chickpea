import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRunJournal, appendRunJournal, readRunJournal } from '../qa/live/safety/journal.ts';
import { acquireTargetLock, recoverTargetLock, readTargetLock, readRunJournalStatus } from '../qa/live/safety/lock.ts';

const header = { runId: 'recover-test', manifestDigest: 'sha256:manifest', targetFingerprint: 'sha256:target',
  repositoryRevision: 'abcdef0123456789', servingVersion: 'serving-one', suite: 'case' as const,
  variantIds: ['LC01-V1-create-welcome'], createdAt: '2026-09-03T00:00:00.000Z' };
const { suite: _suite, variantIds: _variants, createdAt: _created, ...expected } = header;
const currentOwner = () => ({ runId: header.runId, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
const moduleUrl = new URL('../qa/live/safety/lock.ts', import.meta.url).href;

function fixture(context: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-recovery-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const journalPath = join(root, 'runs', `${header.runId}.jsonl`);
  createRunJournal(journalPath, header);
  appendRunJournal(journalPath, { type: 'intent', intentId: 'intent-one', variantId: header.variantIds[0]!,
    actionRef: 'LC01-V1-create-welcome:1:1', actionId: 'agent.create', mutation: 'create', direction: 'forward' }, expected);
  const stopped = spawnSync(process.execPath, ['-e', '']);
  assert.equal(stopped.status, 0);
  // A network change may alter macOS hostname without changing the laptop.
  const owner = { ...currentOwner(), pid: stopped.pid, host: 'previous-network-hostname' };
  const path = join(root, 'target.lock');
  acquireTargetLock(path, owner);
  return { root, path, owner, input: { journalPath, expected } };
}

test('explicit recovery preserves the lock and unresolved journal while auditing the owner transition', (context) => {
  const f = fixture(context);
  const next = currentOwner();
  const original = readFileSync(f.input.journalPath, 'utf8');
  recoverTargetLock(f.path, next, f.input, {
    afterGuardPublished: () => assert.deepEqual(readTargetLock(f.path), f.owner),
    afterOwnerPublished: () => assert.deepEqual(readTargetLock(f.path), next),
  });
  assert.ok(readFileSync(f.input.journalPath, 'utf8').startsWith(original));
  const events = readRunJournal(f.input.journalPath, expected).events;
  assert.deepEqual(events.filter(({ event }) => event.type === 'target_lock_recovery')
    .map(({ event }) => event.type === 'target_lock_recovery' && event.stage), ['prepared', 'published']);
  assert.equal(readRunJournalStatus(f.input.journalPath, header.runId).safeToClear, false);
  assert.throws(() => acquireTargetLock(f.path, next), /LOCK_ACTIVE/);
});

test('live, permission-denied, and unknown PID probes never authorize recovery', (context) => {
  for (const code of [undefined, 'EPERM', 'EIO']) {
    const f = fixture(context);
    assert.throws(() => recoverTargetLock(f.path, currentOwner(), f.input, { probePid: () => {
      if (code) throw Object.assign(new Error(code), { code });
    } }), /LOCK_ACTIVE/);
    assert.deepEqual(readTargetLock(f.path), f.owner);
  }
});

test('recovery refuses identity drift, another run, incomplete/corrupt history, and owner changes', (context) => {
  for (const key of ['targetFingerprint', 'repositoryRevision', 'servingVersion', 'manifestDigest'] as const) {
    const f = fixture(context);
    assert.throws(() => recoverTargetLock(f.path, currentOwner(), { ...f.input,
      expected: { ...expected, [key]: key.endsWith('Digest') || key === 'targetFingerprint' ? 'sha256:other' : 'other' } }));
    assert.deepEqual(readTargetLock(f.path), f.owner);
  }
  for (const change of [{ runId: 'other-run' }]) {
    const f = fixture(context);
    writeFileSync(f.path, JSON.stringify({ ...f.owner, ...change }));
    assert.throws(() => recoverTargetLock(f.path, currentOwner(), f.input), /LOCK_DIFFERENT_RUN/);
  }
  for (const suffix of ['{"record":', '{bad-json}\n']) {
    const f = fixture(context);
    appendFileSync(f.input.journalPath, suffix);
    assert.throws(() => recoverTargetLock(f.path, currentOwner(), f.input));
    assert.deepEqual(readTargetLock(f.path), f.owner);
  }
  const f = fixture(context);
  const changed = { ...f.owner, startedAt: '2026-09-03T01:00:00.000Z' };
  assert.throws(() => recoverTargetLock(f.path, currentOwner(), f.input, {
    afterGuardPublished: () => writeFileSync(f.path, JSON.stringify(changed)),
  }), /LOCK_CHANGED/);
  assert.deepEqual(readTargetLock(f.path), changed);
});

test('two real processes racing recovery have exactly one winner and no uncovered target', async (context) => {
  const f = fixture(context);
  const script = `import { recoverTargetLock } from ${JSON.stringify(moduleUrl)};
    import { hostname } from 'node:os';
    process.on('message', () => {
      try {
        recoverTargetLock(${JSON.stringify(f.path)}, { runId: ${JSON.stringify(header.runId)},
          pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }, ${JSON.stringify(f.input)});
        process.send({ result: 'recovered', pid: process.pid });
      } catch (error) { process.send({ result: error.code }); }
    }); process.send({ ready: true });`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  context.after(() => children.forEach((child) => { if (child.exitCode === null) child.kill(); }));
  await Promise.all(children.map((child) => new Promise<void>((resolve) => child.once('message', () => resolve()))));
  let missing = 0;
  const watch = setInterval(() => { if (!existsSync(f.path)) missing += 1; }, 1);
  const results = await Promise.all(children.map((child) => new Promise<{ result: string; pid?: number }>((resolve) => {
    child.once('message', resolve); child.send('go');
  })));
  clearInterval(watch);
  assert.equal(missing, 0);
  assert.deepEqual(results.map(({ result }) => result).sort(), ['LOCK_ACTIVE', 'recovered']);
  assert.equal(readTargetLock(f.path)?.pid, results.find(({ result }) => result === 'recovered')?.pid);
});

test('a later explicit recovery handles death before or after ownership publication without deleting a guard', (context) => {
  for (const hook of ['afterGuardPublished', 'afterOwnerPublished']) {
    const f = fixture(context);
    const script = `import { recoverTargetLock } from ${JSON.stringify(moduleUrl)};
      import { hostname } from 'node:os';
      recoverTargetLock(${JSON.stringify(f.path)}, { runId: ${JSON.stringify(header.runId)}, pid: process.pid,
        host: hostname(), startedAt: new Date().toISOString() }, ${JSON.stringify(f.input)},
        { ${hook}: () => process.exit(91) });`;
    const crashed = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(crashed.status, 91, crashed.stderr);
    assert.equal(existsSync(f.path), true);
    recoverTargetLock(f.path, currentOwner(), f.input);
    assert.equal(readTargetLock(f.path)?.pid, process.pid);
    assert.equal(readRunJournalStatus(f.input.journalPath, header.runId).safeToClear, false);
  }
});

test('safe clear and recovery race through the same exclusive transition', async (context) => {
  const f = fixture(context);
  appendRunJournal(f.input.journalPath, { type: 'receipt', intentId: 'intent-one',
    variantId: header.variantIds[0]!, actionRef: 'LC01-V1-create-welcome:1:1', outcome: 'not_applied' }, expected);
  const children = ['recover', 'clear'].map((operation) => {
    const script = `import { recoverTargetLock, clearTargetLock, readRunJournalStatus } from ${JSON.stringify(moduleUrl)};
      import { hostname } from 'node:os';
      process.on('message', () => {
        try {
          const owner = { runId: ${JSON.stringify(header.runId)}, pid: process.pid,
            host: hostname(), startedAt: new Date().toISOString() };
          if (${JSON.stringify(operation)} === 'recover') recoverTargetLock(${JSON.stringify(f.path)}, owner, ${JSON.stringify(f.input)});
          else clearTargetLock(${JSON.stringify(f.path)}, { runId: owner.runId, host: owner.host,
            journal: readRunJournalStatus(${JSON.stringify(f.input.journalPath)}, owner.runId) });
          process.send({ result: ${JSON.stringify(operation)}, pid: process.pid });
        } catch (error) { process.send({ result: error.code }); }
      }); process.send({ ready: true });`;
    return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  });
  context.after(() => children.forEach((child) => { if (child.exitCode === null) child.kill(); }));
  await Promise.all(children.map((child) => new Promise<void>((resolve) => child.once('message', () => resolve()))));
  const results = await Promise.all(children.map((child) => new Promise<{ result: string; pid?: number }>((resolve) => {
    child.once('message', resolve); child.send('go');
  })));
  const winners = results.filter(({ result }) => ['recover', 'clear'].includes(result));
  assert.equal(winners.length, 1);
  assert.ok(results.some(({ result }) => ['LOCK_ACTIVE', 'LOCK_MISSING'].includes(result)));
  if (winners[0]!.result === 'recover') assert.equal(readTargetLock(f.path)?.pid, winners[0]!.pid);
  else assert.equal(readTargetLock(f.path), undefined);
});
