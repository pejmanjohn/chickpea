import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('offline verifier can load overlapping TypeScript graphs repeatedly and concurrently', () => {
  // Start without the test runner's --import tsx: the standalone .mjs verifiers
  // must initialize their own loader, including on the minimum supported Node.
  const harnessUrl = new URL('../scripts/lib/offline-harness.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { loadTsModule } from ${JSON.stringify(harnessUrl)};
    for (const module of [
      'tests/parity/fake-slack.ts',
      'src/config/store.ts',
      'src/config/seed.ts',
      'src/identity/store.ts',
      'src/auth/personal-token.ts',
      'tests/helpers/slack-owner.ts',
      'src/slack/credential-keyring.ts',
      'src/slack/installation-credentials.ts',
      'src/config/types.ts',
      'src/slack/scopes.ts',
    ]) {
      assert.ok(Object.keys(await loadTsModule(module)).length > 0);
    }
    const [first, second] = await Promise.all([
      loadTsModule('src/config/store.ts'),
      loadTsModule('src/config/store.ts'),
    ]);
    assert.equal(first, second);
    console.log('offline loader complete');
  `], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DO_NOT_TRACK: '1',
      TAG_DB_PATH: ':memory:',
      SLACK_STATE_DB_PATH: ':memory:',
      CHICKPEA_AUTH_DB_PATH: ':memory:',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline loader complete/);
});

test('spawnReadyServer retries only a lost port, and stops every child it abandons', async () => {
  // @ts-expect-error The offline harness intentionally has no declaration file.
  const { spawnReadyServer } = await import('../scripts/lib/offline-harness.mjs');
  const ports = [41001, 41002, 41003];
  const stopped: string[] = [];
  const logs: string[] = [];
  const started: Array<{ port: number }> = [];
  const fakes = {
    allocatePort: async () => ports[started.length]!,
    start: (options: { port: number }) => {
      started.push(options);
      return { child: `child-${options.port}`, eventsUrl: `http://127.0.0.1:${options.port}/events`, getOutput: () => '' };
    },
    stop: async (child: string) => { stopped.push(child); },
    log: (line: string) => { logs.push(line); },
  };

  // A port lost between allocation and bind is retried on a fresh port.
  const collisions = { count: 0 };
  const server = await spawnReadyServer({ serverEntry: 'server.mjs' }, {
    ...fakes,
    ready: async () => {
      if (collisions.count++ === 0) {
        throw new Error('server exited early (exit 1):\nError: listen EADDRINUSE: address already in use :::41001');
      }
    },
  });
  assert.equal(server.port, 41002);
  assert.equal(server.child, 'child-41002');
  assert.deepEqual(stopped, ['child-41001']);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /port 41001 was taken/);

  // Any other startup failure propagates unchanged after stopping the child.
  started.length = 0; stopped.length = 0; logs.length = 0;
  await assert.rejects(
    spawnReadyServer({ serverEntry: 'server.mjs' }, {
      ...fakes,
      ready: async () => { throw new Error('server never became ready:\nboot loop'); },
    }),
    /never became ready/,
  );
  assert.deepEqual(stopped, ['child-41001']);
  assert.deepEqual(logs, []);

  // The attempt budget is bounded: the last collision is the error.
  started.length = 0; stopped.length = 0; logs.length = 0;
  await assert.rejects(
    spawnReadyServer({ serverEntry: 'server.mjs' }, {
      ...fakes,
      attempts: 2,
      ready: async () => { throw new Error('EADDRINUSE'); },
    }),
    /EADDRINUSE/,
  );
  assert.deepEqual(stopped, ['child-41001', 'child-41002']);
  assert.equal(logs.length, 1);
});

test('verification ports come from a fixed range, are locked per host, and skip live reservations', async () => {
  // @ts-expect-error The port allocator intentionally has no declaration file.
  const ports = await import('../scripts/lib/verification-ports.mjs');
  const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lockDir = mkdtempSync(join(tmpdir(), 'chickpea-ports-'));
  try {
    const range = { first: 20900, last: 20903 };
    // The test runner is a live process: its reservation must be respected.
    writeFileSync(join(lockDir, '20900.json'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    // A reservation whose owner is gone, or is far too old, is reclaimed.
    writeFileSync(join(lockDir, '20901.json'), JSON.stringify({ pid: 2 ** 22 - 1, startedAt: new Date().toISOString() }));
    writeFileSync(join(lockDir, '20902.json'), JSON.stringify({ pid: process.ppid, startedAt: '2020-01-01T00:00:00.000Z' }));
    const first = await ports.reserveVerificationPort({ range, lockDir });
    const second = await ports.reserveVerificationPort({ range, lockDir });
    const third = await ports.reserveVerificationPort({ range, lockDir });
    assert.deepEqual([first, second, third].sort(), [20901, 20902, 20903]);
    for (const port of [first, second, third]) {
      assert.equal(JSON.parse(readFileSync(join(lockDir, `${port}.json`), 'utf8')).pid, process.pid);
    }
    await assert.rejects(ports.reserveVerificationPort({ range, lockDir }), /No free verification port in 20900-20903/);
    ports.releaseVerificationPort(first, { lockDir });
    assert.equal(await ports.reserveVerificationPort({ range, lockDir }), first);
    for (const port of [first, second, third]) ports.releaseVerificationPort(port, { lockDir });
    assert.deepEqual(readdirSync(lockDir).sort(), ['20900.json']);
    // Defaults sit outside the macOS and Linux ephemeral ranges.
    assert.ok(ports.VERIFICATION_PORT_RANGE.first >= 1024 && ports.VERIFICATION_PORT_RANGE.last < 32768);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});
