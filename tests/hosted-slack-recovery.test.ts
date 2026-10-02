import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  HOSTED_SLACK_INSTALLATION_ID,
  WORKSPACE_SLACK_INSTALLATION_ID,
} from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  resolveSlackInstallationCredentials,
  SlackCredentialRecoveryOnlyError,
  SlackCredentialUnavailableError,
  stageSlackCredentialBundle,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import type { CredentialKeyring } from '../src/slack/secret-envelope.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * A deployment keyring that fails to load is the deployment's problem, not
 * each installation's: under installation tenancy it latches nothing.
 */

const APP = 'AHOSTED1';
const TEAM = 'TTENANT1';
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_tenant_a' });

/** A hosted installation with an Owner and a bot bundle written under `keyring`. */
async function installation(t: TestContext, keyring: CredentialKeyring) {
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => {
    identity.close();
    invalidateSlackInstallationCredentialCache();
  });
  const owner = await createSlackOwner(identity, { teamId: TEAM, userId: 'U1' });
  await writeHostedSlackBotCredentials({ state: identity, keyring }, null, {
    botToken: 'xoxb-original', botUserId: 'UBOT', appId: APP, teamId: TEAM,
    grantedScopes: ['chat:write'], validatedAt: 1_700_000_000_000,
  });
  return { identity, owner };
}

test('a deployment keyring that fails to load stops hosted service without latching recovery; standalone still latches', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-keyring-load-'));
  const previous = process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH;
  const broken = join(directory, 'keyring.json');
  writeFileSync(broken, 'not a keyring', { mode: 0o600 });
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = broken;
  t.after(() => {
    if (previous === undefined) delete process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH;
    else process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const hosted = await installation(t, generateCredentialKeyring('key_v1'));
  await assert.rejects(
    resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, ENV, { state: hosted.identity, env: ENV }),
    SlackCredentialUnavailableError,
  );
  assert.equal((await hosted.identity.getAuthControl())?.healthGate, 'normal', 'the installation is not locked');

  const standalone = new SqliteIdentityStore(':memory:');
  t.after(() => standalone.close());
  const keyring = generateCredentialKeyring('key_v1');
  const bundle = await stageSlackCredentialBundle({ state: standalone, keyring }, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'connected_credentials', expectedActiveRevision: null, appId: 'A1', teamId: 'T1',
    secrets: { signingSecret: 'secret', botToken: 'xoxb-standalone' },
  });
  await promoteSlackCredentialBundle({ state: standalone, keyring }, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: bundle.revision, expectedActiveRevision: null,
  });
  invalidateSlackInstallationCredentialCache();
  await assert.rejects(
    resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, undefined, { state: standalone }),
    SlackCredentialRecoveryOnlyError,
  );
  assert.equal((await standalone.getAuthControl())?.healthGate, 'recovery_only');
});
