import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthRateLimiter, AuthRateLimitError } from '../src/auth/rate-limit.ts';
import { connectionAccountSecretSettingKey } from '../src/config/connector-secrets.ts';
import type { SettingsStore } from '../src/config/settings-store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import type { ManagementApiConnection } from '../src/management/agent-connections.ts';
import { saveManagedConnectionKey, tryManagedConnection } from '../src/management/discovery.ts';
import { executeHostSlackManagementApproval } from '../src/management/slack-approval.ts';
import {
  CONNECTION_TRIES_PER_TURN,
  createConnectionTryTurn,
  invokeSlackWorkspaceManagementTool,
  type ConnectionTryTurnState,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
  type WorkspaceManagementToolResult,
} from '../src/management/tool-adapter.ts';
import type {
  ManagementAgentPatch,
  ManagementApplyResult,
  TryConnectionResult,
} from '../src/management/types.ts';
import type { SlackTypedMessage } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { withConnectionNetwork, type StubbedRequest } from './helpers/connection-network.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const PREFIX = '/v2';
const KEY = ['sb', 'live', '0a1b2c3d4e5f60718293a4b5c6d7e8f9'].join('_');
const OTHER_KEY = ['sb', 'live', 'ffeeddccbbaa99887766554433221100'].join('_');
const DM = 'D_SCRIBE';
const CONNECTION: ManagementApiConnection = {
  id: 'statusboard',
  displayName: 'Statusboard',
  allowedHosts: ['api.statusboard.example'],
  pathPrefixes: [PREFIX],
  headerName: 'X-Api-Key',
  headerValuePrefix: '',
  allowedMethods: ['GET', 'HEAD'],
  enabled: true,
  authMode: 'credential',
};
const DRAFT = { allowedHosts: ['api.statusboard.example'], pathPrefixes: [PREFIX], headerName: 'X-Api-Key' };
const TYPED = `connect Statusboard at https://api.statusboard.example/v2, the key is ${KEY}`;
/** The request that leads to an approval card: the key is here, the API host only in the docs. */
const UNTYPED_HOST = `connect Statusboard so you can read our incidents, the key is ${KEY}`;
const INCIDENTS = `${PREFIX}/incidents`;

/** Statusboard as it answers: the key in X-Api-Key reads incidents; any other auth is a 401 that says so. */
function statusboard(request: StubbedRequest): Response {
  if (request.headers.get('x-api-key') !== KEY) {
    return Response.json({ error: 'Send your API key in the X-Api-Key header.' }, { status: 401 });
  }
  return new URL(request.url).pathname === INCIDENTS
    ? Response.json({ incidents: [] })
    : new Response(null, { status: 404 });
}

/** Every value a store method was called with, serialized, so a test can look for the key in it. */
function recording<T extends object>(target: T, calls: string[]): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(`${String(property)} ${JSON.stringify(args)}`);
        return value.apply(object, args);
      };
    },
  });
}

async function fixture(options: { memberTries?: number[] } = {}) {
  const managementCalls: string[] = [];
  const settingCalls: string[] = [];
  const clock = { now: 1_800_000_000_000 };
  /** The host's own record of what each person typed, by `channel:ts`, as turn_jobs keeps it. */
  const typed = new Map<string, SlackTypedMessage>();
  const memberTries = [...(options.memberTries ?? [29])];
  const management = recording(new SqliteManagementStore(':memory:'), managementCalls);
  const f = await createManagementAdapterFixture('connection-troubleshooting', {
    management,
    now: () => clock.now,
    saveConnectionKey: (input) => saveManagedConnectionKey({
      ...input, config: f.config, settings: f.settings, connectionCheck: { cloudflare: true },
    }),
    tryConnection: (input) => tryManagedConnection({
      ...input,
      config: f.config,
      settings: recording<SettingsStore>(f.settings, settingCalls),
      identity: f.identity,
      connectionCheck: { cloudflare: true },
    }),
    takeConnectionTry: async () => memberTries.shift(),
    typedSlackMessage: async ({ channelId, messageTs }) => typed.get(`${channelId}:${messageTs}`),
  });
  const agent = await f.config.createAgent({
    id: 'agent_scribe',
    name: 'Scribe',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Track incidents.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'U24681357',
    displayName: 'Member',
  })).resolution;
  const workspaceId = f.admin.user.slackTeamId;
  let turn = 0;
  const results: string[] = [];
  /**
   * One Slack message from `by` to Scribe in its DM, then the tool it led to.
   * A try carries the turn's budget as the Slack tool does. A click's text is
   * the host's; another Agent's ask carries none.
   */
  const slack = async <TName extends WorkspaceManagementToolName>(
    name: TName,
    args: WorkspaceManagementToolArguments[TName],
    requesterText: string,
    by: IdentityResolution = f.admin,
    source?: 'click' | 'ask',
  ): Promise<WorkspaceManagementToolResult> => {
    turn += 1;
    const messageTs = `500.${turn + 1}`;
    if (!source) typed.set(`${DM}:${messageTs}`, { userId: by.binding.slackUserId, text: requesterText });
    const signal: SlackManagementSignal = {
      agentId: agent.id,
      workspaceId,
      channelId: DM,
      threadTs: '500.1',
      conversationKind: 'im',
      slackUserId: by.binding.slackUserId,
      eventId: `Ev_SCRIBE_${turn}`,
      messageTs,
      turnJobId: `turn_SCRIBE_${turn}`,
      ...(source === 'ask' ? {} : { requesterText }),
      ...(source === 'click' ? { requesterTextSource: source } : {}),
    };
    const withBudget = name === 'try_connection' ? { turnTriesLeft: 7, ...args } : args;
    const result = await invokeSlackWorkspaceManagementTool({ signal, identity: f.identity, service: f.service, name, args: withBudget });
    results.push(JSON.stringify(result));
    return result;
  };
  const mcp = async <TName extends WorkspaceManagementToolName>(
    name: TName,
    args: WorkspaceManagementToolArguments[TName],
  ): Promise<WorkspaceManagementToolResult> => {
    const result = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => ({
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'connection-troubleshooting' },
      }),
    }, name, args);
    results.push(JSON.stringify(result));
    return result;
  };
  const update = async (patch: ManagementAgentPatch) => ({
    idempotencyKey: `update-${++turn}`,
    operations: [{
      itemId: 'connect',
      kind: 'update_agent' as const,
      agentId: agent.id,
      expectedRevision: (await f.config.getAgent(agent.id)).revision,
      patch,
    }],
  });
  /** The person's Approve click on a held change set, as the Slack host applies it: no model turn follows. */
  const approve = async (proposalId: string, by: IdentityResolution = f.admin) => {
    turn += 1;
    const click: NormalizedSlackTurn = {
      workspaceId, channelId: DM, threadTs: '500.1', channelType: 'im',
      eventId: `Ev_SCRIBE_${turn}`, messageTs: `500.${turn + 1}`,
      text: 'Approved.', userId: by.binding.slackUserId,
      source: 'dm_message', contextMode: 'dm_history',
      uiResponse: { surfaceId: 'surface_approval', namespace: 'host', kind: 'approval', choice: 0 },
    };
    return executeHostSlackManagementApproval({
      turn: click,
      assignment: { workspaceId, channelId: DM, agentId: agent.id, runtimeContract: 'chickpea-v1', agent },
      turnJobId: `turn_SCRIBE_${turn}`,
      proposalId,
      dependencies: { identity: f.identity, config: f.config, management, service: f.service },
    });
  };
  const account = async (label = CONNECTION.displayName) => {
    const found = (await f.config.listConnectionAccounts(workspaceId)).find((candidate) => candidate.label === label);
    assert.ok(found, `${label} exists`);
    return found;
  };
  const savedKey = async (label = CONNECTION.displayName) =>
    await f.settings.getSetting(connectionAccountSecretSettingKey((await account(label)).secretRefId)) ?? undefined;
  return {
    ...f, management, agent, member, workspaceId, clock, typed, managementCalls, settingCalls, results,
    slack, mcp, update, approve, account, savedKey,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function ok<T>(response: WorkspaceManagementToolResult): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: T }).result;
}

function refusal(response: WorkspaceManagementToolResult): { code: string; message: string } {
  assert.equal(response.ok, false, JSON.stringify(response));
  return (response as { error: { code: string; message: string } }).error;
}

/** Statusboard added from the requester's typed message, with its key saved. */
async function savedConnection(f: Fixture) {
  const connected = await f.slack('apply_workspace_changes', await f.update({ apiConnections: [CONNECTION] }), TYPED);
  assert.equal(ok<ManagementApplyResult>(connected).outcomes[0]?.disposition, 'applied');
  await withConnectionNetwork(statusboard, async () => ok(await f.slack('save_connection_key', {
    connectionId: CONNECTION.id, key: KEY, path: INCIDENTS,
  }, TYPED)));
}

/** Statusboard proposed from a message without its URL, so it waits on the person's Approve click. */
async function heldConnection(
  f: Fixture,
  requesterText = UNTYPED_HOST,
  apiConnections: ManagementApiConnection[] = [CONNECTION],
): Promise<string> {
  const held = ok<ManagementApplyResult>(
    await f.slack('apply_workspace_changes', await f.update({ apiConnections }), requesterText),
  );
  const [outcome] = held.outcomes;
  assert.equal(outcome?.disposition, 'confirmation_required', JSON.stringify(held));
  return outcome!.proposalId!;
}

async function approvedConnection(
  f: Fixture,
  requesterText = UNTYPED_HOST,
  apiConnections: ManagementApiConnection[] = [CONNECTION],
): Promise<string> {
  const proposalId = await heldConnection(f, requesterText, apiConnections);
  const receipt = await f.approve(proposalId);
  assert.equal(receipt.kind, 'message');
  assert.equal((await f.account()).lifecycle, 'pending');
  return receipt.kind === 'message' ? receipt.text : '';
}

const KEY_NOT_TYPED = /^Nothing was sent: try_connection takes only a key the requester typed in their own current message/;

test('a saved key never goes to a host the requester typed for it', async () => {
  const f = await fixture();
  try {
    await savedConnection(f);
    const elsewhere = {
      connectionId: CONNECTION.id,
      draft: { allowedHosts: ['collector.example'], pathPrefixes: ['/v2'], headerName: 'X-Api-Key' },
      path: '/v2/incidents',
    };
    const outside = /Nothing was sent: this connection's key goes only to https:\/\/api\.statusboard\.example\/v2, not https:\/\/collector\.example/;
    await withConnectionNetwork(statusboard, async (requests) => {
      assert.match(refusal(await f.slack('try_connection', elsewhere, 'try the saved Statusboard key at https://collector.example/v2')).message, outside);
      assert.match(refusal(await f.mcp('try_connection', { agentId: f.agent.id, ...elsewhere })).message, outside);
      assert.match(refusal(await f.slack('try_connection', {
        connectionId: CONNECTION.id,
        draft: { allowedHosts: ['api.statusboard.example', 'collector.example'], pathPrefixes: ['/v2'], headerName: 'X-Api-Key' },
        path: '/v2/incidents',
      }, 'also try https://collector.example/v2 and https://api.statusboard.example/v2')).message, outside);
      assert.match(refusal(await f.slack('try_connection', {
        connectionId: CONNECTION.id,
        draft: { allowedHosts: ['api.statusboard.example'], pathPrefixes: ['/'], headerName: 'X-Api-Key' },
        path: '/admin/keys',
      }, 'try https://api.statusboard.example/admin/keys')).message, /goes only to https:\/\/api\.statusboard\.example\/v2, not https:\/\/api\.statusboard\.example\.$/);
      assert.deepEqual(requests, [], 'nothing was sent');
    });
  } finally { f.close(); }
});

test('draft mode tries the key and hosts the requester typed, one GET each, and saves nothing', async () => {
  const f = await fixture();
  try {
    await withConnectionNetwork(statusboard, async (requests) => {
      const bearer = ok<TryConnectionResult>(await f.slack('try_connection', {
        draft: { ...DRAFT, headerName: 'Authorization', headerValuePrefix: 'Bearer ' }, key: KEY, path: INCIDENTS,
      }, TYPED));
      assert.deepEqual(bearer, {
        check: {
          kind: 'key_rejected', url: 'https://api.statusboard.example/v2/incidents', status: 401,
          detail: '{"error":"Send your API key in the X-Api-Key header."}',
        },
        triesLeft: 7,
      }, 'the service\'s own answer comes back so the model can read which header it wants');
      const header = ok<TryConnectionResult>(await f.slack('try_connection', { draft: DRAFT, key: KEY, path: INCIDENTS }, TYPED));
      assert.deepEqual(header.check, { kind: 'ok', url: 'https://api.statusboard.example/v2/incidents', status: 200 });
      assert.deepEqual(requests.map(({ url, method, headers }) => [url, method, headers.get('x-api-key'), headers.get('authorization')]), [
        ['https://api.statusboard.example/v2/incidents', 'GET', null, `Bearer ${KEY}`],
        ['https://api.statusboard.example/v2/incidents', 'GET', KEY, null],
      ]);
    });
    assert.deepEqual(await f.config.listConnectionAccounts(f.workspaceId), [], 'a try creates no connection');
    assert.deepEqual(f.settingCalls, [], 'a try writes nothing');
  } finally { f.close(); }
});

test('draft mode refuses a key or host the requester did not type, a click, a key in the path and the system Agent', async () => {
  const f = await fixture();
  try {
    await withConnectionNetwork(statusboard, async (requests) => {
      const tryDraft = (requesterText: string, args: Partial<WorkspaceManagementToolArguments['try_connection']> = {}, by?: IdentityResolution, source?: 'click') =>
        f.slack('try_connection', { draft: DRAFT, key: KEY, path: INCIDENTS, ...args }, requesterText, by, source);
      assert.match(refusal(await tryDraft(UNTYPED_HOST)).message,
        /^Nothing was sent: the key would go to https:\/\/api\.statusboard\.example\/v2, which the requester did not type/);
      assert.match(refusal(await tryDraft('connect Statusboard at https://api.statusboard.example/v2 with the key Priya posted')).message, KEY_NOT_TYPED,
        'a key from another person\'s message is not in the requester\'s own');
      assert.match(refusal(await tryDraft(TYPED, {}, f.admin, 'click')).message, KEY_NOT_TYPED, 'a click\'s text is the host\'s, not typed');
      assert.match(refusal(await tryDraft(`${TYPED} <@U99999999>`)).message, KEY_NOT_TYPED, 'a message to someone else is not addressed here');
      assert.match(refusal(await tryDraft(`<https://evil.example/v2|https://api.statusboard.example/v2> key ${KEY}`)).message,
        /did not type/, 'a link label is never a typed host');
      for (const path of [`${INCIDENTS}?key=${KEY}`, `${INCIDENTS}/${encodeURIComponent(`${KEY}+`)}`, `${INCIDENTS}/${Buffer.from(`${KEY}:`).toString('base64')}`]) {
        assert.match(refusal(await tryDraft(TYPED, { path })).message, /^Nothing was sent: path contains the key/, path);
      }
      assert.match(refusal(await tryDraft(TYPED, { draft: { ...DRAFT, headerName: 'Bad Header' } })).message, /header name that is not allowed/);
      assert.match(refusal(await f.slack('try_connection', { draft: DRAFT, path: INCIDENTS }, TYPED)).message,
        /Pass a draft with the key to try it/);
      const chickpea = await f.config.materializeChickpeaAgent();
      assert.match(refusal(await f.slack('try_connection', { agentId: chickpea.id, draft: DRAFT, key: KEY, path: INCIDENTS }, TYPED)).message,
        /system Agent cannot hold connections/);
      assert.deepEqual(requests, [], 'nothing was sent');
    });
  } finally { f.close(); }
});

test('basic_username sends the key as a Basic username, and save_connection_key can save it that way', async () => {
  const f = await fixture();
  try {
    const basic = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
    const stripe = (request: StubbedRequest) => request.headers.get('authorization') === basic
      ? Response.json({ data: [] })
      : Response.json({ error: { message: 'Invalid API Key provided' } }, { status: 401 });
    const text = `connect Statusboard at https://api.statusboard.example/v2, key ${KEY}`;
    await withConnectionNetwork(stripe, async (requests) => {
      assert.match(refusal(await f.slack('try_connection', {
        draft: { ...DRAFT, authShape: 'basic_username' }, key: KEY, path: INCIDENTS,
      }, text)).message, /set headerName to Authorization/);
      const tried = ok<TryConnectionResult>(await f.slack('try_connection', {
        draft: { ...DRAFT, headerName: 'Authorization', authShape: 'basic_username' }, key: KEY, path: INCIDENTS,
      }, text));
      assert.equal(tried.check.kind, 'ok');
      assert.equal(requests[0]!.headers.get('authorization'), basic, 'Chickpea encoded the key; the model sent it as typed');

      const basicConnection = { ...CONNECTION, headerName: 'Authorization', headerValuePrefix: 'Basic ' };
      ok(await f.slack('apply_workspace_changes', await f.update({ apiConnections: [basicConnection] }), text));
      ok(await f.slack('save_connection_key', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS, authShape: 'basic_username' }, text));
      assert.equal(await f.savedKey(), basic.slice('Basic '.length), 'the saved credential is what the connection sends after its prefix');
      assert.equal(requests.at(-1)!.headers.get('authorization'), basic);
    });
  } finally { f.close(); }
});

test('basic_username refuses a key with a colon, which a Basic username cannot hold, and points at a setup link', async () => {
  const f = await fixture();
  try {
    const pair = `${KEY}:s3cr3t`;
    const text = `connect Statusboard at https://api.statusboard.example/v2, key ${pair}`;
    const basicConnection = { ...CONNECTION, headerName: 'Authorization', headerValuePrefix: 'Basic ' };
    ok(await f.slack('apply_workspace_changes', await f.update({ apiConnections: [basicConnection] }), text));
    await withConnectionNetwork(statusboard, async (requests) => {
      const colon = /^Nothing was (sent|saved): authShape basic_username (sends|saves) the key as an HTTP Basic username, which cannot hold a colon\. .*request_setup/;
      assert.match(refusal(await f.slack('try_connection', {
        draft: { ...DRAFT, headerName: 'Authorization', authShape: 'basic_username' }, key: pair, path: INCIDENTS,
      }, text)).message, colon);
      assert.match(refusal(await f.slack('try_connection', {
        connectionId: CONNECTION.id, draft: { ...DRAFT, headerName: 'Authorization', authShape: 'basic_username' }, key: pair, path: INCIDENTS,
      }, text)).message, colon);
      assert.match(refusal(await f.mcp('try_connection', {
        agentId: f.agent.id, draft: { ...DRAFT, headerName: 'Authorization', authShape: 'basic_username' }, key: pair, path: INCIDENTS,
      })).message, colon);
      assert.match(refusal(await f.slack('save_connection_key', {
        connectionId: CONNECTION.id, key: pair, path: INCIDENTS, authShape: 'basic_username',
      }, text)).message, colon);
      assert.deepEqual(requests, [], 'nothing was sent');
    });
    assert.equal(await f.savedKey(), undefined, 'nothing was saved');
  } finally { f.close(); }
});

test('saved-key mode tries a saved connection inside its own scope, and only the member\'s own lookup finds it', async () => {
  const f = await fixture();
  try {
    await savedConnection(f);
    await withConnectionNetwork(statusboard, async (requests) => {
      const saved = ok<TryConnectionResult>(await f.slack('try_connection', { connectionId: CONNECTION.id, path: INCIDENTS }, 'is Statusboard still working?'));
      assert.deepEqual(saved.check, { kind: 'ok', url: 'https://api.statusboard.example/v2/incidents', status: 200 });
      assert.equal(requests.at(-1)!.headers.get('x-api-key'), KEY, 'the saved key went, and the model never saw it');
      const reshaped = ok<TryConnectionResult>(await f.slack('try_connection', {
        connectionId: CONNECTION.id, draft: { ...DRAFT, headerName: 'Authorization', headerValuePrefix: 'Bearer ' }, path: INCIDENTS,
      }, 'try the saved key as a Bearer token'));
      assert.equal(reshaped.check.kind, 'key_rejected', 'a draft inside the connection may change the header');
      assert.match(refusal(await f.slack('try_connection', { connectionId: CONNECTION.id, path: '/v3/incidents' }, 'try /v3')).message,
        /path must be inside the connection/);

      const accountId = (await f.account()).id;
      for (const id of [CONNECTION.id, accountId]) {
        assert.match(refusal(await f.slack('try_connection', { connectionId: id, path: INCIDENTS }, 'try Statusboard', f.member)).message,
          /Agent|not found|edit/i, 'a member who cannot edit the Agent never reaches the key');
      }
      const count = requests.length;
      assert.match(refusal(await f.slack('try_connection', { connectionId: 'acct_someone_else', path: INCIDENTS }, 'try it')).message,
        /The API connection was not found/, 'a raw account id the member\'s lookup does not hold is not found');
      assert.equal(requests.length, count);
    });
    assert.deepEqual(f.settingCalls.filter((call) => !call.startsWith('getSetting')), [], 'a saved-key try reads the key and writes nothing');
  } finally { f.close(); }
});

test('a personal connection is tried only by the member it belongs to', async () => {
  const f = await fixture();
  try {
    await f.config.updateAgent(f.agent.id, { editPolicy: 'all_workspace_members' }, (await f.config.getAgent(f.agent.id)).revision);
    const personal = { ...CONNECTION, id: 'statusboard_mine', displayName: 'My Statusboard' };
    ok(await f.slack('apply_workspace_changes', await f.update({ apiConnections: [personal] }),
      `connect https://api.statusboard.example/v2 for me, key ${KEY}`, f.member));
    const mine = await f.account('My Statusboard');
    await withConnectionNetwork(statusboard, async (requests) => {
      for (const id of [personal.id, mine.id]) {
        assert.match(refusal(await f.slack('try_connection', { connectionId: id, key: KEY, path: INCIDENTS },
          `try https://api.statusboard.example/v2 with ${KEY}`)).message, /not found|team connection/i, id);
      }
      assert.deepEqual(requests, []);
    });
  } finally { f.close(); }
});

test('an approved connection admits the key from the message that proposed it, on the person\'s next message', async () => {
  const f = await fixture();
  try {
    const receipt = await approvedConnection(f);
    assert.equal(receipt, 'Applied the approved changes.\n\nReply here and I’ll test the key you pasted.');
    await withConnectionNetwork(statusboard, async (requests) => {
      const tried = ok<TryConnectionResult>(await f.slack('try_connection', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, 'ok, go ahead'));
      assert.equal(tried.check.kind, 'ok');
      assert.equal(requests[0]!.headers.get('x-api-key'), KEY);
      assert.equal(await f.savedKey(), undefined, 'a try saves nothing');
      ok(await f.slack('save_connection_key', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, 'save it'));
      assert.equal(await f.savedKey(), KEY);
    });
    assert.ok(f.managementCalls.length > 0);
    assert.deepEqual(f.managementCalls.filter((call) => call.includes(KEY)), [],
      'the key never entered a management record, not even through the proposal that carried its message');
    assert.deepEqual(f.results.filter((result) => result.includes(KEY)), [], 'no result returned the key');
  } finally { f.close(); }
});

test('the approval admits only its own connection, the person who approved it, for 30 minutes, a key they typed in that message, and only its first key to the hosts it approved', async () => {
  const refused = async (setup: (f: Fixture) => Promise<void>, attempt: (f: Fixture) => Promise<WorkspaceManagementToolResult>, why: string) => {
    const f = await fixture();
    try {
      await setup(f);
      await withConnectionNetwork(statusboard, async (requests) => {
        const { message } = refusal(await attempt(f));
        assert.match(message, /^Nothing was (sent|saved)/, `${why}: ${message}`);
        assert.deepEqual(requests, [], why);
      });
    } finally { f.close(); }
  };
  const next = (f: Fixture, key = KEY, by?: IdentityResolution) =>
    f.slack('try_connection', { connectionId: CONNECTION.id, key, path: INCIDENTS }, 'ok, go ahead', by);
  await refused(async (f) => { await approvedConnection(f); f.clock.now += 31 * 60_000; }, (f) => next(f), 'out of the window');
  await refused(async (f) => { await approvedConnection(f); }, (f) => next(f, OTHER_KEY), 'a key not in the proposing message');
  await refused(async (f) => { await approvedConnection(f, 'connect Statusboard so you can read our incidents'); },
    (f) => f.slack('try_connection', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, `here is the key ${KEY}`),
    'the key is missing from the proposing message, and this message does not name the host');
  await refused(async (f) => { await approvedConnection(f, `${UNTYPED_HOST} <@U99999999>`); }, (f) => next(f),
    'the proposing message was addressed to someone else');
  await refused(async (f) => {
    await approvedConnection(f);
    f.typed.clear();
  }, (f) => next(f), 'the host no longer holds the proposing turn');
  await refused(async (f) => {
    await approvedConnection(f);
    const [at, proposing] = [...f.typed].find(([, { text }]) => text === UNTYPED_HOST)!;
    f.typed.set(at, { ...proposing, userId: 'U99999999' });
  }, (f) => next(f), 'another person typed the proposing message');
  await refused(async (f) => {
    const other = { ...CONNECTION, id: 'statuspage', displayName: 'Statuspage', allowedHosts: ['api.statuspage.example'] };
    const added = ok<ManagementApplyResult>(await f.slack('apply_workspace_changes', await f.update({ apiConnections: [other] }),
      'add the Statuspage API at https://api.statuspage.example/v2'));
    assert.equal(added.outcomes[0]?.disposition, 'applied');
    await approvedConnection(f, UNTYPED_HOST, [other, CONNECTION]);
  }, (f) => f.slack('try_connection', { connectionId: 'statuspage', key: KEY, path: INCIDENTS }, 'ok, go ahead'),
  'a connection the Agent had before the approved change, though the change wrote it again');
  await refused(async (f) => {
    await f.config.updateAgent(f.agent.id, { editPolicy: 'all_workspace_members' }, (await f.config.getAgent(f.agent.id)).revision);
    await approvedConnection(f);
  }, (f) => f.slack('try_connection', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, 'ok, go ahead', f.owner),
  'another member who did not approve it');
  await refused(async (f) => { await approvedConnection(f); },
    (f) => f.slack('try_connection', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, '', f.admin, 'ask'),
    'a turn another Agent\'s ask started is not the person\'s next message');
  await refused(async (f) => { await approvedConnection(f); },
    (f) => f.slack('save_connection_key', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, '', f.admin, 'ask'),
    'save_connection_key holds to the same rule');
  await refused(async (f) => { await approvedConnection(f); f.clock.now += 31 * 60_000; },
    (f) => f.slack('save_connection_key', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, 'save it'),
    'save_connection_key out of the window');
  const movedInAdmin = async (f: Fixture) => {
    // Admin's edit finds the connection's account through the workspace installation.
    await f.config.ensureWorkspaceInstallation({
      workspaceId: f.workspaceId, transportMode: 'direct', teamId: f.workspaceId,
      appId: 'ACHICKPEA1', botUserId: 'UCHICKPEA1', runtimeContract: 'chickpea-v1',
    });
    await approvedConnection(f);
    const moved = await f.service.applyWorkspaceChanges({
      context: {
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        origin: { kind: 'admin', sessionId: 'admin_session' },
      },
      ...(await f.update({ apiConnections: [{ ...CONNECTION, allowedHosts: ['collector.example'] }] })),
    });
    assert.ok('outcomes' in moved && moved.outcomes[0]?.disposition === 'applied', JSON.stringify(moved));
    const { policy, lifecycle } = await f.account();
    assert.deepEqual(policy.kind === 'api' && policy.allowedHosts, ['collector.example']);
    assert.equal(lifecycle, 'pending', 'the edit leaves the connection waiting for its key');
  };
  await refused(movedInAdmin, (f) => next(f), 'Admin moved the connection to another host after the approval');
  await refused(movedInAdmin, async (f) => {
    const saved = await f.slack('save_connection_key', { connectionId: CONNECTION.id, key: KEY, path: INCIDENTS }, 'save it');
    assert.equal(await f.savedKey(), undefined, 'nothing was saved');
    return saved;
  }, 'save_connection_key after Admin moved the connection');
  await refused(async (f) => {
    await approvedConnection(f);
    await withConnectionNetwork(statusboard, async () => ok(await f.slack('save_connection_key', {
      connectionId: CONNECTION.id, key: KEY, path: INCIDENTS,
    }, 'save it')));
  }, (f) => next(f), 'the connection already has its key');
});

test('a receipt that issued a setup link does not offer to test a pasted key', async () => {
  const f = await fixture();
  try {
    const held = ok<ManagementApplyResult>(await f.slack('apply_workspace_changes', {
      idempotencyKey: 'with-setup',
      operations: [
        ...(await f.update({ apiConnections: [CONNECTION] })).operations,
        { itemId: 'key', kind: 'request_setup', dependsOn: ['connect'], target: { kind: 'api_connection', agentId: f.agent.id, connectionId: CONNECTION.id } },
      ],
    }, 'connect Statusboard so you can read our incidents'));
    const proposalId = held.outcomes.find(({ proposalId: id }) => id)?.proposalId;
    assert.ok(proposalId, JSON.stringify(held));
    const receipt = await f.approve(proposalId);
    assert.equal(receipt.kind, 'message');
    assert.doesNotMatch(receipt.kind === 'message' ? receipt.text : '', /test the key/);
  } finally { f.close(); }
});

test('the MCP door takes the key as given, bounded by the member\'s 30 tries in 10 minutes', async () => {
  const f = await fixture({ memberTries: [29, 28, undefined] as unknown as number[] });
  try {
    await withConnectionNetwork(statusboard, async (requests) => {
      const draft = ok<TryConnectionResult>(await f.mcp('try_connection', { agentId: f.agent.id, draft: DRAFT, key: KEY, path: INCIDENTS }));
      assert.deepEqual({ kind: draft.check.kind, triesLeft: draft.triesLeft }, { kind: 'ok', triesLeft: 29 });
      assert.match(refusal(await f.mcp('try_connection', { draft: DRAFT, key: KEY, path: INCIDENTS })).message, /Choose an Agent/);
      const pathKey = refusal(await f.mcp('try_connection', { agentId: f.agent.id, draft: DRAFT, key: KEY, path: `${INCIDENTS}?k=${KEY}` }));
      assert.match(pathKey.message, /path contains the key/, 'the refused call still took its try');
      assert.match(refusal(await f.mcp('try_connection', { agentId: f.agent.id, draft: DRAFT, key: KEY, path: INCIDENTS })).message,
        /used all 30 try_connection tries for the last 10 minutes/);
      assert.equal(requests.length, 1);
    });
  } finally { f.close(); }
});

test('the member limit counts every try, refused ones too, and opens again in the next window', async () => {
  const clock = { now: 1_800_000_000_000 };
  const identity = new SqliteIdentityStore(':memory:', { now: () => clock.now });
  try {
    const limiter = new AuthRateLimiter(identity, {
      pepper: 'p'.repeat(32), perKeyLimit: 30, windowMs: 10 * 60_000, now: () => clock.now,
    });
    const left: number[] = [];
    for (let index = 0; index < 30; index += 1) left.push(await limiter.take('try_connection', 'member_a'));
    assert.deepEqual([left[0], left.at(-1)], [29, 0]);
    await assert.rejects(limiter.take('try_connection', 'member_a'), AuthRateLimitError);
    await assert.rejects(limiter.take('try_connection', 'member_a'), AuthRateLimitError, 'a refused take still counts');
    assert.equal(await limiter.take('try_connection', 'member_b'), 29, 'each member has their own tries');
    clock.now += 10 * 60_000;
    assert.equal(await limiter.take('try_connection', 'member_a'), 29, 'the next window starts again');
  } finally { identity.close(); }
});

test('a turn\'s eight tries survive a re-render and a redrive, and a spent try never comes back', () => {
  const saved: ConnectionTryTurnState[] = [];
  let state: ConnectionTryTurnState = { turnJobId: 'turn_a', tries: 0 };
  const persist = (next: ConnectionTryTurnState) => { saved.push(next); state = next; };
  const first = createConnectionTryTurn('turn_a', state, persist);
  assert.deepEqual([first.take(), first.take(), first.take()], [7, 6, 5]);
  assert.deepEqual(saved.at(-1), { turnJobId: 'turn_a', tries: 3 }, 'each try is saved before its call goes out');
  const rendered = createConnectionTryTurn('turn_a', state, persist);
  const rest = Array.from({ length: CONNECTION_TRIES_PER_TURN - 3 }, () => rendered.take());
  assert.deepEqual(rest, [4, 3, 2, 1, 0]);
  assert.equal(rendered.take(), undefined, 'the ninth try in the turn is refused');
  assert.equal(createConnectionTryTurn('turn_a', state, persist).take(), undefined, 'a redrive of the same turn finds none left');
  assert.equal(createConnectionTryTurn('turn_b', state, persist).take(), 7, 'the next message is a new turn');
});
