#!/usr/bin/env node
/** Verify Node scheduler readiness across the separately emitted production entries. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  loadTsModule,
  seedOfflineDemoChannelConfig,
  seedOfflineSlackAuthority,
} from './lib/offline-harness.mjs';

assertNodeVersion();
const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-capability-'));
const statePath = join(directory, 'state.sqlite');
const priorEnvironment = new Map(Object.entries(process.env));
Object.assign(process.env, {
  SLACK_STATE_DB_PATH: statePath,
  TAG_DB_PATH: join(directory, 'transcripts.sqlite'),
  CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.sqlite'),
  CHICKPEA_CREDENTIAL_KEYRING_PATH: join(directory, 'credential-keyring.json'),
  CHICKPEA_AUTH_SECRET: '9d'.repeat(32),
  CHICKPEA_DISABLE_TELEMETRY: 'true',
  DO_NOT_TRACK: '1',
});

let background;
try {
  await buildNodeServer();
  await seedOfflineDemoChannelConfig(statePath, {
    workspaceId: 'TDEMO',
    channelId: 'C_EXEC',
  });
  await seedOfflineSlackAuthority({
    stateDbPath: statePath,
    keyringPath: process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH,
    canonicalOrigin: 'http://127.0.0.1:3000',
    teamId: 'TDEMO',
    slackUserId: 'U_ALICE',
    appId: 'ADEMO',
    botUserId: 'UBOT',
  });
  const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
  const config = new SqliteConfigStore(statePath);
  const installation = await config.getWorkspaceInstallation('TDEMO');
  assert(installation, 'Offline workspace installation was not seeded.');
  await config.updateWorkspaceInstallation(
    'TDEMO',
    { runtimeContract: 'chickpea-v1' },
    installation.revision,
  );
  config.close();

  const outputDirectory = join(REPO_ROOT, 'dist');
  const appChunk = readdirSync(outputDirectory).find((file) =>
    file.endsWith('.mjs') &&
    readFileSync(join(outputDirectory, file), 'utf8').includes('function createLiveWorkspaceManagementService'));
  assert(appChunk, 'Built app-side management service chunk was not found.');
  const appModule = await import(pathToFileURL(join(outputDirectory, appChunk)).href);
  const createLiveService = Object.values(appModule).find((value) =>
    typeof value === 'function' && value.name === 'createLiveWorkspaceManagementService');
  assert.equal(typeof createLiveService, 'function', 'Built app-side management service export was not found.');

  const { SqliteIdentityStore } = await loadTsModule('src/identity/store.ts');
  const identity = new SqliteIdentityStore(statePath);
  const resolved = await identity.resolveSlackIdentity('TDEMO', 'U_ALICE');
  identity.close();
  assert(resolved, 'Offline Slack owner was not seeded.');
  const context = {
    userId: resolved.user.id,
    membershipId: resolved.membership.id,
    organizationId: resolved.membership.organizationId,
    actingAgentId: 'agent_default',
    origin: {
      kind: 'slack',
      workspaceId: 'TDEMO',
      channelId: 'C_EXEC',
      threadTs: '100.1',
      agentId: 'agent_default',
    },
  };
  const service = createLiveService();
  const schedulingAvailable = async () =>
    (await service.inspectWorkspace(context)).selfManagement?.routineSchedulingAvailable;

  assert.equal(await schedulingAvailable(), false, 'Imports alone must not enable scheduling.');
  background = await import(pathToFileURL(join(outputDirectory, 'node-background.mjs')).href);
  await background.startNodeBackground();
  assert.equal(
    await schedulingAvailable(),
    true,
    'A service created before background startup must observe scheduler readiness.',
  );
  await background.stopNodeBackground();
  assert.equal(
    await schedulingAvailable(),
    false,
    'The same app-side service must observe readiness withdrawal after shutdown.',
  );
  console.log('PASS  built Node app observes scheduler start and stop across entry artifacts');
} finally {
  await background?.stopNodeBackground?.().catch(() => undefined);
  for (const key of Object.keys(process.env)) {
    if (!priorEnvironment.has(key)) delete process.env[key];
  }
  for (const [key, value] of priorEnvironment) process.env[key] = value;
  rmSync(directory, { recursive: true, force: true });
}
