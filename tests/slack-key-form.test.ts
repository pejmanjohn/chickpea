import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { connectionAccountSecretSettingKey } from '../src/config/connector-secrets.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import type { SetupWakeRequest } from '../src/management/receipts.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import type { ManagementApplyResult } from '../src/management/types.ts';
import { deliverHostKeyCard, keyFormReceiptNow, saveKeyFromForm, type KeyFormContext } from '../src/slack/key-form.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { isKeyCard, KEY_FIELD_ACTION_ID, keyFieldBlockId } from '../src/slack/ui/key-card.ts';
import type { UiSurfaceRecord } from '../src/slack/ui/surface.ts';
import { buildTagStateStores } from '../src/state/tag-state-stores.ts';
import { DoSqlStateDb } from '../src/state/do-state-db.ts';
import { promiseBackedStatePort } from '../src/config/local-state-port.ts';
import { withConnectionNetwork } from './helpers/connection-network.ts';
import { withDirectSlackInstall, type DirectSlackInstall } from './helpers/direct-slack-install.ts';
import { FakeObjectStorage } from './helpers/installation-objects.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const KEY = ['sk', 'keyform', '7f3a9c2e5b1d4f60'].join('-');
const MESSAGE_TS = '1800000000.000100';
const CARD_TS = '1800000000.000300';

type Stores = DirectSlackInstall['stores'];

function principalOf(owner: IdentityResolution): AuthPrincipal {
  return {
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    role: owner.membership.role,
    authenticatorKind: 'better_auth',
    credentialId: `session_${owner.membership.id}`,
    correlationId: 'key_form_test',
    machine: false,
  };
}

async function keyedAgent(
  stores: Pick<Stores, 'identity' | 'config' | 'settings' | 'management'>,
  host: string,
) {
  const owner = (await stores.identity.resolveSlackIdentity('T1', 'U1'))!;
  const agent = await stores.config.createAgent({
    id: 'agent_ops',
    name: 'Ops',
    creatorMembershipId: owner.membership.id,
    editPolicy: 'creator_and_admins',
    instructions: 'Run ops.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await new ConnectionAccountService({ config: stores.config, settings: stores.settings }).createForAgent({
    principal: principalOf(owner),
    agentId: agent.id,
    workspaceId: 'T1',
    ownerKind: 'team',
    providerId: 'tasks',
    label: 'Tasks',
    policy: {
      kind: 'api', allowedHosts: [host], pathPrefixes: ['/v1'], headerName: 'Authorization',
      headerValuePrefix: 'Bearer ', allowedMethods: ['GET'], authMode: 'credential',
    },
    pendingSetup: true,
    allowedCapabilities: [],
  });
  const service = new WorkspaceManagementService({
    identity: stores.identity, config: stores.config, management: stores.management, setupBaseUrl: 'https://chickpea.example',
  });
  const requestSetup = async (
    channelId: string,
    conversationKind: 'im' | 'mpim',
    messageTs = MESSAGE_TS,
    path?: string,
  ) => {
    const result = await service.applyWorkspaceChanges({
      context: {
        userId: owner.user.id,
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        actingAgentId: agent.id,
        origin: {
          kind: 'slack', workspaceId: 'T1', channelId, threadTs: MESSAGE_TS, messageTs, conversationKind,
          agentId: agent.id, requestText: 'connect Tasks',
        },
      },
      idempotencyKey: `key-form-${channelId}-${messageTs}`,
      operations: [{
        itemId: 'setup',
        kind: 'request_setup',
        target: { kind: 'api_connection', agentId: agent.id, connectionId: 'tasks', ...(path ? { path } : {}) },
      }],
    }) as ManagementApplyResult;
    const [outcome] = result.outcomes;
    assert.equal(outcome?.disposition, 'setup_required', JSON.stringify(result));
    return outcome!;
  };
  return { owner, agent, requestSetup };
}

async function postCard(
  stores: Pick<Stores, 'slackState' | 'management' | 'config'>,
  fixture: Awaited<ReturnType<typeof keyedAgent>>,
): Promise<UiSurfaceRecord> {
  const posted: Array<{ text: string; blocks: unknown[] }> = [];
  await deliverHostKeyCard({
    turn: {
      workspaceId: 'T1', channelId: 'D1', threadTs: MESSAGE_TS, messageTs: MESSAGE_TS, userId: 'U1',
      actorMembershipId: fixture.owner.membership.id, source: 'dm_message', channelType: 'im',
      eventId: 'Ev1', text: 'connect Tasks', contextMode: 'thread',
    } as NormalizedSlackTurn,
    assignment: { agent: fixture.agent, runtimeContract: 'chickpea-v1' } as unknown as ResolvedAssignment,
    turnJobId: `msg:D1:${MESSAGE_TS}`,
    state: stores.slackState,
    management: stores.management,
    config: stores.config,
    messenger: { post: async (rendered) => { posted.push(rendered); return CARD_TS; } },
  });
  assert.equal(posted.length, 1, 'one card for the turn');
  const card = await surface(stores, JSON.stringify(posted[0]).match(/"value":"([a-f0-9]{32}):0"/)![1]!);
  assert.ok(isKeyCard(card));
  assert.equal(card.messageTs, CARD_TS);
  return card;
}

async function surface(stores: Pick<Stores, 'slackState'>, id: string): Promise<UiSurfaceRecord | undefined> {
  const response = await stores.slackState.executeUiSurface!({ kind: 'get_surface', id });
  return response.kind === 'surface' ? response.surface ?? undefined : undefined;
}

function click(card: UiSurfaceRecord, userId = 'U1') {
  return {
    type: 'block_actions', api_app_id: 'A1', trigger_id: 'trigger.1', team: { id: 'T1' }, user: { id: userId },
    container: { type: 'message', channel_id: 'D1', message_ts: CARD_TS, is_ephemeral: false },
    channel: { id: 'D1' }, message: { ts: CARD_TS, thread_ts: MESSAGE_TS },
    actions: [{
      action_id: 'chickpea.host.v1.key_add.0', block_id: `chickpea.host.v1.${card.id}.1`,
      type: 'button', value: `${card.id}:0`, action_ts: '1800000001.000100',
    }],
    state: { values: {} },
  };
}

function submission(card: UiSurfaceRecord, privateMetadata: string, value: string, userId = 'U1') {
  return {
    type: 'view_submission', api_app_id: 'A1', team: { id: 'T1' }, user: { id: userId },
    view: {
      id: 'V1', callback_id: 'chickpea.ui.v1.key', private_metadata: privateMetadata,
      state: { values: { [keyFieldBlockId(card.id)]: { [KEY_FIELD_ACTION_ID]: { type: 'plain_text_input', value } } } },
    },
  };
}

function dump(store: unknown): string {
  const db = (store as { db: { all(sql: string): Array<Record<string, unknown>> } }).db;
  return db.all("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map(({ name }) => JSON.stringify(db.all(`SELECT * FROM "${String(name)}"`)))
    .join('\n');
}

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting until ${what}`);
}

async function capturingLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: unknown[][] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const previous = methods.map((method) => console[method]);
  for (const method of methods) console[method] = (...args: unknown[]) => { lines.push(args); };
  try {
    return { result: await run(), logs: JSON.stringify(lines) };
  } finally {
    methods.forEach((method, index) => { console[method] = previous[index]!; });
  }
}

test('in a Channel or DM request_setup asks for the key with the Add key form, and a group DM keeps its link', async () => {
  await withDirectSlackInstall({}, async ({ stores }) => {
    const fixture = await keyedAgent(stores, 'api.tasks.invalid');
    const dm = await fixture.requestSetup('D1', 'im');
    assert.equal(dm.setupUrl, undefined, 'no link reaches the model');
    assert.match(dm.instruction ?? '', /^Chickpea posts an Add key button under your reply, where the person adds the key in a private Slack form\. Point them to that button; do not post a setup link/);
    assert.match(dm.instruction ?? '', /call revoke_setup_link with this setupOperationId and reissue true/);
    const record = await stores.management.getSetup(dm.setupOperationId!);
    assert.deepEqual([record?.action, record?.status, record?.target.form], ['api_credential', 'pending', 'slack']);

    const group = await fixture.requestSetup('G1', 'mpim', '1800000000.000500');
    assert.match(group.setupUrl ?? '', /^https:\/\/chickpea\.example\/setup\/setup_/);
    assert.equal((await stores.management.getSetup(group.setupOperationId!))?.target.form, undefined);
  });
});

test('the requester adds a key with the form, and Slack, the card, the wake, logs and stores never hold it', async () => {
  await withDirectSlackInstall({}, async (install) => {
    const { stores } = install;
    const fixture = await keyedAgent(stores, 'api.tasks.invalid');
    const { setupOperationId } = await fixture.requestSetup('D1', 'im');
    const card = await postCard(stores, fixture);

    const { logs } = await capturingLogs(async () => {
      await install.deliver('interactions', click(card, 'U2'));
      await eventually(async () => install.calls.some(({ method }) => method === 'chat.postEphemeral'), 'the refusal is sent');
      const notice = install.calls.find(({ method }) => method === 'chat.postEphemeral')!.body;
      assert.deepEqual([notice.get('user'), notice.get('text')], ['U2', 'Only <@U1> can add this key.']);
      assert.equal(install.calls.some(({ method }) => method === 'views.open'), false, 'no form opens for anyone else');

      await install.deliver('interactions', click(card));
      const opened = install.calls.find(({ method }) => method === 'views.open');
      assert.ok(opened, 'the requester\'s click opens the form inside the request');
      const view = JSON.parse(opened.body.get('view')!) as { callback_id: string; private_metadata: string };
      assert.equal(view.callback_id, 'chickpea.ui.v1.key');

      const spaced = await install.deliver('interactions', submission(card, view.private_metadata, `${KEY} extra`));
      assert.deepEqual(await spaced.json(), {
        response_action: 'errors',
        errors: { [keyFieldBlockId(card.id)]: 'Paste only the key. It can\'t contain spaces or line breaks.' },
      });
      const stranger = await install.deliver('interactions', submission(card, view.private_metadata, KEY, 'U2'));
      assert.deepEqual(await stranger.json(), {
        response_action: 'errors', errors: { [keyFieldBlockId(card.id)]: 'Only <@U1> can add this key.' },
      });

      const accepted = await install.deliver('interactions', submission(card, view.private_metadata, `Bearer ${KEY}\n`));
      assert.deepEqual([accepted.status, await accepted.text()], [200, ''], 'a clean key closes the form');
      await eventually(async () => {
        const settled = await surface(stores, card.id);
        return settled?.status === 'resolved';
      }, 'the card settles');
    });

    assert.equal((await stores.management.getSetup(setupOperationId!))?.status, 'completed');
    const account = (await stores.config.listConnectionAccounts('T1')).find(({ label }) => label === 'Tasks')!;
    assert.equal(await stores.settings.getSetting(connectionAccountSecretSettingKey(account.secretRefId)), KEY,
      'the connection holds the key without the Bearer the person pasted');
    const settled = await surface(stores, card.id);
    assert.ok(isKeyCard(settled));
    assert.deepEqual(settled.spec.rows.map(({ state }) => state), [{ is: 'added' }]);
    const redraws = install.calls.filter(({ method }) => method === 'chat.update').map(({ body }) => body.get('blocks') ?? '');
    assert.match(redraws.at(0)!, /Checking the key with api\.tasks\.invalid…/);
    assert.match(redraws.at(-1)!, /:white_check_mark: <@U1> added the \*Tasks\* key\."/);
    assert.equal(install.calls.filter(({ method }) => method === 'chat.update').at(-1)!.body.get('text'),
      '<@U1> added the Tasks key.', 'the message text follows the card');

    const outbox = await stores.management.getOutboxForOperation(setupOperationId!);
    const wake = outbox?.destination.kind === 'thread' ? outbox.destination.wake : undefined;
    assert.match(wake?.note ?? '', /saved the key for Tasks with Chickpea's Add key form in Slack\. Chickpea checked it with one request, and the service accepted it\./);

    for (const [where, text] of [
      ['Slack calls', JSON.stringify(install.calls.map(({ method, body }) => [method, body.toString()]))],
      ['logs and telemetry', logs],
      ['the Slack state store: turn jobs, Work runs, the card and its resolution', dump(stores.slackState)],
      ['the management store: the setup, its receipt and the wake note', dump(stores.management)],
    ] as const) {
      assert.ok(!text.includes(KEY), `${where} never hold the key`);
    }
    assert.match(logs, /slack_key_form/);
  });
});

test('a key the service rejects saves nothing, offers Try again and wakes the Agent with the finding only', async () => {
  await withDirectSlackInstall({}, async ({ stores }) => {
    const fixture = await keyedAgent(stores, 'api.tasks.example');
    const { setupOperationId } = await fixture.requestSetup('D1', 'im');
    const card = await postCard(stores, fixture);
    const record = (await stores.management.getSetup(setupOperationId!))!;
    const updates: string[] = [];
    const notices: string[] = [];
    const woken: SetupWakeRequest[] = [];
    const context: KeyFormContext = {
      stores,
      platformEnv: undefined,
      slack: {
        update: async (_channel, _ts, rendered) => { updates.push(JSON.stringify(rendered.blocks)); },
        notice: async ({ text }) => { notices.push(text); },
      },
      wake: async (request) => { woken.push(request); },
      checkOptions: { cloudflare: true },
    };
    const metadata = `${card.id}|${setupOperationId}|${record.target.credentialBinding}`;
    const form = submission(card, metadata, KEY).view;
    const submitted = {
      workspaceId: 'T1', userId: 'U1', viewId: 'V1', callbackId: form.callback_id, privateMetadata: metadata,
      state: form.state.values, triggerId: null,
    };

    await withConnectionNetwork(() => Response.json({ message: 'invalid token' }, { status: 401 }), async (requests) => {
      await saveKeyFromForm(context, submitted);
      assert.deepEqual(requests.map(({ url, headers }) => [url, headers.get('authorization')]),
        [['https://api.tasks.example/v1', `Bearer ${KEY}`]], 'only the service sees the key');
    });
    const rejected = await surface(stores, card.id);
    assert.ok(isKeyCard(rejected));
    assert.deepEqual(rejected.spec.rows[0]!.state, { is: 'rejected' });
    assert.match(updates.at(-1)!, /:x: api\.tasks\.example rejected that key, so it wasn't saved\..*"Try again"/);
    assert.equal((await stores.management.getSetup(setupOperationId!))?.status, 'pending', 'Try again uses the same setup');
    const account = (await stores.config.listConnectionAccounts('T1')).find(({ label }) => label === 'Tasks')!;
    assert.equal(await stores.settings.getSetting(connectionAccountSecretSettingKey(account.secretRefId)), undefined);

    assert.equal(woken.length, 1);
    assert.deepEqual([woken[0]!.channelId, woken[0]!.threadTs, woken[0]!.wake.agentId, woken[0]!.wake.slackUserId],
      ['D1', MESSAGE_TS, fixture.agent.id, 'U1']);
    assert.match(woken[0]!.wake.note, /gave a key for Tasks with Chickpea's Add key form in Slack, and api\.tasks\.example rejected it/);
    assert.equal(woken[0]!.setupOperationId, `${setupOperationId}.rejected`, 'the saved key\'s own wake stays distinct');
    assert.ok(!JSON.stringify({ woken, updates, notices }).includes(KEY), 'the wake, the card and the notices never hold the key');
    const outbox = { outboxId: 'receipt_other', operationId: setupOperationId!, destination: { kind: 'thread' as const, workspaceId: 'T1', channelId: 'D1', threadTs: MESSAGE_TS }, receipt: { setupOperationId: setupOperationId!, connector: 'Tasks', target: 'Ops', scopes: [], initiator: 'U2', completedAt: Date.now() }, status: 'pending' as const, attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
    await assert.rejects(() => stores.management.completeSetup({
      setupOperationId: setupOperationId!, slackForm: { userId: 'user_other', membershipId: 'membership_other' },
      receipt: outbox.receipt, outbox, at: Date.now(),
    }), (error: unknown) => (error as { code?: string }).code === 'setup_unavailable',
    'only the setup\'s own requester finishes it from Slack');

    const redraws = updates.length;
    await withConnectionNetwork(() => Response.json({ message: 'invalid token' }, { status: 401 }), async () => {
      await saveKeyFromForm(context, submitted);
    });
    assert.equal(updates.length, redraws + 2, 'the card shows the second check and its result');
    assert.match(updates.at(-1)!, /:x: api\.tasks\.example rejected that key/);
    assert.deepEqual(woken.map(({ setupOperationId: id }) => id), [`${setupOperationId}.rejected`, `${setupOperationId}.rejected`],
      'every rejection of one setup asks for the same wake, which the thread admits once');

    await withConnectionNetwork(() => Response.json({ tasks: [] }), async () => {
      await saveKeyFromForm(context, submitted);
    });
    const added = await surface(stores, card.id);
    assert.ok(isKeyCard(added));
    assert.deepEqual(added.spec.rows[0]!.state, { is: 'added' }, 'Try again checks the row again and saves');
    assert.equal((await stores.management.getSetup(setupOperationId!))?.status, 'completed');
    assert.match(updates.at(-1)!, /:white_check_mark: <@U1> added the \*Tasks\* key\./);
  });
});

function formContext(stores: Stores) {
  const updates: Array<{ text: string; blocks: string }> = [];
  const notices: string[] = [];
  const woken: SetupWakeRequest[] = [];
  const context: KeyFormContext = {
    stores,
    platformEnv: undefined,
    slack: {
      update: async (_channel, _ts, rendered) => { updates.push({ text: rendered.text, blocks: JSON.stringify(rendered.blocks) }); },
      notice: async ({ text }) => { notices.push(text); },
    },
    wake: async (request) => { woken.push(request); },
    checkOptions: { cloudflare: true },
  };
  return { context, updates, notices, woken };
}

async function formSubmission(stores: Stores, card: UiSurfaceRecord, setupOperationId: string, key = KEY) {
  const record = (await stores.management.getSetup(setupOperationId))!;
  const metadata = `${card.id}|${setupOperationId}|${record.target.credentialBinding}`;
  const form = submission(card, metadata, key).view;
  return {
    workspaceId: 'T1', userId: 'U1', viewId: 'V1', callbackId: form.callback_id, privateMetadata: metadata,
    state: form.state.values, triggerId: null,
  };
}

test('a setup that names no read path saves a form key only on a 2xx, and asks the Agent for one that does', async () => {
  await withDirectSlackInstall({}, async ({ stores }) => {
    const fixture = await keyedAgent(stores, 'api.tasks.example');
    const { setupOperationId } = await fixture.requestSetup('D1', 'im');
    const card = await postCard(stores, fixture);
    const { context, updates, woken } = formContext(stores);
    const submitted = await formSubmission(stores, card, setupOperationId!);

    await withConnectionNetwork(() => Response.json({ message: 'no route' }, { status: 404 }), async (requests) => {
      await saveKeyFromForm(context, submitted);
      assert.deepEqual(requests.map(({ url }) => url), ['https://api.tasks.example/v1'], 'the check ran at the bare prefix');
    });
    const account = (await stores.config.listConnectionAccounts('T1')).find(({ label }) => label === 'Tasks')!;
    assert.equal(await stores.settings.getSetting(connectionAccountSecretSettingKey(account.secretRefId)), undefined,
      'a 404 at the bare prefix saves nothing');
    assert.equal(account.lifecycle, 'pending');
    const unconfirmed = await surface(stores, card.id);
    assert.ok(isKeyCard(unconfirmed));
    assert.deepEqual(unconfirmed.spec.rows[0]!.state, { is: 'unconfirmed' });
    assert.equal(unconfirmed.status, 'resolved', 'the row is final, so the card settles');
    assert.match(updates.at(-1)!.blocks, /api\.tasks\.example didn't confirm that key, so it wasn't saved\./);
    assert.doesNotMatch(updates.at(-1)!.blocks, /"button"/, 'no Add key or Try again');
    assert.equal(updates.at(-1)!.text, 'api.tasks.example didn\'t confirm that key, so it wasn\'t saved.');

    assert.deepEqual(woken.map(({ setupOperationId: id }) => id), [`${setupOperationId}.unconfirmed`]);
    assert.match(woken[0]!.wake.note, /api\.tasks\.example, which answered 404/);
    assert.match(woken[0]!.wake.note, /Call request_setup for Tasks again with path set to a read endpoint/);
    assert.equal(woken[0]!.notice, 'api.tasks.example didn\'t confirm the key for Tasks, so it wasn\'t saved.');
    assert.ok(!JSON.stringify({ woken, updates }).includes(KEY), 'the wake and the card never hold the key');

    await withConnectionNetwork(() => Response.json({ tasks: [] }), async (requests) => {
      await saveKeyFromForm(context, submitted);
      assert.deepEqual(requests, [], 'a form still open on the settled row checks nothing');
    });
    assert.equal(woken.length, 1, 'one wake');
  });
});

test('a setup with the Agent\'s read path keeps the setup page\'s rule and saves a key that path answers 404 for', async () => {
  await withDirectSlackInstall({}, async ({ stores }) => {
    const fixture = await keyedAgent(stores, 'api.tasks.example');
    const { setupOperationId } = await fixture.requestSetup('D1', 'im', MESSAGE_TS, '/v1/tasks');
    const card = await postCard(stores, fixture);
    const { context, woken } = formContext(stores);

    await withConnectionNetwork(() => Response.json({ message: 'no route' }, { status: 404 }), async (requests) => {
      await saveKeyFromForm(context, await formSubmission(stores, card, setupOperationId!));
      assert.deepEqual(requests.map(({ url }) => url), ['https://api.tasks.example/v1/tasks']);
    });
    const added = await surface(stores, card.id);
    assert.ok(isKeyCard(added));
    assert.deepEqual(added.spec.rows[0]!.state, { is: 'added_warning', check: 'path_not_found' });
    assert.equal((await stores.management.getSetup(setupOperationId!))?.status, 'completed');
    assert.deepEqual(woken, [], 'a saved key wakes the Agent through its setup receipt');
  });
});

test('names the model chose reach Slack escaped in the form\'s private notice and the wake\'s notice', async () => {
  await withDirectSlackInstall({}, async ({ stores }) => {
    const fixture = await keyedAgent(stores, 'api.tasks.example');
    const { setupOperationId } = await fixture.requestSetup('D1', 'im');
    const posted = await postCard(stores, fixture);
    assert.ok(isKeyCard(posted));
    const spec = {
      ...posted.spec,
      agentName: 'Ops <!channel>',
      rows: posted.spec.rows.map((row) => ({ ...row, label: 'Tasks <!here>' })),
    };
    await stores.slackState.executeUiSurface!({ kind: 'replace_surface_spec', id: posted.id, expected: posted.spec, spec });
    const record = (await stores.management.getSetup(setupOperationId!))!;
    const notices: string[] = [];
    const woken: SetupWakeRequest[] = [];
    const context = (settings = stores.settings): KeyFormContext => ({
      stores: { ...stores, settings },
      platformEnv: undefined,
      slack: { update: async () => {}, notice: async ({ text }) => { notices.push(text); } },
      wake: async (request) => { woken.push(request); },
      checkOptions: { cloudflare: true },
    });
    const metadata = `${posted.id}|${setupOperationId}|${record.target.credentialBinding}`;
    const form = submission(posted, metadata, KEY).view;
    const submitted = {
      workspaceId: 'T1', userId: 'U1', viewId: 'V1', callbackId: form.callback_id, privateMetadata: metadata,
      state: form.state.values, triggerId: null,
    };

    await withConnectionNetwork(() => Response.json({ message: 'invalid token' }, { status: 401 }), async () => {
      await saveKeyFromForm(context(), submitted);
    });
    assert.equal(woken[0]?.notice, 'api.tasks.example rejected the key for Tasks &lt;!here&gt;, so it wasn\'t saved.');

    const unsaved = new Proxy(stores.settings, {
      get(target, property) {
        if (property === 'setSetting') return async () => { throw new Error('settings unavailable'); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await withConnectionNetwork(() => Response.json({ tasks: [] }), async () => {
      await saveKeyFromForm(context(unsaved), submitted);
    });
    assert.equal(notices.at(-1), 'That key wasn\'t saved. Try again, or ask Ops &lt;!channel&gt; for help.');
  });
});

test('a form key still saves after an unrelated Agent edit', async () => {
  await withDirectSlackInstall({}, async ({ stores }) => {
    const fixture = await keyedAgent(stores, 'api.tasks.example');
    const { setupOperationId } = await fixture.requestSetup('D1', 'im');
    const card = await postCard(stores, fixture);
    const { context } = formContext(stores);
    const current = await stores.config.getAgent(fixture.agent.id);
    await stores.config.updateAgent(fixture.agent.id, { description: 'Runs ops.' }, current.revision);

    await withConnectionNetwork(() => Response.json({ tasks: [] }), async () => {
      await saveKeyFromForm(context, await formSubmission(stores, card, setupOperationId!));
    });
    const account = (await stores.config.listConnectionAccounts('T1')).find(({ label }) => label === 'Tasks')!;
    assert.equal(await stores.settings.getSetting(connectionAccountSecretSettingKey(account.secretRefId)), KEY);
    assert.equal(account.lifecycle, 'ready');
    const added = await surface(stores, card.id);
    assert.ok(isKeyCard(added));
    assert.deepEqual(added.spec.rows[0]!.state, { is: 'added' });
  });
});

test('a row whose connection changed refuses the click, settles as changed, and says so privately', async () => {
  await withDirectSlackInstall({}, async (install) => {
    const { stores } = install;
    const fixture = await keyedAgent(stores, 'api.tasks.invalid');
    await fixture.requestSetup('D1', 'im');
    const card = await postCard(stores, fixture);
    const account = (await stores.config.listConnectionAccounts('T1')).find(({ label }) => label === 'Tasks')!;
    await stores.config.putConnectionAccount({ ...account, label: 'Tasks (old)' }, account.revision);

    await install.deliver('interactions', click(card));
    await eventually(async () => install.calls.some(({ method }) => method === 'chat.postEphemeral'), 'the refusal is sent');
    assert.equal(install.calls.some(({ method }) => method === 'views.open'), false);
    assert.equal(install.calls.find(({ method }) => method === 'chat.postEphemeral')!.body.get('text'),
      'The connection changed after this was posted. Ask Ops for a new one.');
    const changed = await surface(stores, card.id);
    assert.ok(isKeyCard(changed));
    assert.deepEqual(changed.spec.rows[0]!.state, { is: 'superseded' });
  });
});

test('the gateway answers a click and a submission in the receipt from the state store\'s own tables', async () => {
  const db = new DoSqlStateDb(new FakeObjectStorage().asDurableObjectStorage());
  const tag = buildTagStateStores(db, {} as PlatformEnv, { gatewayLeaseOwner: 'key-form-test' });
  const stores = {
    identity: promiseBackedStatePort(tag.identity),
    config: promiseBackedStatePort(tag.config),
    settings: promiseBackedStatePort(tag.settings),
    management: promiseBackedStatePort(tag.management),
    slackState: {
      executeUiSurface: async (request: Parameters<typeof tag.uiSurfaces.execute>[0]) => tag.uiSurfaces.execute(request),
    },
  } as unknown as Stores;
  await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
  await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', teamId: 'T1',
  });
  const fixture = await keyedAgent(stores, 'api.tasks.invalid');
  const { setupOperationId } = await fixture.requestSetup('D1', 'im');
  const card = await postCard(stores, fixture);
  const binding = (await stores.management.getSetup(setupOperationId!))!.target.credentialBinding!;
  const gateway = { protocolVersion: 1, deliveryId: 'Dv1', bindingId: 'binding_1' } as const;
  const action = click(card).actions[0]!;
  const clicked = {
    ...gateway, kind: 'interaction.ui_action' as const, workspaceId: 'T1', userId: 'U1', containerType: 'message' as const,
    channelId: 'D1', messageTs: CARD_TS, threadTs: MESSAGE_TS, isEphemeral: false, viewId: null,
    actionId: action.action_id, blockId: action.block_id, actionType: 'button', value: action.value, selected: [],
    state: {}, actionTs: action.action_ts, triggerId: 'trigger.1',
  };

  const opened = keyFormReceiptNow(clicked, tag);
  assert.equal((opened?.interaction.openView as { callback_id?: string } | undefined)?.callback_id, 'chickpea.ui.v1.key');
  assert.equal(keyFormReceiptNow({ ...clicked, userId: 'U2' }, tag), undefined,
    'anyone else\'s click is admitted, where it is told why');

  const form = submission(card, `${card.id}|${setupOperationId}|${binding}`, '').view;
  const empty = {
    ...gateway, kind: 'interaction.view_submission' as const, workspaceId: 'T1', userId: 'U1', viewId: 'V1',
    callbackId: form.callback_id, privateMetadata: form.private_metadata, state: form.state.values, triggerId: null,
  };
  assert.deepEqual(keyFormReceiptNow(empty, tag)?.interaction.responseAction, {
    response_action: 'errors', errors: { [keyFieldBlockId(card.id)]: 'Paste the key.' },
  });
  const valid = {
    ...empty,
    state: { [keyFieldBlockId(card.id)]: { [KEY_FIELD_ACTION_ID]: { type: 'plain_text_input', value: KEY } } },
  };
  assert.equal(keyFormReceiptNow(valid, tag), undefined, 'a clean key is admitted to the inbox and checked there');

  const inbox = () => JSON.stringify(db.all('SELECT * FROM gateway_inbox'));
  assert.equal(tag.gatewayInbox.admit({ ...valid, deliveryId: 'Dv2' }), 'accepted');
  assert.equal(tag.gatewayInbox.admit({ ...clicked, userId: 'U2', deliveryId: 'Dv3' }), 'accepted');
  const claimed = tag.gatewayInbox.claimPending();
  assert.ok(JSON.stringify(claimed.find(({ id }) => id === 'Dv2')?.delivery).includes(KEY),
    'the drain that claimed the submission holds the key in memory to check it');
  assert.ok(!inbox().includes(KEY), 'once claimed, the inbox row no longer holds the key');
  assert.match(inbox(), /"id":"Dv3"[^}]*"payload_json":"\{/, 'a click keeps its payload for a retry');
  tag.gatewayInbox.retryOrRecover('Dv2', 'check_failed');
  assert.deepEqual(tag.gatewayInbox.claimPending().map(({ id }) => id), [], 'a retry has no key to check again');
  assert.deepEqual(db.get("SELECT status, recovery_reason FROM gateway_inbox WHERE id = 'Dv2'"),
    { status: 'recovery_required', recovery_reason: 'missing_payload' });
});
