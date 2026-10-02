import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  InstallationContextError,
  installationOwnershipOf,
  objectInstallationEnv,
} from '../src/config/installation-scope.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
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
  // An erased object exports nothing but its header.
  const after = await exportAll(a.env, objectsOfA[0]!, 'full');
  assert.deepEqual(after.text.trim().split('\n').map((line) => JSON.parse(line).t), ['object']);
  assert.deepEqual(await exportInstallation(b), neighbourBefore);
  assert.ok(b.stores.turnJobs.getFrozenRuntimePlan('tj_T_B_0'), 'the neighbour still serves its turns');
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
