import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { mintSetupCapability, setupCapabilityUrl } from '../src/auth/setup-capability.mjs';
import { createWebsiteLogin } from '../src/browser/logins.ts';
import { saveStoredComposioProjectKey } from '../src/config/composio-settings.ts';
import { RETIRED_SETTING_KEYS } from '../src/config/retired-settings.ts';
import {
  InstallationContextError,
  installationOwnershipOf,
  objectInstallationEnv,
} from '../src/config/installation-scope.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { GATEWAY_HTTP_SETTING, sealDeliveryKey, type HttpDeliveryState } from '../src/slack/gateway/http-delivery.ts';
import {
  GATEWAY_DEPLOYMENT_IDENTITY_SETTING,
  loadOrCreateGatewayDeploymentIdentity,
} from '../src/slack/gateway/identity.ts';
import { renderSlackActionLink } from '../src/slack/message-format.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { promisify } from '../src/state/async-facade.ts';
import {
  eraseInstallationObject,
  exportInstallationObject,
  installationStateStoreObject,
  listInstallationObjects,
  type InstallationObject,
} from '../src/state/installation-objects.ts';
import { objectHostFunctions, OBJECT_EXPORT_FORMAT } from '../src/state/object-host.ts';
import { hostedDeployment, runnerJobs, type HostedInstallation } from './helpers/installation-objects.ts';

/**
 * A host exports and erases one installation's objects through the host
 * functions, a page at a time, and nothing of a neighbouring installation
 * changes.
 */

const SLACK_AGENT = CHICKPEA_SLACK_AGENT_BINDING;
const KINDS_TO_BINDING: Record<string, string> = {
  thread_runner: 'SLACK_THREAD_RUNNER',
  slack_agent: SLACK_AGENT,
  routine_agent: 'FLUE_CHICKPEA_ROUTINE_EXECUTION_V2_AGENT',
};

function job(id: string, team: string, messageTs: string): TurnJob {
  const assignment: ResolvedAssignment = {
    workspaceId: team, channelId: 'C_EXPORT', agentId: 'agent_export', model: 'local-stub/export',
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_export', kind: 'user', revision: 1, name: 'Export', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, assignment,
    turn: {
      workspaceId: team, channelId: 'C_EXPORT', eventId: `Ev_${id}`, text: `Question ${id}`,
      userId: 'U_MEMBER', messageTs, threadTs: messageTs, source: 'app_mention',
      contextMode: 'thread', channelType: 'channel',
    },
  };
}

/** Tenant data in every kind of object one installation owns. */
function populate(deployment: ReturnType<typeof hostedDeployment>, installation: HostedInstallation, team: string) {
  const { stores, env } = installation;
  for (const [index, messageTs] of ['1800000000.000100', '1800000000.000200'].entries()) {
    const queued = job(`tj_${team}_${index}`, team, messageTs);
    stores.turnJobs.enqueue(queued);
    stores.turnJobs.freezeRuntimePlan(queued.id, compileRuntimePlanV2({
      installation: installationOwnershipOf(env)!, turn: queued.turn, assignment: queued.assignment,
      instructions: 'Help.', memoryEpoch: 1,
    }));
  }
  stores.settings.setSetting('slack.teamName', `Team ${team}`);
  stores.settings.setSetting('mcp.agent_export.docs.bearer', `secret-bearer-${team}`);
  stores.settings.setSetting('connection-account.ref_1.credential', `secret-credential-${team}`);
  stores.settings.setSetting('provider.anthropic.apiKey', `sk-ant-${team}`);
  stores.settings.setSetting('telemetry.identity.v1', JSON.stringify({ distinctId: 'd', hmacKey: `hmac-${team}` }));
  installation.db.run(
    `INSERT INTO app_encrypted_credential_revisions (credential_key, revision, context_id, envelope_version,
       envelope_algorithm, key_id, nonce, ciphertext, created_at, updated_at)
     VALUES ('model_provider.anthropic', 'r1', 'ctx', 1, 'A256GCM', 'key_a', 'nonce-${team}', 'ciphertext-${team}', 1, 1)`,
  );
  void installation.storage.setAlarm(1_900_000_000_000);
  for (const object of inventory(installation)) {
    const target = deployment.object(KINDS_TO_BINDING[object.kind]!, object.name);
    if (object.kind === 'thread_runner') {
      runnerJobs(target.storage).admit({ id: `job_${team}`, threadKey: 'thread', payload: { team } }, 1);
    } else {
      target.storage.sql.exec('CREATE TABLE flue_transcript (id INTEGER PRIMARY KEY, body TEXT, image BLOB)');
      target.storage.sql.exec(
        'INSERT INTO flue_transcript (body, image) VALUES (?, ?)', `Transcript of ${team}`, new Uint8Array([1, 2, 3]),
      );
      void target.storage.put('flue:wake', { at: new Date(1_800_000_000_000), seen: new Set(['a']), $tag: team });
    }
    void target.storage.setAlarm(1_900_000_000_000);
  }
}

function inventory(installation: HostedInstallation): InstallationObject[] {
  return installation.stores.objectInventory.list({ limit: 1_000 }).objects.map(({ kind, name }) => ({ kind, name }));
}

/** Every page of one object's export, concatenated. */
async function exportAll(
  env: HostedInstallation['env'],
  object: InstallationObject,
  mode: 'portable' | 'full',
  maxBytes?: number,
): Promise<{ text: string; pages: number }> {
  let cursor: string | null | undefined;
  let text = '';
  let pages = 0;
  do {
    const page = await exportInstallationObject(env, object, {
      mode, ...(cursor ? { cursor } : {}), ...(maxBytes ? { maxBytes } : {}),
    });
    text += page.lines;
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor);
  return { text, pages };
}

async function exportInstallation(installation: HostedInstallation): Promise<Record<string, string>> {
  const objects = [...inventory(installation), installationStateStoreObject(installation.env)];
  const exported: Record<string, string> = {};
  for (const object of objects) {
    exported[`${object.kind}:${object.name}`] = createHash('sha256')
      .update((await exportAll(installation.env, object, 'full')).text).digest('hex');
  }
  return exported;
}

test('erasing one installation\'s objects, the state store last, leaves its neighbour byte-identical', async () => {
  const deployment = hostedDeployment(['inst_erase_a', 'inst_erase_b']);
  const a = deployment.installation('inst_erase_a');
  const b = deployment.installation('inst_erase_b');
  populate(deployment, a, 'T_A');
  populate(deployment, b, 'T_B');
  const neighbourBefore = await exportInstallation(b);
  const objectsOfA = (await listInstallationObjects(a.env)).objects.map(({ kind, name }) => ({ kind, name }));
  assert.deepEqual(objectsOfA.map(({ kind }) => kind), ['slack_agent', 'slack_agent', 'thread_runner', 'thread_runner']);

  for (const object of objectsOfA) {
    assert.deepEqual(await eraseInstallationObject(a.env, object, { confirmInstallationId: 'inst_erase_a' }), { erased: true });
  }
  assert.deepEqual(await eraseInstallationObject(a.env, installationStateStoreObject(a.env), {
    confirmInstallationId: 'inst_erase_a',
  }), { erased: true });

  for (const object of objectsOfA) {
    const erased = deployment.object(KINDS_TO_BINDING[object.kind]!, object.name).storage;
    assert.deepEqual(erased.tables(), [], `${object.name} keeps no table`);
    assert.equal(erased.kv.size, 0);
    assert.equal(erased.alarm, null);
  }
  assert.deepEqual(a.storage.tables(), []);
  assert.equal(a.storage.alarm, null);
  // While the instance that erased it lives on, an erased object exports
  // nothing but its header. A Flue instance or a runner constructed again
  // re-creates its schema, so this holds only until then.
  const after = await exportAll(a.env, objectsOfA[0]!, 'full');
  assert.deepEqual(after.text.trim().split('\n').map((line) => JSON.parse(line).t), ['object']);
  assert.deepEqual(await exportInstallation(b), neighbourBefore);
  assert.ok(b.stores.turnJobs.getFrozenRuntimePlan('tj_T_B_0'), 'the neighbour still serves its turns');

  // Erasure must be the installation's last contact: any later one, even an
  // inventory read, builds an empty, schema-initialized state store again.
  assert.deepEqual((await listInstallationObjects(a.env)).objects, []);
  assert.ok(a.storage.tables().includes('installation_object_inventory'), 'the contact re-created the schema');
});

test('an erasure needs its installation confirmed, and never reaches another installation\'s objects', async () => {
  const deployment = hostedDeployment(['inst_guard_a', 'inst_guard_b']);
  const a = deployment.installation('inst_guard_a');
  const b = deployment.installation('inst_guard_b');
  populate(deployment, a, 'T_A');
  populate(deployment, b, 'T_B');
  const [objectOfB] = inventory(b);

  await assert.rejects(
    eraseInstallationObject(a.env, inventory(a)[0]!, { confirmInstallationId: 'inst_guard_b' }),
    InstallationContextError,
  );
  for (const foreign of [objectOfB!, installationStateStoreObject(b.env)]) {
    await assert.rejects(eraseInstallationObject(a.env, foreign, { confirmInstallationId: 'inst_guard_a' }),
      InstallationContextError);
    await assert.rejects(exportInstallationObject(a.env, foreign, { mode: 'full' }), InstallationContextError);
  }
  // The object itself checks the caller's installation against its own name.
  const objectB = deployment.object(KINDS_TO_BINDING[objectOfB!.kind]!, objectOfB!.name);
  await assert.rejects(
    (objectB.host.chickpeaHostErase as (request: { installationId: string }) => Promise<unknown>)({ installationId: 'inst_guard_a' }),
    InstallationContextError,
  );
  // A state store bound to another installation is never erased.
  a.db.run("UPDATE installation_binding SET installation_id = 'inst_guard_b'");
  await assert.rejects(
    eraseInstallationObject(a.env, installationStateStoreObject(a.env), { confirmInstallationId: 'inst_guard_a' }),
    InstallationContextError,
  );
  assert.ok(a.storage.tables().length > 0);
  assert.ok(b.storage.tables().length > 0 && deployment.object(KINDS_TO_BINDING[objectOfB!.kind]!, objectOfB!.name).storage.tables().length > 0);
});

test('export pages are stable and resumable, and a portable export leaves every secret out', async () => {
  const deployment = hostedDeployment(['inst_export_a']);
  const a = deployment.installation('inst_export_a');
  populate(deployment, a, 'T_A');
  const store = installationStateStoreObject(a.env);

  const whole = await exportAll(a.env, store, 'full', 8 * 1024 * 1024);
  const paged = await exportAll(a.env, store, 'full', 4_096);
  assert.equal(whole.pages, 1);
  assert.ok(paged.pages > 3, `the small pages split the store (${paged.pages})`);
  assert.equal(paged.text, whole.text, 'pages concatenate to the whole export');

  const first = await exportInstallationObject(a.env, store, { mode: 'full', maxBytes: 4_096 });
  const again = await exportInstallationObject(a.env, store, { mode: 'full', maxBytes: 4_096 });
  assert.deepEqual(again, first, 'the same cursor returns the same page');
  const second = await exportInstallationObject(a.env, store, { mode: 'full', maxBytes: 4_096, cursor: first.nextCursor! });
  assert.deepEqual(await exportInstallationObject(a.env, store, { mode: 'full', maxBytes: 4_096, cursor: first.nextCursor! }), second);
  await assert.rejects(exportInstallationObject(a.env, store, { mode: 'portable', cursor: first.nextCursor! }),
    /another mode/);

  const records = whole.text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records[0], { t: 'object', format: OBJECT_EXPORT_FORMAT, mode: 'full' });
  const settings = (text: string) => text.trim().split('\n').map((line) => JSON.parse(line))
    .filter((record) => record.t === 'row' && record.table === 'app_settings').map((record) => record.row.key);
  assert.ok(settings(whole.text).includes('mcp.agent_export.docs.bearer'));
  assert.match(whole.text, /ciphertext-T_A/);

  const portable = (await exportAll(a.env, store, 'portable', 4_096)).text;
  assert.deepEqual(settings(portable).filter((key) => /^(mcp\.|connection-account\.|provider\.|telemetry\.identity)/.test(key)), []);
  assert.ok(settings(portable).includes('slack.teamName'));
  for (const secret of ['secret-bearer-T_A', 'secret-credential-T_A', 'sk-ant-T_A', 'hmac-T_A', 'ciphertext-T_A', 'nonce-T_A']) {
    assert.equal(portable.includes(secret), false, `${secret} stays out of a portable export`);
  }
  const envelope = portable.trim().split('\n').map((line) => JSON.parse(line))
    .find((record) => record.t === 'row' && record.table === 'app_encrypted_credential_revisions');
  assert.equal(envelope.row.key_id, 'key_a', 'which key protected it is kept');
  assert.equal(envelope.row.ciphertext, null);
  assert.ok(portable.includes('"t":"row","table":"turn_jobs"'), 'the installation\'s own records are kept');

  // A Flue instance: its tables (BLOBs encoded) and its key-value entries.
  const agent = inventory(a).find((object) => object.kind === 'slack_agent')!;
  const agentRecords = (await exportAll(a.env, agent, 'portable')).text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(agentRecords.find((record) => record.t === 'row')?.row,
    { id: 1, body: 'Transcript of T_A', image: { $bytes: 'AQID' } });
  assert.deepEqual(agentRecords.find((record) => record.t === 'kv'), {
    t: 'kv', key: 'flue:wake',
    value: { $object: { at: { $date: '2027-01-15T08:00:00.000Z' }, seen: { $set: ['a'] }, $tag: 'T_A' } },
  });
});

test('no export carries a retired setting, such as the Outbound access policy', async () => {
  const deployment = hostedDeployment(['inst_export_retired']);
  const a = deployment.installation('inst_export_retired');
  populate(deployment, a, 'T_A');
  assert.ok(RETIRED_SETTING_KEYS.has('egress.policy'));
  a.stores.settings.setSetting('egress.policy', JSON.stringify({ mode: 'open', domains: ['api.example.com'] }));
  for (const mode of ['portable', 'full'] as const) {
    const text = (await exportAll(a.env, installationStateStoreObject(a.env), mode)).text;
    const keys = text.trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) => record.t === 'row' && record.table === 'app_settings').map((record) => record.row.key);
    assert.ok(keys.includes('slack.teamName'), `${mode}: the installation's settings are kept`);
    assert.equal(keys.includes('egress.policy'), false, `${mode}: the retired policy is left out`);
    assert.equal(text.includes('api.example.com'), false, mode);
  }
});

test('a portable export nulls every envelope a setting keeps inside its JSON value, and keeps the rest', async () => {
  const deployment = hostedDeployment(['inst_export_envelopes']);
  const a = deployment.installation('inst_export_envelopes');
  populate(deployment, a, 'T_A');
  const settings = promisify(a.stores.settings, { close: () => undefined });
  const keyring = generateCredentialKeyring('export_test');
  // Each written by the code that writes it in production.
  const identity = await loadOrCreateGatewayDeploymentIdentity({ settings, keyring });
  const binding = {
    bindingId: 'binding_export', workspaceId: 'T_A', appId: 'A_EXPORT', deploymentId: identity.deploymentId,
    clientId: 'client', botUserId: 'U_BOT', installerSlackUserId: 'U_OWNER', sessionUrl: 'wss://gateway.test/session',
    installedAt: 1,
  };
  const endpointUrl = 'https://worker.account.workers.dev/slack/gateway/delivery';
  const seal = (keyId: string, routeRevision: number) => sealDeliveryKey(binding, keyring, {
    operationId: `op_${keyId}`, endpointUrl, routeRevision, keyId, secret: Buffer.alloc(32, routeRevision).toString('base64url'),
  });
  const delivery: HttpDeliveryState = {
    version: 1, bindingId: binding.bindingId, deploymentId: binding.deploymentId, installedAt: binding.installedAt,
    mode: 'http', revision: 1, active: await seal('key_1', 1), pending: await seal('key_2', 2),
  };
  await settings.setSetting(GATEWAY_HTTP_SETTING, JSON.stringify(delivery));
  await createWebsiteLogin({ store: settings, keyring }, {
    host: 'app.example.com', label: 'Billing', ownerKind: 'team', createdByMembershipId: 'membership_admin',
    method: 'credentials', username: 'ops@example.com', password: 'website-password-T_A',
  });
  await saveStoredComposioProjectKey(`ak_${'c'.repeat(32)}`, { settings, credentials: { store: settings, keyring } });
  // A Flue instance's key-value entry holding the same shape.
  const agent = inventory(a).find((object) => object.kind === 'slack_agent')!;
  await deployment.object(SLACK_AGENT, agent.name).storage.put('chickpea:delivery', { key: delivery.active });

  const envelopes = [
    JSON.parse((await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING))!).privateKeyEnvelope,
    delivery.active!.secretEnvelope, delivery.pending!.secretEnvelope,
    ...a.db.all('SELECT nonce, ciphertext FROM app_encrypted_credential_revisions'),
  ] as Array<{ nonce: string; ciphertext: string }>;
  assert.equal(envelopes.length, 6, 'a model key, a website login and the Composio key are encrypted revisions');
  const store = installationStateStoreObject(a.env);
  const full = (await exportAll(a.env, store, 'full')).text + (await exportAll(a.env, agent, 'full')).text;
  const portable = (await exportAll(a.env, store, 'portable')).text + (await exportAll(a.env, agent, 'portable')).text;
  for (const { nonce, ciphertext } of envelopes) {
    assert.ok(full.includes(ciphertext) && full.includes(nonce), 'a full export keeps every envelope');
    assert.equal(portable.includes(ciphertext), false, 'a portable export keeps no ciphertext');
    assert.equal(portable.includes(nonce), false, 'a portable export keeps no nonce');
  }

  // Only the envelopes go: the records around them stay readable.
  const records = portable.trim().split('\n').map((line) => JSON.parse(line));
  const settingText = (key: string): string => records
    .find((record) => record.t === 'row' && record.table === 'app_settings' && record.row.key === key).row.value;
  const setting = (key: string) => JSON.parse(settingText(key));
  assert.deepEqual(setting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING), {
    version: 1, deploymentId: identity.deploymentId, publicKey: identity.publicKey, privateKeyEnvelope: null,
    createdAt: JSON.parse((await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING))!).createdAt,
  });
  const { secretEnvelope: _active, ...activeKey } = delivery.active!;
  const { secretEnvelope: _pending, ...pendingKey } = delivery.pending!;
  assert.deepEqual(setting(GATEWAY_HTTP_SETTING), {
    ...delivery, active: { ...activeKey, secretEnvelope: null }, pending: { ...pendingKey, secretEnvelope: null },
  });
  const entry = records.find((record) => record.t === 'kv' && record.key === 'chickpea:delivery');
  assert.deepEqual(entry?.value, { key: { ...activeKey, secretEnvelope: null } });
  // A value with no envelope is exported byte for byte.
  assert.equal(settingText('slack.teamName'), 'Team T_A');
  assert.equal(settingText('managed.composio.configuration'), await settings.getSetting('managed.composio.configuration'));
});

test('a portable export cuts Chickpea\'s setup capabilities from links and the text that carries them; full keeps them', async () => {
  // Hosted run 4: a new Agent's welcome posted a connector setup link whose
  // `#setup=` capability stays live for 24 hours, kept in the receipt outbox
  // and in two stored copies of the posted Slack text.
  const deployment = hostedDeployment(['inst_export_setup']);
  const a = deployment.installation('inst_export_setup');
  populate(deployment, a, 'T_A');
  const base = 'https://chickpea.example.com';
  const [connector, admin] = [await mintSetupCapability(), await mintSetupCapability()];
  const setupUrl = `${base}/setup/setup_welcome_${'a'.repeat(32)}#setup=${connector.capability}`;
  const adminUrl = setupCapabilityUrl(base, admin.capability);
  const posted = `Hi! I'm Tips.\n${renderSlackActionLink(setupUrl, 'Connect Monday.com')}`;
  // Someone else's link that happens to use the same fragment is the customer's content.
  const theirs = `https://docs.example.org/guide#setup=${'b'.repeat(43)}`;
  a.db.run(
    `INSERT INTO management_receipt_outbox (outbox_id, operation_id, destination_json, receipt_json, status,
       next_attempt_at, created_at, updated_at) VALUES ('outbox_1', 'op_1', '{}', ?, 'delivered', 0, 1, 1)`,
    JSON.stringify({
      kind: 'agent_welcome', text: 'Welcome',
      // A link field loses its whole fragment, whatever its capability's shape.
      connectorActions: [{ label: 'Monday.com', setupUrl }, { label: 'Notion', setupUrl: `${base}/setup/op_2#setup=v2.legacy` }],
    }),
  );
  a.db.run(
    `INSERT INTO config_slack_public_context (workspace_id, channel_id, root_ts, message_ts, role, text, updated_at)
     VALUES ('T_A', 'D_A', '1.1', '1.2', 'agent', ?, 1)`,
    `${posted}\nSee <${theirs}|their guide>.`,
  );
  a.stores.settings.setSetting('slack.lastSetupLink', `Open ${adminUrl} to finish.`);
  const agent = inventory(a).find((object) => object.kind === 'slack_agent')!;
  const transcript = deployment.object(SLACK_AGENT, agent.name).storage;
  transcript.sql.exec('INSERT INTO flue_transcript (body) VALUES (?)', JSON.stringify({
    role: 'tool', content: [{ type: 'text', text: JSON.stringify({ handoffUrl: setupUrl, expiresAt: 1 }) }],
  }));
  await transcript.put('chickpea:last-reply', posted);

  const store = installationStateStoreObject(a.env);
  const full = (await exportAll(a.env, store, 'full')).text + (await exportAll(a.env, agent, 'full')).text;
  const portable = (await exportAll(a.env, store, 'portable')).text + (await exportAll(a.env, agent, 'portable')).text;
  for (const { capability } of [connector, admin]) {
    assert.ok(full.includes(capability), 'a full export keeps every setup capability');
    assert.equal(portable.includes(capability), false, 'a portable export keeps no setup capability');
  }
  assert.equal(portable.includes('v2.legacy'), false);
  // The links stay, without their capability.
  const records = portable.trim().split('\n').map((line) => JSON.parse(line));
  const row = (table: string) => records.find((record) => record.t === 'row' && record.table === table).row;
  const bare = `${base}/setup/setup_welcome_${'a'.repeat(32)}`;
  assert.deepEqual(JSON.parse(row('management_receipt_outbox').receipt_json).connectorActions, [
    { label: 'Monday.com', setupUrl: bare }, { label: 'Notion', setupUrl: `${base}/setup/op_2` },
  ]);
  assert.equal(row('config_slack_public_context').text, `Hi! I'm Tips.\n<${bare}|Connect Monday.com>\nSee <${theirs}|their guide>.`);
  assert.equal(records.find((record) => record.t === 'row' && record.table === 'app_settings' &&
    record.row.key === 'slack.lastSetupLink').row.value, `Open ${base}/admin/setup to finish.`);
  const message = records.find((record) => record.t === 'row' && record.table === 'flue_transcript' &&
    record.row.body.startsWith('{')).row.body;
  const tool = JSON.parse(JSON.parse(message).content[0].text);
  assert.deepEqual(tool, { handoffUrl: bare, expiresAt: 1 });
  assert.equal(records.find((record) => record.t === 'kv' && record.key === 'chickpea:last-reply').value,
    `Hi! I'm Tips.\n<${bare}|Connect Monday.com>`);
});

test('host functions refuse on a standalone deployment', async () => {
  const storage = { sql: { exec: () => ({ toArray: () => [] }) } } as never;
  const standalone = objectHostFunctions({ env: objectInstallationEnv({ id: { name: 'singleton' } }, {}), storage });
  await assert.rejects(standalone.chickpeaHostExportPage({ installationId: 'installation_oss', mode: 'full' }),
    InstallationContextError);
  await assert.rejects(standalone.chickpeaHostErase({ installationId: 'installation_oss' }), InstallationContextError);
  await assert.rejects(exportInstallationObject({}, { kind: 'state_store', name: 'singleton' }, { mode: 'full' }),
    InstallationContextError);
  assert.throws(() => installationStateStoreObject({}), InstallationContextError);
});
