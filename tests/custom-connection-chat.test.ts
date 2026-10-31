import assert from 'node:assert/strict';
import test from 'node:test';

import * as v from 'valibot';

import { connectionAccountSecretSettingKey } from '../src/config/connector-secrets.ts';
import type { SettingsStore } from '../src/config/settings-store.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import type { ManagementApiConnection } from '../src/management/agent-connections.ts';
import { saveManagedConnectionKey } from '../src/management/discovery.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import { saveConnectionKeyValibotSchema, saveConnectionKeyZodSchema } from '../src/management/schemas.ts';
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
  SaveConnectionKeyResult,
} from '../src/management/types.ts';
import type { ProductTelemetryEventInput } from '../src/telemetry/events.ts';
import { withConnectionNetwork, type StubbedRequest } from './helpers/connection-network.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const KB_PATH = '/cms/knowledge-base/2027-03-beta';
const KB_URL = `https://api.hubapi.com${KB_PATH}`;
const KEY = ['pat', 'na1', '00000000-0000-4000-8000-0000000000aa'].join('-');
const OTHER_KEY = ['pat', 'na1', '00000000-0000-4000-8000-0000000000bb'].join('-');
const KB_CONNECTION: ManagementApiConnection = {
  id: 'hubspot_kb',
  displayName: 'HubSpot Knowledge Base',
  allowedHosts: ['api.hubapi.com'],
  pathPrefixes: [KB_PATH],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET', 'HEAD', 'POST', 'PATCH'],
  enabled: true,
  authMode: 'credential',
};
const SAVE: WorkspaceManagementToolArguments['save_connection_key'] = {
  connectionId: 'hubspot_kb', key: KEY, path: `${KB_PATH}/knowledge-bases`,
};
const PASTED = `here's our HubSpot service key ${KEY} for the Knowledge Base API at <${KB_URL}>, set it up so you can read and write articles`;

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

async function fixture(editPolicy: 'creator_and_admins' | 'all_workspace_members' = 'creator_and_admins') {
  const managementCalls: string[] = [];
  const settingWrites: string[] = [];
  const telemetry: ProductTelemetryEventInput[] = [];
  const management = recording(new SqliteManagementStore(':memory:'), managementCalls);
  const f = await createManagementAdapterFixture('custom-connection-chat', {
    management,
    saveConnectionKey: (input) => saveManagedConnectionKey({
      ...input,
      config: f.config,
      settings: recording<SettingsStore>(f.settings, settingWrites),
      productTelemetry: { capture: (event) => telemetry.push(event) },
      connectionCheck: { cloudflare: true },
    }),
  });
  const agent = await f.config.createAgent({
    id: 'agent_scribe',
    name: 'Scribe',
    creatorMembershipId: f.admin.membership.id,
    editPolicy,
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Keep the help center current.',
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
  /** One Slack message from `by` to Scribe, then the tool it led to. */
  const slack = <TName extends WorkspaceManagementToolName>(
    name: TName,
    args: WorkspaceManagementToolArguments[TName],
    requesterText: string | undefined,
    by: IdentityResolution = f.admin,
    source?: 'click',
  ): Promise<WorkspaceManagementToolResult> => {
    turn += 1;
    const signal: SlackManagementSignal = {
      agentId: agent.id,
      workspaceId,
      channelId: 'D_SCRIBE',
      threadTs: '500.1',
      conversationKind: 'im',
      slackUserId: by.binding.slackUserId,
      eventId: `Ev_SCRIBE_${turn}`,
      messageTs: `500.${turn + 1}`,
      turnJobId: `turn_SCRIBE_${turn}`,
      ...(requesterText === undefined ? {} : { requesterText }),
      ...(source ? { requesterTextSource: source } : {}),
    };
    return invokeSlackWorkspaceManagementTool({ signal, identity: f.identity, service: f.service, name, args });
  };
  /** The same tool from the admin's coding agent over MCP. */
  const mcp = <TName extends WorkspaceManagementToolName>(
    name: TName,
    args: WorkspaceManagementToolArguments[TName],
  ): Promise<WorkspaceManagementToolResult> => invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => ({
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'custom-connection-chat' },
    }),
  }, name, args);
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
  /** update_agent from a Slack message; the item's disposition. */
  const connectFromSlack = async (
    requesterText: string,
    patch: ManagementAgentPatch = { apiConnections: [KB_CONNECTION] },
    by: IdentityResolution = f.admin,
  ) => applied(await slack('apply_workspace_changes', await update(patch), requesterText, by));
  const account = async (label = KB_CONNECTION.displayName) => {
    const found = (await f.config.listConnectionAccounts(workspaceId)).find((candidate) => candidate.label === label);
    assert.ok(found, `${label} exists`);
    return found;
  };
  /** The key saved for the connection with this display name, if any. */
  const savedKey = async (label = KB_CONNECTION.displayName) =>
    await f.settings.getSetting(connectionAccountSecretSettingKey((await account(label)).secretRefId)) ?? undefined;
  return {
    ...f, management, agent, member, workspaceId, managementCalls, settingWrites, telemetry,
    slack, mcp, update, connectFromSlack, account, savedKey,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function applied(response: WorkspaceManagementToolResult): ManagementApplyResult['outcomes'][number] & { status: string } {
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = (response as { result: ManagementApplyResult }).result;
  return { ...result.outcomes[0]!, status: result.status };
}

function saved(response: WorkspaceManagementToolResult): SaveConnectionKeyResult {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: SaveConnectionKeyResult }).result;
}

function refusal(response: WorkspaceManagementToolResult): { code: string; message: string } {
  assert.equal(response.ok, false, JSON.stringify(response));
  return (response as { error: { code: string; message: string } }).error;
}

/** The one Chickpea setup link a refusal hands the model to relay. */
function setupLinkIn(message: string): URL {
  const links = message.match(/http:\/\/localhost\/setup\/[\w-]+#setup=[\w-]{43}/g) ?? [];
  assert.equal(links.length, 1, message);
  return new URL(links[0]!);
}

/** The pending setup record behind a link: a request_setup for this Agent's connection, bound to `by`. */
async function assertConnectionSetup(f: Fixture, link: URL, by: IdentityResolution = f.admin) {
  const setupId = decodeURIComponent(link.pathname.split('/')[2]!);
  const record = await f.management.getSetup(setupId);
  assert.ok(record, `${setupId} was issued`);
  assert.deepEqual({
    actorMembershipId: record.actorMembershipId,
    action: record.action,
    status: record.status,
    target: { kind: record.target.kind, agentId: record.target.agentId, connectionId: record.target.connectionId },
  }, {
    actorMembershipId: by.membership.id,
    action: 'api_credential',
    status: 'pending',
    target: { kind: 'api_connection', agentId: f.agent.id, connectionId: (await f.account()).id },
  });
  return setupId;
}

/**
 * HubSpot's Knowledge Base API as it answers: 404 at the bare prefix with any
 * key or none, 401 below it without this key, and 200 on its list endpoints.
 */
function hubspot(key: string) {
  return (request: StubbedRequest) => {
    const { pathname } = new URL(request.url);
    if (pathname.replace(/\/+$/, '') === KB_PATH) return new Response(null, { status: 404 });
    if (request.headers.get('authorization') !== `Bearer ${key}`) {
      return Response.json({ status: 'error', category: 'INVALID_AUTHENTICATION' }, { status: 401 });
    }
    return [`${KB_PATH}/articles`, `${KB_PATH}/knowledge-bases`].includes(pathname)
      ? Response.json({ results: [] })
      : new Response(null, { status: 404 });
  };
}

/** Run with every console line captured. */
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

async function addKeyedConnection(f: Fixture) {
  assert.equal((await f.connectFromSlack(PASTED)).disposition, 'applied');
}

test('a new keyed connection the requester typed the URL of applies at once and waits for its key', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    assert.equal((await f.account()).lifecycle, 'pending');
    assert.equal(await f.savedKey(), undefined, 'the update carries no key, so the connection reaches nothing yet');

    const second = await f.connectFromSlack('the CMS pages API is at https://api.hubapi.com', {
      apiConnections: [
        KB_CONNECTION,
        { ...KB_CONNECTION, id: 'hubspot_cms', displayName: 'HubSpot CMS', pathPrefixes: ['/cms/v3/pages'] },
      ],
    });
    assert.equal(second.disposition, 'applied', 'a typed origin covers any path under it, and an unchanged connection needs no URL');

    const bearer = await f.connectFromSlack('add the MCP server https://mcp.example.com/mcp, it takes a token', {
      mcpServers: [{
        id: 'example_mcp', displayName: 'Example MCP', url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http', authMode: 'bearer', headerNames: [], enabled: true, allowedTools: [],
      }],
    });
    assert.equal(bearer.disposition, 'applied');
    assert.equal((await f.account('Example MCP')).lifecycle, 'pending');
  } finally { f.close(); }
});

test('an untyped or wider host, a narrower typed path, no key, OAuth or a second field waits for the person', async () => {
  const f = await fixture();
  try {
    const mcpServer = (authMode: 'none' | 'oauth') => ({
      mcpServers: [{
        id: 'example_mcp', displayName: 'Example MCP', url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http' as const, authMode, headerNames: [], enabled: true, allowedTools: [],
      }],
    });
    for (const [requesterText, patch] of [
      ['set up the HubSpot Knowledge Base API so you can read articles', { apiConnections: [KB_CONNECTION] }],
      [`use ${KB_URL} for articles`, { apiConnections: [{ ...KB_CONNECTION, allowedHosts: ['api.hubapi.com', 'api.hubspot.com'] }] }],
      [`use ${KB_URL}/articles for articles`, { apiConnections: [KB_CONNECTION] }],
      [`<https://evil.example/cms|${KB_URL}> is the API`, { apiConnections: [KB_CONNECTION] }],
      [`use ${KB_URL} and keep answers short`, { apiConnections: [KB_CONNECTION], instructions: 'Keep answers short.' }],
      ['summarize https://mcp.example.com/mcp for me', mcpServer('none')],
      ['add the MCP server https://mcp.example.com/mcp with OAuth sign-in', mcpServer('oauth')],
    ] as const satisfies ReadonlyArray<readonly [string, ManagementAgentPatch]>) {
      const outcome = await f.connectFromSlack(requesterText, patch);
      assert.equal(outcome.disposition, 'confirmation_required', requesterText);
    }
    assert.deepEqual(await f.config.listConnectionAccounts(f.workspaceId), [], 'nothing applied');
  } finally { f.close(); }
});

test('an edit to an existing connection waits for the person even with its URL typed', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    await withConnectionNetwork(hubspot(KEY), async () => saved(await f.slack('save_connection_key', SAVE, PASTED)));
    const widened = await f.connectFromSlack(`let it delete articles too at ${KB_URL}`, {
      apiConnections: [{ ...KB_CONNECTION, allowedMethods: [...KB_CONNECTION.allowedMethods, 'DELETE'] }],
    });
    assert.equal(widened.disposition, 'confirmation_required');
    const { policy } = await f.account();
    assert.ok(policy.kind === 'api');
    assert.deepEqual(policy.allowedMethods, KB_CONNECTION.allowedMethods, 'the saved key still reaches only the reviewed methods');
  } finally { f.close(); }
});

test('a member who cannot edit the Agent is refused even with every URL typed', async () => {
  const f = await fixture();
  try {
    const outcome = await f.connectFromSlack(`connect ${KB_URL}`, { apiConnections: [KB_CONNECTION] }, f.member);
    assert.equal(outcome.disposition, 'failed', JSON.stringify(outcome));
    assert.deepEqual(await f.config.listConnectionAccounts(f.workspaceId), []);
  } finally { f.close(); }
});

test('the MCP door adds a custom connection at once without typed URLs', async () => {
  const f = await fixture();
  try {
    assert.equal(applied(await f.mcp('apply_workspace_changes', await f.update({ apiConnections: [KB_CONNECTION] }))).disposition, 'applied');
  } finally { f.close(); }
});

test('both doors refuse save_connection_key without a path before anything runs', () => {
  const { path: _path, ...withoutPath } = SAVE;
  const slack = v.safeParse(saveConnectionKeyValibotSchema, withoutPath);
  assert.deepEqual(slack.success ? [] : slack.issues.map((issue) => issue.path?.map(({ key }) => key)), [['path']]);
  const mcp = saveConnectionKeyZodSchema.safeParse({ ...withoutPath, agentId: 'agent_scribe' });
  assert.deepEqual(mcp.success ? [] : mcp.error.issues.map((issue) => issue.path), [['path']]);
  assert.ok(v.safeParse(saveConnectionKeyValibotSchema, SAVE).success);
  assert.ok(saveConnectionKeyZodSchema.safeParse({ ...SAVE, agentId: 'agent_scribe' }).success);
});

test('save_connection_key refuses a key the requester did not type in this message, and sends nothing', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.connectFromSlack(`connect ${KB_URL} for articles`)).disposition, 'applied');
    await withConnectionNetwork(hubspot(KEY), async (requests) => {
      const error = refusal(await f.slack('save_connection_key', SAVE, `use the key I sent yesterday for ${KB_URL}`));
      assert.equal(error.code, 'invalid_request');
      assert.match(error.message, /typed in their own current message/);
      assert.equal(requests.length, 0, 'nothing was sent');
    });
    assert.equal(await f.savedKey(), undefined);
  } finally { f.close(); }
});

test('save_connection_key refuses a key from another person\'s message, a click, or with an untyped host', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    await withConnectionNetwork(hubspot(KEY), async (requests) => {
      // The admin's message above holds the key; the owner's message does not.
      assert.match(refusal(await f.slack('save_connection_key', SAVE,
        `use the key Admin posted above for ${KB_URL}`, f.owner)).message, /typed in their own current message/);
      assert.match(refusal(await f.slack('save_connection_key', SAVE, PASTED, f.admin, 'click')).message,
        /typed in their own current message/);
      assert.match(refusal(await f.slack('save_connection_key', { ...SAVE, key: KEY.slice(0, -4) }, PASTED)).message,
        /typed in their own current message/, 'part of a typed key is not the key');
      assert.match(refusal(await f.slack('save_connection_key', SAVE, `here's the key ${KEY} for HubSpot`)).message,
        /sends its key to https:\/\/api\.hubapi\.com\/cms\/knowledge-base\/2027-03-beta, which the requester did not type/);
      assert.equal(requests.length, 0);
    });
    assert.equal(await f.savedKey(), undefined);
  } finally { f.close(); }
});

test('save_connection_key refuses a Google sign-in and an MCP server', async () => {
  const f = await fixture();
  try {
    const accounts = new ConnectionAccountService({ config: f.config, settings: f.settings });
    await accounts.createForAgent({
      principal: {
        userId: f.admin.user.id, membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId, role: 'admin', authenticatorKind: 'session',
        credentialId: 'session:custom-connection-chat', correlationId: 'custom-connection-chat', machine: false,
      },
      agentId: f.agent.id, workspaceId: f.workspaceId, ownerKind: 'team', providerId: 'google', label: 'Gmail',
      policy: {
        kind: 'api', allowedHosts: ['gmail.googleapis.com'], pathPrefixes: ['/gmail/v1/users/me'],
        headerName: 'Authorization', headerValuePrefix: 'Bearer ', allowedMethods: ['GET'],
        authMode: 'oauth', oauthProvider: 'google', oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      },
      allowedCapabilities: [],
    });
    assert.equal(applied(await f.mcp('apply_workspace_changes', await f.update({
      mcpServers: [{
        id: 'example_mcp', displayName: 'Example MCP', url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http', authMode: 'bearer', headerNames: [], enabled: true, allowedTools: [],
      }],
    }))).disposition, 'applied');
    const text = `key ${KEY} for https://gmail.googleapis.com/gmail/v1/users/me and https://mcp.example.com/mcp`;
    assert.match(refusal(await f.slack('save_connection_key', { ...SAVE, connectionId: 'google' }, text)).message,
      /signs in with Google/);
    assert.match(refusal(await f.slack('save_connection_key', { ...SAVE, connectionId: 'example_mcp' }, text)).message,
      /API connections only/);
  } finally { f.close(); }
});

test('save_connection_key refuses a member a team connection, as its setup link would', async () => {
  const f = await fixture('all_workspace_members');
  try {
    await addKeyedConnection(f);
    assert.equal((await f.account()).ownerKind, 'team');
    const forbidden = await withConnectionNetwork(hubspot(KEY), async () =>
      f.slack('save_connection_key', SAVE, PASTED, f.member));
    assert.deepEqual(refusal(forbidden), {
      code: 'forbidden', message: 'Only a Chickpea Admin can change or remove a team connection.',
    });
    assert.equal(await f.savedKey(), undefined);
  } finally { f.close(); }
});

test('a working key checked where the API answers 404 saves nothing and hands back a setup link for that connection', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    const response = await withConnectionNetwork(hubspot(KEY), async () =>
      f.slack('save_connection_key', { ...SAVE, path: KB_PATH }, PASTED));
    const error = refusal(response);
    assert.equal(error.code, 'key_unconfirmed');
    const setupId = await assertConnectionSetup(f, setupLinkIn(error.message));
    assert.match(error.message, /^Nothing was saved, because Chickpea could not confirm the key\. https:\/\/api\.hubapi\.com\/cms\/knowledge-base\/2027-03-beta answered HTTP 404\./);
    assert.match(error.message, /Tell the person Chickpea could not confirm the key works, suggest they rotate the key at the service because they pasted it in chat, and give them the setup link below/);
    assert.match(error.message, /Never repeat the key/);
    assert.doesNotMatch(error.message, /call save_connection_key again/, 'the model only relays the link');
    for (const [where, text] of [
      ['the result', JSON.stringify(response)],
      ['the stored setup', JSON.stringify(await f.management.getSetup(setupId))],
      ['other management store calls', f.managementCalls.filter((call) => !call.startsWith('putSetup ')).join('\n')],
      ['settings', f.settingWrites.join('\n')],
      ['telemetry', JSON.stringify(f.telemetry)],
    ] as const) assert.doesNotMatch(text, new RegExp(KEY), `the key is absent from ${where}`);
    assert.equal(await f.savedKey(), undefined);
    assert.equal((await f.account()).lifecycle, 'pending');
  } finally { f.close(); }
});

test('a 401 saves nothing and says the key did not work, without the key', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    const response = await withConnectionNetwork(hubspot(OTHER_KEY), async () => f.slack('save_connection_key', SAVE, PASTED));
    const error = refusal(response);
    assert.equal(error.code, 'key_rejected');
    assert.match(error.message, /^api\.hubapi\.com rejected this key \(HTTP 401\), so nothing was saved\. Tell the person the key did not work, suggest they rotate the key/);
    const setupId = await assertConnectionSetup(f, setupLinkIn(error.message));
    assert.doesNotMatch(JSON.stringify(response), new RegExp(KEY));
    assert.doesNotMatch(JSON.stringify(await f.management.getSetup(setupId)), new RegExp(KEY));
    assert.equal(await f.savedKey(), undefined);
    assert.equal((await f.account()).lifecycle, 'pending');
  } finally { f.close(); }
});

test('when no setup link can be issued, a refused key still saves nothing and the refusal says how to get one', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    f.management.putSetup = async () => { throw new Error('the setup store is unavailable'); };
    const { result: response, logs } = await capturingLogs(() => withConnectionNetwork(hubspot(KEY), async () =>
      f.slack('save_connection_key', { ...SAVE, path: KB_PATH }, PASTED)));
    const error = refusal(response);
    assert.equal(error.code, 'key_unconfirmed');
    assert.equal(error.message, `Nothing was saved, because Chickpea could not confirm the key. ${KB_URL} answered HTTP 404. To check it, call save_connection_key again with path set to a read endpoint of this API that the key can read, such as a list endpoint, or send a setup link with request_setup. Never repeat the key.`);
    assert.doesNotMatch(logs, new RegExp(KEY));
    assert.equal(await f.savedKey(), undefined, 'a working key is still not saved when its link fails');
    assert.equal((await f.account()).lifecycle, 'pending');
  } finally { f.close(); }
});

test('the setup link a refused key returns completes like a request_setup link, for the requester only', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    const error = refusal(await withConnectionNetwork(hubspot(OTHER_KEY), async () =>
      f.slack('save_connection_key', SAVE, PASTED)));
    const link = setupLinkIn(error.message);
    const setupId = await assertConnectionSetup(f, link);
    const issuedAt = (await f.management.getSetup(setupId))!.createdAt;
    let signedIn = f.owner;
    const app = createManagementSetupRoutes({
      management: f.management,
      config: f.config,
      settings: f.settings,
      identity: f.identity,
      now: () => issuedAt,
      authenticatePrincipal: async () => ({
        userId: signedIn.user.id,
        membershipId: signedIn.membership.id,
        organizationId: signedIn.membership.organizationId,
        role: signedIn.membership.role,
        authenticatorKind: 'better_auth',
        credentialId: `session_${signedIn.membership.id}`,
        correlationId: 'custom-connection-chat',
        machine: false,
      }),
      deliverReceipt: async () => ({ deliveryRef: 'slack:receipt' }),
      connectionCheck: { cloudflare: true },
    });
    const claim = () => app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: link.hash.slice('#setup='.length) }),
    });
    assert.notEqual((await claim()).status, 200, 'another signed-in person cannot claim the link');
    signedIn = f.admin;
    const claimed = await claim();
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const completed = await withConnectionNetwork(hubspot(KEY), async () =>
      app.request(`http://localhost/setup/${setupId}/complete`, {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          cookie: claimed.headers.get('set-cookie')!,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ credential: KEY }).toString(),
      }));
    assert.equal(completed.status, 303, await completed.clone().text());
    assert.equal(await f.savedKey(), KEY);
    assert.equal((await f.account()).lifecycle, 'ready');
    assert.equal((await f.management.getSetup(setupId))?.status, 'completed');
  } finally { f.close(); }
});

test('a bogus key checked at a prefix that answers 404 saves nothing; a read path that needs the key rejects it', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    const unchecked = await withConnectionNetwork(hubspot(OTHER_KEY), async (requests) => {
      const response = await f.slack('save_connection_key', { ...SAVE, path: KB_PATH }, PASTED);
      assert.deepEqual(requests.map(({ url }) => url), [KB_URL], 'the check GETs the path it was given');
      return response;
    });
    const error = refusal(unchecked);
    assert.equal(error.code, 'key_unconfirmed');
    assert.match(error.message, /^Nothing was saved/);
    await assertConnectionSetup(f, setupLinkIn(error.message));
    assert.doesNotMatch(error.message, /accepted/);
    assert.doesNotMatch(JSON.stringify(unchecked), new RegExp(KEY));
    assert.equal(await f.savedKey(), undefined);
    assert.equal((await f.account()).lifecycle, 'pending');
    assert.deepEqual(f.telemetry, [], 'the connection never went ready');

    const rejected = await withConnectionNetwork(hubspot(OTHER_KEY), async () =>
      f.slack('save_connection_key', { ...SAVE, path: `${KB_PATH}/articles` }, PASTED));
    assert.equal(refusal(rejected).code, 'key_rejected');
    assert.equal(await f.savedKey(), undefined);
  } finally { f.close(); }
});

test('a 5xx, an unreadable answer or a failed request saves nothing either, over Slack and MCP', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    for (const [respond, said] of [
      [() => new Response(null, { status: 503 }), /answered HTTP 503\./],
      [() => new Response(null, { status: 429 }), /answered HTTP 429\./],
      [() => { throw new TypeError('fetch failed'); }, /did not complete/],
    ] as const) {
      const error = refusal(await withConnectionNetwork(respond, async () => f.slack('save_connection_key', SAVE, PASTED)));
      assert.equal(error.code, 'key_unconfirmed');
      assert.match(error.message, said);
      await assertConnectionSetup(f, setupLinkIn(error.message));
    }
    const viaMcp = refusal(await withConnectionNetwork(hubspot(OTHER_KEY), async () =>
      f.mcp('save_connection_key', { ...SAVE, path: KB_PATH, agentId: f.agent.id })));
    assert.equal(viaMcp.code, 'key_unconfirmed');
    await assertConnectionSetup(f, setupLinkIn(viaMcp.message));
    assert.doesNotMatch(viaMcp.message, /rotate/, 'over MCP the person gave the key to their own coding agent, not a chat');
    assert.equal(await f.savedKey(), undefined);
    assert.equal((await f.account()).lifecycle, 'pending');
  } finally { f.close(); }
});

test('a key typed with its URLs is checked, saved and makes the connection ready; Slack never replaces it', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    const { result, logs } = await capturingLogs(() => withConnectionNetwork(hubspot(KEY), async (requests) => {
      const response = await f.slack('save_connection_key', { ...SAVE, path: '/cms/knowledge-base/2027-03-beta/articles?limit=1' }, PASTED);
      assert.deepEqual(requests.map(({ method, url }) => [method, url]),
        [['GET', `${KB_URL}/articles?limit=1`]], 'one GET inside the connection');
      return response;
    }));
    assert.deepEqual(saved(result), {
      agent: { id: f.agent.id, name: 'Scribe' },
      connection: {
        id: (await f.account()).id,
        name: 'HubSpot Knowledge Base',
        sendsKeyTo: [KB_URL],
        allowedMethods: ['GET', 'HEAD', 'POST', 'PATCH'],
      },
      check: { kind: 'ok', url: `${KB_URL}/articles?limit=1`, status: 200 },
      instruction: saved(result).instruction,
    });
    assert.match(saved(result).instruction, /rotate it at the service and use the setup link next time/);
    assert.equal(await f.savedKey(), KEY);
    assert.equal((await f.account()).lifecycle, 'ready');
    assert.deepEqual(f.telemetry.map(({ event, ...rest }) => ({ event, surface: (rest as { surface?: string }).surface })),
      [{ event: 'connection_ready', surface: 'slack' }]);

    for (const [where, text] of [
      ['the result', JSON.stringify(result)],
      ['the logs', logs],
      ['operation and proposal stores', f.managementCalls.join('\n')],
      ['telemetry', JSON.stringify(f.telemetry)],
      ['the connection account', JSON.stringify(await f.config.listConnectionAccounts(f.workspaceId))],
      ['the Agent', JSON.stringify(await f.config.getAgent(f.agent.id))],
    ] as const) assert.doesNotMatch(text, new RegExp(KEY), `the key is absent from ${where}`);
    assert.deepEqual(f.settingWrites.filter((call) => call.includes(KEY)),
      [`setSetting ${JSON.stringify([connectionAccountSecretSettingKey((await f.account()).secretRefId), KEY])}`],
      'the key is written once, to its secret slot');

    const replaced = await withConnectionNetwork(hubspot(OTHER_KEY), async (requests) => {
      const response = await f.slack('save_connection_key', { ...SAVE, key: OTHER_KEY },
        `rotated: ${OTHER_KEY} for ${KB_URL}`);
      assert.equal(requests.length, 0);
      return response;
    });
    assert.match(refusal(replaced).message, /already has a saved key, and only Admin can replace it from Slack/);
    assert.equal(await f.savedKey(), KEY);
  } finally { f.close(); }
});

test('with no key in the message, the same call adds the connection and returns its setup link', async () => {
  const f = await fixture();
  try {
    const call = await f.update({ apiConnections: [KB_CONNECTION] });
    const response = await f.slack('apply_workspace_changes', {
      ...call,
      operations: [...call.operations, {
        itemId: 'key',
        kind: 'request_setup',
        dependsOn: ['connect'],
        target: { kind: 'api_connection', agentId: f.agent.id, connectionId: KB_CONNECTION.id },
      }],
    }, `set up the HubSpot Knowledge Base API at ${KB_URL} so you can read articles`);
    assert.equal(response.ok, true, JSON.stringify(response));
    const { outcomes } = (response as { result: ManagementApplyResult }).result;
    assert.deepEqual(outcomes.map(({ itemId, disposition }) => [itemId, disposition]),
      [['connect', 'applied'], ['key', 'setup_required']]);
    assert.match(String((outcomes[1] as { setupUrl?: string }).setupUrl), /\/setup\//);
    assert.equal((await f.account()).lifecycle, 'pending');
  } finally { f.close(); }
});

test('a setup link the same call asks for with a read endpoint checks the key there, where the bare prefix answers 404', async () => {
  const f = await fixture();
  try {
    const call = await f.update({ apiConnections: [KB_CONNECTION] });
    const response = await f.slack('apply_workspace_changes', {
      ...call,
      operations: [...call.operations, {
        itemId: 'key',
        kind: 'request_setup',
        dependsOn: ['connect'],
        target: { kind: 'api_connection', agentId: f.agent.id, connectionId: KB_CONNECTION.id, path: `${KB_PATH}/articles` },
      }],
    }, `set up the HubSpot Knowledge Base API at ${KB_URL} so you can read articles`);
    assert.equal(response.ok, true, JSON.stringify(response));
    const link = new URL(String(((response as { result: ManagementApplyResult }).result.outcomes[1] as { setupUrl?: string }).setupUrl));
    const setupId = await assertConnectionSetup(f, link);
    const issued = await f.management.getSetup(setupId);
    assert.ok(issued);
    assert.equal(issued.target.checkPath, `${KB_PATH}/articles`);
    const app = createManagementSetupRoutes({
      management: f.management,
      config: f.config,
      settings: f.settings,
      identity: f.identity,
      now: () => issued.createdAt,
      authenticatePrincipal: async () => ({
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        role: f.admin.membership.role,
        authenticatorKind: 'better_auth',
        credentialId: `session_${f.admin.membership.id}`,
        correlationId: 'custom-connection-chat',
        machine: false,
      }),
      deliverReceipt: async () => ({ deliveryRef: 'slack:receipt' }),
      connectionCheck: { cloudflare: true },
    });
    const claimed = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: link.hash.slice('#setup='.length) }),
    });
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const completed = await withConnectionNetwork(hubspot(KEY), async (requests) => {
      const answer = await app.request(`http://localhost/setup/${setupId}/complete`, {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          cookie: claimed.headers.get('set-cookie')!,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ credential: KEY }).toString(),
      });
      assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [`GET ${KB_URL}/articles`]);
      return answer;
    });
    assert.equal(completed.headers.get('location'), `/setup/${setupId}`, 'the check found the key works');
    assert.equal(await f.savedKey(), KEY);
  } finally { f.close(); }
});

test('a 403 saves nothing from chat, since some APIs answer 403 to an invalid key', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    const response = await withConnectionNetwork((request) => request.headers.get('authorization') === `Bearer ${KEY}`
      ? Response.json({ category: 'MISSING_SCOPES' }, { status: 403 })
      : Response.json({}, { status: 401 }), async () => f.slack('save_connection_key', SAVE, PASTED));
    const error = refusal(response);
    assert.equal(error.code, 'key_unconfirmed');
    assert.match(error.message, /A 403 can mean the key is invalid or that it lacks access to that path/);
    await assertConnectionSetup(f, setupLinkIn(error.message));
    assert.doesNotMatch(JSON.stringify(response), new RegExp(KEY));
    assert.equal(await f.savedKey(), undefined);
    assert.equal((await f.account()).lifecycle, 'pending');
  } finally { f.close(); }
});

test('over MCP the person\'s own key is saved as given and may replace a saved key', async () => {
  const f = await fixture();
  try {
    assert.equal(applied(await f.mcp('apply_workspace_changes', await f.update({ apiConnections: [KB_CONNECTION] }))).disposition, 'applied');
    await withConnectionNetwork(hubspot(KEY), async () => {
      assert.match(refusal(await f.mcp('save_connection_key', SAVE)).message, /Choose an Agent/);
      const first = saved(await f.mcp('save_connection_key', { ...SAVE, agentId: f.agent.id }));
      assert.equal(first.check.kind, 'ok');
      assert.doesNotMatch(first.instruction, /rotate/);
    });
    await withConnectionNetwork(hubspot(OTHER_KEY), async () => {
      saved(await f.mcp('save_connection_key', { ...SAVE, agentId: f.agent.id, key: OTHER_KEY }));
    });
    assert.equal(await f.savedKey(), OTHER_KEY);
  } finally { f.close(); }
});

test('one pasted key fills one connection, even when the message names a second URL', async () => {
  const f = await fixture();
  try {
    const docs = 'https://docs.example.com/api';
    const message = `key ${KEY} for <${KB_URL}>, docs at <${docs}>`;
    assert.equal((await f.connectFromSlack(message)).disposition, 'applied');
    await withConnectionNetwork(hubspot(KEY), async () => saved(await f.slack('save_connection_key', SAVE, message)));
    assert.equal(await f.savedKey(), KEY);

    const docsConnection = {
      ...KB_CONNECTION, id: 'docs_api', displayName: 'Docs API',
      allowedHosts: ['docs.example.com'], pathPrefixes: ['/api'],
    };
    assert.equal((await f.connectFromSlack(message, { apiConnections: [KB_CONNECTION, docsConnection] })).disposition, 'applied');
    await withConnectionNetwork(hubspot(KEY), async (requests) => {
      assert.match(refusal(await f.slack('save_connection_key', { ...SAVE, connectionId: 'docs_api', path: '/api/pages' }, message)).message,
        /already saved on another of this Agent's connections/);
      assert.equal(requests.length, 0, 'the key never reaches the second URL');
    });
    assert.equal(await f.savedKey('Docs API'), undefined);
  } finally { f.close(); }
});

test('a bare domain Slack linked as http counts as typed, and a URL with userinfo never does', async () => {
  const f = await fixture();
  try {
    const bare = KB_URL.replace('https://', '');
    const linked = `here's our key ${KEY} for <http://${bare}|${bare}>, read and write articles`;
    assert.equal((await f.connectFromSlack(linked)).disposition, 'applied');
    await withConnectionNetwork(hubspot(KEY), async () => saved(await f.slack('save_connection_key', SAVE, linked)));
    assert.equal(await f.savedKey(), KEY);

    const disguised = {
      ...KB_CONNECTION, id: 'disguised', displayName: 'Disguised',
      allowedHosts: ['evil.example'], pathPrefixes: ['/cms'],
    };
    const decision = await f.connectFromSlack(`key ${OTHER_KEY} for <https://api.hubapi.com@evil.example/cms>`, {
      apiConnections: [KB_CONNECTION, disguised],
    });
    assert.notEqual(decision.disposition, 'applied', 'userinfo hides the real host, so the person must confirm');
  } finally { f.close(); }
});

test('save_connection_key refuses an empty key, a path outside the connection, an Agent ask and a stale revision', async () => {
  const f = await fixture();
  try {
    await addKeyedConnection(f);
    await withConnectionNetwork(hubspot(KEY), async (requests) => {
      assert.ok(refusal(await f.slack('save_connection_key', { ...SAVE, key: '   ' }, PASTED)).message);
      assert.match(refusal(await f.slack('save_connection_key', { ...SAVE, path: '/crm/v3/objects/contacts' }, PASTED)).message,
        /path must be inside the connection/);
      assert.match(refusal(await f.slack('save_connection_key', SAVE, undefined)).message,
        /typed in their own current message/, 'an Agent ask carries no requester text');
      const account = await f.account();
      await assert.rejects(saveManagedConnectionKey({
        agentId: f.agent.id,
        connectionId: account.id,
        actor: { workspaceId: f.workspaceId, actorMembershipId: f.admin.membership.id },
        key: KEY,
        path: SAVE.path,
        expectedRevision: account.revision + 1,
        surface: 'slack',
        config: f.config,
        settings: f.settings,
        connectionCheck: { cloudflare: true },
      }), /changed/i);
      assert.equal(requests.length, 0, 'no refused save sends anything');
    });
    assert.equal(await f.savedKey(), undefined);
  } finally { f.close(); }
});
