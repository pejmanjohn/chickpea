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
