import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Executable environment modules intentionally have no declarations.
import { resolveLaneAuthorityCredentials } from '../scripts/lib/environment-preflight.mjs';

const TOKEN = 'a'.repeat(43);

test('host environment variables win over the lane credential file', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-lane-credentials-'));
  try {
    writeFileSync(join(root, 'cobalt-live.json'), JSON.stringify({
      origin: 'https://file.example', authorityReadToken: 'b'.repeat(43),
    }));
    const resolved = resolveLaneAuthorityCredentials('cobalt', {
      env: {
        CHICKPEA_ENV_COBALT_LIVE_AUTHORITY_URL: 'https://env.example/internal/environment/authority',
        CHICKPEA_ENV_COBALT_LIVE_AUTHORITY_READ_TOKEN: TOKEN,
      },
      credentialsRoot: root,
    });
    assert.deepEqual(resolved, {
      url: 'https://env.example/internal/environment/authority', token: TOKEN, source: 'environment',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the owner-only lane credential file supplies the token and the authority URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-lane-credentials-'));
  try {
    writeFileSync(join(root, 'amber-live.json'), JSON.stringify({
      target: 'amber', origin: 'https://chickpea-amber-live.example.workers.dev/', authorityReadToken: TOKEN,
      recoveryToken: 'never-read',
    }));
    const resolved = resolveLaneAuthorityCredentials('amber', { env: {}, credentialsRoot: root });
    assert.deepEqual(resolved, {
      url: 'https://chickpea-amber-live.example.workers.dev/internal/environment/authority',
      token: TOKEN,
      source: 'lane-credentials',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing credential file leaves the environment values untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-lane-credentials-'));
  try {
    const resolved = resolveLaneAuthorityCredentials('cobalt', { env: {}, credentialsRoot: root });
    assert.deepEqual(resolved, { url: undefined, token: undefined, source: 'environment' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a registration origin supplies only the URL, after the environment and the credential file', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-lane-credentials-'));
  try {
    const authorityOrigin = 'https://chickpea-violet.example.workers.dev';
    // Token from the host, origin from the registry record: the registry never carries a token.
    assert.deepEqual(resolveLaneAuthorityCredentials('violet', {
      env: { CHICKPEA_ENV_VIOLET_LIVE_AUTHORITY_READ_TOKEN: TOKEN }, credentialsRoot: root, authorityOrigin,
    }), { url: `${authorityOrigin}/internal/environment/authority`, token: TOKEN, source: 'registry' });
    // Without a token the URL alone does not make the lane readable.
    assert.deepEqual(resolveLaneAuthorityCredentials('violet', { env: {}, credentialsRoot: root, authorityOrigin }), {
      url: `${authorityOrigin}/internal/environment/authority`, token: undefined, source: 'registry',
    });
    // The host variable and the credential file both win over the record.
    assert.equal(resolveLaneAuthorityCredentials('violet', {
      env: { CHICKPEA_ENV_VIOLET_LIVE_AUTHORITY_URL: 'https://env.example/internal/environment/authority', CHICKPEA_ENV_VIOLET_LIVE_AUTHORITY_READ_TOKEN: TOKEN },
      credentialsRoot: root, authorityOrigin,
    }).url, 'https://env.example/internal/environment/authority');
    writeFileSync(join(root, 'violet-live.json'), JSON.stringify({ origin: 'https://file.example', authorityReadToken: TOKEN }));
    assert.deepEqual(resolveLaneAuthorityCredentials('violet', { env: {}, credentialsRoot: root, authorityOrigin }), {
      url: 'https://file.example/internal/environment/authority', token: TOKEN, source: 'lane-credentials',
    });
    // Only an exact https origin is accepted from a record.
    for (const rejected of ['http://violet.example', 'https://violet.example/authority', 'https://user:pw@violet.example', 'violet.example']) {
      assert.equal(resolveLaneAuthorityCredentials('cobalt', { env: {}, credentialsRoot: root, authorityOrigin: rejected }).url, undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
