import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// @ts-expect-error Deployment tooling JavaScript helper.
import { mergeDeploymentSecrets, OPERATOR_SECRETS_ENV, readOperatorSecretsFile } from '../scripts/lib/deploy-operator-secrets.mjs';

// mkdtemp creates an owner-only (0700) directory, which readPrivateJson requires.
function withSecretsFile(contents: string, mode = 0o600): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-operator-secrets-'));
  const path = join(directory, 'secrets.json');
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('reads an owner-only JSON object of named string secrets', () => {
  const file = withSecretsFile(JSON.stringify({ BROWSERBASE_API_KEY: 'bb_live_example', OPENAI_API_KEY: 'sk-example' }));
  try {
    assert.deepEqual(readOperatorSecretsFile(file.path), {
      BROWSERBASE_API_KEY: 'bb_live_example',
      OPENAI_API_KEY: 'sk-example',
    });
  } finally {
    file.cleanup();
  }
});

test('refuses group- or world-readable files, relative paths, and malformed content', () => {
  const loose = withSecretsFile(JSON.stringify({ BROWSERBASE_API_KEY: 'x' }), 0o644);
  try {
    assert.throws(() => readOperatorSecretsFile(loose.path), /private, owner-controlled/);
  } finally {
    loose.cleanup();
  }
  assert.throws(() => readOperatorSecretsFile('relative/secrets.json'), /absolute path/);
  const broken = withSecretsFile('{not json');
  try {
    assert.throws(() => readOperatorSecretsFile(broken.path), /not readable JSON/);
  } finally {
    broken.cleanup();
  }
  const openDirectory = withSecretsFile(JSON.stringify({ BROWSERBASE_API_KEY: 'x' }));
  try {
    chmodSync(dirname(openDirectory.path), 0o755);
    assert.throws(() => readOperatorSecretsFile(openDirectory.path), /private, owner-controlled/);
  } finally {
    openDirectory.cleanup();
  }
  const list = withSecretsFile('["BROWSERBASE_API_KEY"]');
  try {
    assert.throws(() => readOperatorSecretsFile(list.path), /one JSON object/);
  } finally {
    list.cleanup();
  }
});

test('refuses wrapper-managed names, bad identifiers, and empty values', () => {
  for (const [contents, pattern] of [
    [JSON.stringify({ CHICKPEA_AUTH_SECRET: 'x' }), /managed by the deployment wrapper/],
    [JSON.stringify({ 'browserbase-key': 'x' }), /not a valid secret name/],
    [JSON.stringify({ BROWSERBASE_API_KEY: '   ' }), /non-empty string/],
    [JSON.stringify({ BROWSERBASE_API_KEY: 42 }), /non-empty string/],
    ['{}', /names no secrets/],
  ] as const) {
    const file = withSecretsFile(contents);
    try {
      assert.throws(() => readOperatorSecretsFile(file.path), pattern, `${OPERATOR_SECRETS_ENV}: ${contents}`);
    } finally {
      file.cleanup();
    }
  }
});

test('wrapper-generated secrets win over operator secrets on a name clash', () => {
  assert.deepEqual(
    mergeDeploymentSecrets({ GENERATED: 'wrapper' }, { GENERATED: 'operator', BROWSERBASE_API_KEY: 'bb' }),
    { GENERATED: 'wrapper', BROWSERBASE_API_KEY: 'bb' },
  );
  assert.deepEqual(mergeDeploymentSecrets(undefined, undefined), {});
});
