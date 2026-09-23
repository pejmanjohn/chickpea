import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  createWebsiteLogin,
  deleteWebsiteLogin,
  getWebsiteLogin,
  intersectFrozenWebsiteLogins,
  listWebsiteLogins,
  MAX_WEBSITE_LOGINS,
  normalizeWebsiteLoginHost,
  readWebsiteLoginSecrets,
  setWebsiteLoginContext,
  setWebsiteLoginHandoff,
  touchWebsiteLoginUsed,
  WEBSITE_LOGINS_SETTING,
  WebsiteLoginInputError,
  WebsiteLoginLimitError,
  WebsiteLoginStateError,
  type WebsiteLoginDependencies,
} from '../src/browser/logins.ts';
import { websiteLoginsForTurn } from '../src/browser/capability.ts';
import { computeSnapshotHash, type EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';

const PASSWORD = 'pw-sentinel-Plaintext-7c1f';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function withLogins(
  run: (input: {
    dbPath: string;
    deps: WebsiteLoginDependencies;
    settings: SqliteSettingsStore;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chickpea-website-logins-'));
  const dbPath = path.join(directory, 'state.db');
  const settings = new SqliteSettingsStore(dbPath);
  const deps = { store: settings, keyring: generateCredentialKeyring('website_login_test') };
  try {
    await run({ dbPath, deps, settings });
  } finally {
    settings.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function sqliteBytes(dbPath: string): Buffer {
  const parts = [readFileSync(dbPath)];
  for (const suffix of ['-wal', '-journal']) {
    if (existsSync(`${dbPath}${suffix}`)) parts.push(readFileSync(`${dbPath}${suffix}`));
  }
  return Buffer.concat(parts);
}

const credentialsInput = {
  host: 'App.Example.com',
  label: 'Billing portal',
  ownerKind: 'team' as const,
  createdByMembershipId: 'membership_admin',
  method: 'credentials' as const,
  username: 'ops@example.com',
  password: PASSWORD,
  totpSeed: 'jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp',
};

test('a credentials login round-trips through encrypted storage and never lands in SQLite plaintext', async () => {
  await withLogins(async ({ dbPath, deps, settings }) => {
    const login = await createWebsiteLogin(deps, credentialsInput);
    assert.match(login.id, /^wl_[a-f0-9]{32}$/);
    assert.equal(login.host, 'app.example.com');
    assert.equal(login.username, 'ops@example.com');
    assert.equal(login.ownerKind, 'team');
    assert.equal('ownerMembershipId' in login, false);
    assert.equal(JSON.stringify(login).includes(PASSWORD), false);

    assert.deepEqual(await readWebsiteLoginSecrets(deps, login.id), {
      username: 'ops@example.com',
      password: PASSWORD,
      totpSeed: TOTP,
    });

    const metadata = await settings.getSetting(WEBSITE_LOGINS_SETTING);
    assert.ok(metadata);
    assert.equal(metadata.includes(PASSWORD), false);
    assert.equal(metadata.includes(TOTP), false);
    const revision = await settings.getEncryptedCredentialRevision(`website_login.${login.id}`);
    assert.ok(revision);
    assert.match(revision.revision, /^wl_rev_[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(revision).includes(PASSWORD), false);
    const bytes = sqliteBytes(dbPath);
    assert.equal(bytes.includes(Buffer.from(PASSWORD)), false);
    assert.equal(bytes.includes(Buffer.from(TOTP)), false);

    assert.deepEqual(await listWebsiteLogins(settings), [login]);
    assert.deepEqual(await getWebsiteLogin(settings, login.id), login);

    assert.equal(await deleteWebsiteLogin(deps, login.id), true);
    assert.deepEqual(await listWebsiteLogins(settings), []);
    assert.equal(await settings.getEncryptedCredentialRevision(`website_login.${login.id}`), undefined);
    assert.equal(await readWebsiteLoginSecrets(deps, login.id), undefined);
    // Deleting again, or deleting a login whose secret is already gone, is fine.
    assert.equal(await deleteWebsiteLogin(deps, login.id), false);
  });
});

test('a handoff login stores no secret and a member login records its owner', async () => {
  await withLogins(async ({ deps, settings }) => {
    const login = await createWebsiteLogin(deps, {
      host: 'intranet.local:8443',
      label: 'Intranet',
      ownerKind: 'member',
      ownerMembershipId: 'membership_ana',
      createdByMembershipId: 'membership_ana',
      method: 'handoff',
    });
    assert.equal(login.host, 'intranet.local:8443');
    assert.equal(login.ownerMembershipId, 'membership_ana');
    assert.equal(await settings.getEncryptedCredentialRevision(`website_login.${login.id}`), undefined);
    assert.equal(await readWebsiteLoginSecrets(deps, login.id), undefined);
    await assert.rejects(
      createWebsiteLogin(deps, { ...credentialsInput, method: 'handoff' }),
      (error: unknown) => error instanceof WebsiteLoginInputError && error.code === 'invalid_password',
    );
    await assert.rejects(
      createWebsiteLogin(deps, { ...credentialsInput, password: undefined as unknown as string }),
      (error: unknown) => error instanceof WebsiteLoginInputError && error.code === 'invalid_password',
    );
    await assert.rejects(
      createWebsiteLogin(deps, { ...credentialsInput, totpSeed: 'not base32 !!' }),
      (error: unknown) => error instanceof WebsiteLoginInputError && error.code === 'invalid_totp_seed',
    );
    await assert.rejects(
      createWebsiteLogin(deps, { ...credentialsInput, ownerKind: 'member' }),
      (error: unknown) => error instanceof WebsiteLoginInputError && error.code === 'invalid_owner',
    );
  });
});

test('host normalization keeps a hostname and explicit port and rejects anything else', () => {
  assert.equal(normalizeWebsiteLoginHost('  Example.COM '), 'example.com');
  assert.equal(normalizeWebsiteLoginHost('example.com:8080'), 'example.com:8080');
  assert.equal(normalizeWebsiteLoginHost('xn--bcher-kva.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeWebsiteLoginHost('bücher.example'), 'xn--bcher-kva.example');
  for (const bad of [
    '',
    'https://example.com',
    'example.com/login',
    'example.com?x=1',
    'example.com#top',
    'user@example.com',
    'exa mple.com',
    'example.com:99999',
    '.example.com',
    'example.com.',
    '//example.com',
  ]) {
    assert.throws(
      () => normalizeWebsiteLoginHost(bad),
      (error: unknown) => error instanceof WebsiteLoginInputError && error.code === 'invalid_host',
      bad,
    );
  }
});

test('a failed metadata write removes the just-written secret', async () => {
  await withLogins(async ({ dbPath, deps, settings }) => {
    const contended: WebsiteLoginDependencies = {
      keyring: deps.keyring,
      store: Object.assign(Object.create(settings) as SqliteSettingsStore, {
        applySettingsPatch: async () => false,
      }),
    };
    await assert.rejects(createWebsiteLogin(contended, credentialsInput), WebsiteLoginStateError);

    const failing: WebsiteLoginDependencies = {
      keyring: deps.keyring,
      store: Object.assign(Object.create(settings) as SqliteSettingsStore, {
        applySettingsPatch: async () => {
          throw new Error('disk full');
        },
      }),
    };
    await assert.rejects(createWebsiteLogin(failing, credentialsInput), /disk full/);

    assert.deepEqual(await listWebsiteLogins(settings), []);
    assert.equal(await settings.getSetting(WEBSITE_LOGINS_SETTING), undefined);
    // No encrypted revision for any website login survives the failures.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM app_encrypted_credential_revisions WHERE credential_key LIKE 'website_login.%'",
      ).get() as { count: number };
      assert.equal(Number(row.count), 0);
    } finally {
      db.close();
    }
  });
});

test('the login list is capped', async () => {
  await withLogins(async ({ deps, settings }) => {
    const seeded = Array.from({ length: MAX_WEBSITE_LOGINS }, (_, index) => ({
      id: `wl_${index.toString(16).padStart(32, '0')}`,
      host: `site${index}.example`,
      label: `Site ${index}`,
      ownerKind: 'team',
      createdByMembershipId: 'membership_admin',
      method: 'handoff',
      createdAt: 1,
    }));
    await settings.setSetting(WEBSITE_LOGINS_SETTING, JSON.stringify(seeded));
    await assert.rejects(createWebsiteLogin(deps, credentialsInput), WebsiteLoginLimitError);
    assert.equal((await listWebsiteLogins(settings)).length, MAX_WEBSITE_LOGINS);
  });
});

test('touch and context updates write the per-login state row, not the catalog, and malformed rows are ignored', async () => {
  await withLogins(async ({ deps, settings }) => {
    const login = await createWebsiteLogin(deps, credentialsInput);
    const catalog = await settings.getSetting(WEBSITE_LOGINS_SETTING);
    assert.equal(await touchWebsiteLoginUsed(settings, login.id, 1234), true);
    assert.equal(await setWebsiteLoginContext(settings, login.id, 'ctx_abc-123'), true);
    assert.equal(await setWebsiteLoginHandoff(settings, login.id, 'sess-1'), true);
    assert.equal(await settings.getSetting(WEBSITE_LOGINS_SETTING), catalog);
    assert.deepEqual(JSON.parse((await settings.getSetting(`website_login_state.${login.id}`))!), {
      lastUsedAt: 1234,
      contextId: 'ctx_abc-123',
      handoffSessionId: 'sess-1',
    });
    const updated = await getWebsiteLogin(settings, login.id);
    assert.equal(updated?.lastUsedAt, 1234);
    assert.equal(updated?.contextId, 'ctx_abc-123');
    assert.equal(updated?.handoffSessionId, 'sess-1');
    assert.deepEqual(await listWebsiteLogins(settings), [updated]);
    assert.equal(await setWebsiteLoginHandoff(settings, login.id, undefined), true);
    assert.equal((await getWebsiteLogin(settings, login.id))?.handoffSessionId, undefined);
    assert.equal(await touchWebsiteLoginUsed(settings, `wl_${'f'.repeat(32)}`, 1), false);
    assert.deepEqual(await readWebsiteLoginSecrets(deps, login.id), {
      username: 'ops@example.com',
      password: PASSWORD,
      totpSeed: TOTP,
    });

    const raw = JSON.parse((await settings.getSetting(WEBSITE_LOGINS_SETTING))!) as unknown[];
    await settings.setSetting(
      WEBSITE_LOGINS_SETTING,
      JSON.stringify([...raw, { id: 'not-a-login' }, 'junk']),
    );
    assert.deepEqual((await listWebsiteLogins(settings)).map(({ id }) => id), [login.id]);
  });
});

test('an envelope copied onto another login does not decrypt', async () => {
  await withLogins(async ({ deps, settings }) => {
    const first = await createWebsiteLogin(deps, credentialsInput);
    const second = await createWebsiteLogin(deps, { ...credentialsInput, password: 'other-secret' });
    const firstRevision = await settings.getEncryptedCredentialRevision(`website_login.${first.id}`);
    const secondRevision = await settings.getEncryptedCredentialRevision(`website_login.${second.id}`);
    assert.ok(firstRevision && secondRevision);
    await settings.replaceEncryptedCredentialRevision({
      key: `website_login.${second.id}`,
      expectedRevision: secondRevision.revision,
      revision: firstRevision.revision,
      contextId: firstRevision.contextId,
      envelope: firstRevision.envelope,
    });
    await assert.rejects(readWebsiteLoginSecrets(deps, second.id), WebsiteLoginStateError);
  });
});

test('frozen website logins cap additions while live revocations and downgrades apply', () => {
  const a = { id: `wl_${'a'.repeat(32)}`, host: 'a.example', method: 'credentials' as const, level: 'act' as const, label: 'A' };
  const b = { id: `wl_${'b'.repeat(32)}`, host: 'b.example', method: 'handoff' as const, level: 'check' as const, label: 'B' };
  const c = { id: `wl_${'c'.repeat(32)}`, host: 'c.example', method: 'credentials' as const, level: 'check' as const, label: 'C' };

  // Live adds c and raises b: neither widens the frozen turn.
  assert.deepEqual(
    intersectFrozenWebsiteLogins([a, b], [a, { ...b, level: 'act' }, c]),
    [a, b],
  );
  // Live removes a: revoked.
  assert.deepEqual(intersectFrozenWebsiteLogins([a, b], [b]), [b]);
  // Live lowers a to check: downgraded.
  assert.deepEqual(intersectFrozenWebsiteLogins([a], [{ ...a, level: 'check' }]), [{ ...a, level: 'check' }]);
  // Live re-pointed a at another host or method: revoked.
  assert.deepEqual(intersectFrozenWebsiteLogins([a], [{ ...a, host: 'evil.example' }]), []);
  assert.deepEqual(intersectFrozenWebsiteLogins([a], [{ ...a, method: 'handoff' }]), []);
  // Pre-field snapshots.
  assert.deepEqual(intersectFrozenWebsiteLogins(undefined, [a]), []);
  assert.deepEqual(intersectFrozenWebsiteLogins([a], undefined), []);
});

test('turn freezing tolerates Agents frozen before grants existed and never fails the turn', async () => {
  await withLogins(async ({ deps, settings }) => {
    const login = await createWebsiteLogin(deps, credentialsInput);
    // Snapshot Agents persisted before the field deserialize without it.
    assert.deepEqual(await websiteLoginsForTurn(settings, undefined), []);
    assert.deepEqual(await websiteLoginsForTurn(settings, [
      { loginId: login.id, level: 'check', enabled: false },
    ]), []);
    assert.deepEqual(await websiteLoginsForTurn(settings, [
      { loginId: login.id, level: 'act', enabled: true },
    ]), [{
      id: login.id,
      host: 'app.example.com',
      label: 'Billing portal',
      level: 'act',
      method: 'credentials',
      username: 'ops@example.com',
    }]);
    const broken = { getSetting: async () => { throw new Error('offline'); } } as unknown as SettingsStore;
    assert.deepEqual(await websiteLoginsForTurn(broken, [
      { loginId: login.id, level: 'act', enabled: true },
    ]), []);
  });
});

test('snapshot hashes of Agents without grants are unchanged by the new field', () => {
  const agent: CustomAgentConfig = {
    id: 'agent_one', kind: 'user', revision: 1, name: 'One', instructions: 'Help.',
    enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
  const config = {
    workspaceId: 'T1', channelId: 'C1', agentId: 'agent_one', agent, model: 'm',
    provider: 'p', instructions: 'Help.', instructionLayers: [],
    modelAttribution: { source: 'pinned', providerId: 'p' },
  } as unknown as EffectiveSlackConfig;
  const legacy = computeSnapshotHash(config);
  assert.equal(computeSnapshotHash({ ...config, agent: { ...agent, websiteLogins: [] } }), legacy);
  assert.notEqual(computeSnapshotHash({
    ...config,
    agent: { ...agent, websiteLogins: [{ loginId: `wl_${'a'.repeat(32)}`, level: 'check', enabled: true }] },
  }), legacy);
});

test('runtime fields still in an older catalog entry keep reading, and the state row takes over on write', async () => {
  await withLogins(async ({ deps, settings }) => {
    const login = await createWebsiteLogin(deps, credentialsInput);
    const [entry] = JSON.parse((await settings.getSetting(WEBSITE_LOGINS_SETTING))!) as Record<string, unknown>[];
    await settings.setSetting(WEBSITE_LOGINS_SETTING, JSON.stringify([
      { ...entry, contextId: 'ctx_legacy', handoffSessionId: 'sess-legacy', lastUsedAt: 7 },
    ]));
    const legacy = await getWebsiteLogin(settings, login.id);
    assert.equal(legacy?.contextId, 'ctx_legacy');
    assert.equal(legacy?.handoffSessionId, 'sess-legacy');
    assert.equal(legacy?.lastUsedAt, 7);

    // The first state write starts from the catalog's values.
    assert.equal(await setWebsiteLoginHandoff(settings, login.id, undefined), true);
    const moved = await getWebsiteLogin(settings, login.id);
    assert.equal(moved?.contextId, 'ctx_legacy');
    assert.equal(moved?.handoffSessionId, undefined);
    assert.equal(moved?.lastUsedAt, 7);
    assert.deepEqual((await listWebsiteLogins(settings))[0], moved);
  });
});

test('deleting a login removes its state row', async () => {
  await withLogins(async ({ deps, settings }) => {
    const login = await createWebsiteLogin(deps, credentialsInput);
    await setWebsiteLoginContext(settings, login.id, 'ctx_1');
    assert.ok(await settings.getSetting(`website_login_state.${login.id}`));
    assert.equal(await deleteWebsiteLogin(deps, login.id), true);
    assert.equal(await settings.getSetting(`website_login_state.${login.id}`), undefined);
    assert.equal(await setWebsiteLoginContext(settings, login.id, 'ctx_2'), false);
    assert.equal(await settings.getSetting(`website_login_state.${login.id}`), undefined);
  });
});
