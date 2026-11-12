import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as v from 'valibot';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { managementOperationValibotSchema, managementOperationZodSchema } from '../src/management/schemas.ts';
import type { WorkspaceManagementService, WorkspaceManagementServiceInput } from '../src/management/service.ts';
import type { ManagementOperation } from '../src/management/types.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import {
  resetIdentityVerificationsForTests,
  SlackInstallationUnavailableError,
} from '../src/slack/installation-execution.ts';
import { assembleRetainedSlackContext } from '../src/slack/public-context.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { hydrateTurnSlackContext } from '../src/slack/turn-context-reads.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { assembleSlackPrompt } from '../src/slack/web-client-context.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { authorityFixture, chickpeaDm, createAgent, NOW, type Person } from './helpers/management-authority-fixture.ts';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any> & { error?: Record<string, unknown> };
  isError?: boolean;
};

const THREAD_TS = '1800000000.000100';

/** Slack as a DM schedule made over MCP sees it: what opened, what was posted, what was taken back. */
function fakeSlack(options: { openError?: unknown } = {}) {
  const calls = {
    opened: [] as string[],
    started: [] as Array<{ conversationId: string; agent: string; text: string }>,
    withdrawn: [] as Array<{ conversationId: string; threadTs: string }>,
  };
  /** What changes between the first message and the save. */
  const hooks: { afterStart?: () => Promise<unknown> } = {};
  const threads: NonNullable<WorkspaceManagementServiceInput['directScheduleThreads']> = {
    async open({ slackUserId }) {
      calls.opened.push(slackUserId);
      if (options.openError) throw options.openError;
      return `D_${slackUserId}`;
    },
    async start({ conversationId, agent, text }) {
      calls.started.push({ conversationId, agent: agent.name, text });
      await hooks.afterStart?.();
      return THREAD_TS;
    },
    async withdraw({ conversationId, threadTs }) {
      calls.withdrawn.push({ conversationId, threadTs });
    },
  };
  return { calls, hooks, threads };
}

/**
 * One workspace whose routines and config share a state database, as a
 * deployment's do. The member created the Agent, which is in no Channel, so
 * only they may DM it; the Owner may edit it but not DM it.
 */
async function harness(t: TestContext, suffix: string, slack = fakeSlack()) {
  const f = await authorityFixture(suffix, { directScheduleThreads: slack.threads });
  t.after(() => f.close());
  await createAgent(f, f.member, 'agent_research', { name: 'Research' });
  return {
    f,
    slack,
    member: mcpCaller(f.service, f.member, 'member', suffix),
    owner: mcpCaller(f.service, f.owner, 'owner', suffix),
    teamId: f.workspaceId,
  };
}

/** The person, signed in over MCP, calling one tool. */
function mcpCaller(service: WorkspaceManagementService, person: Person, role: 'owner' | 'member', suffix: string) {
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: person.binding.betterAuthUserId ?? `ba_${role}`,
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    role,
    clientId: `client_${suffix}`,
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service, baseUrl: 'https://chickpea.example.test' }),
    { legacy: 'stateless' },
  );
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const json = body.trimStart().startsWith('{')
      ? body
      : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
    return (JSON.parse(json) as { result: ToolResult }).result;
  };
}

function captureWarnings(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return lines;
}

function structured(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}

function errorOf(result: ToolResult, code: string): Record<string, unknown> {
  assert.equal(result.isError, true, JSON.stringify(result));
  const error = result.structuredContent?.error;
  assert.ok(error, JSON.stringify(result));
  assert.equal(error.code, code, JSON.stringify(error));
  return error;
}

const DM_SCHEDULE = {
  agentId: 'agent_research',
  dm: 'me',
  name: 'Morning check',
  task: 'Summarize what changed overnight.',
  when: { cron: '0 9 * * 1-5' },
  timezone: 'UTC',
  post: 'always',
  requiredConnections: [],
};

test('save_schedule with dm "me" posts in the caller\'s own DM, in a thread its Agent starts and answers in', async (t) => {
  const { f, slack, member, owner, teamId } = await harness(t, 'dm-create');
  const dm = `D_${f.member.user.slackUserId}`;

  const created = structured(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'dm-create' }));
  assert.equal(created.status, 'done');
  assert.equal(created.summary, 'Created the schedule. Every run posts in one thread in your DM with Research, which it just started.');
  assert.deepEqual(slack.calls.opened.at(-1), f.member.user.slackUserId, 'the DM is the signed-in person\'s own');
  assert.deepEqual(slack.calls.started, [{
    conversationId: dm,
    agent: 'Research',
    text: 'I\'ll post *Morning check* in this thread when it runs.',
  }]);

  const [routine, ...others] = await f.routines.listRoutines(teamId, dm);
  assert.deepEqual(others, []);
  assert.deepEqual(routine?.destination, {
    kind: 'direct_thread',
    conversationId: dm,
    threadTs: THREAD_TS,
    ownerMembershipId: f.member.membership.id,
  });
  assert.equal(routine.state, 'active');
  assert.equal((await f.config.getAgentThreadRoute(teamId, dm, THREAD_TS))?.agentId, 'agent_research',
    'a reply in the thread goes to the Agent');

  const [listed, ...more] = structured(await member('list_schedules', {})).schedules;
  assert.deepEqual(more, []);
  assert.deepEqual(listed.where, { kind: 'dm', label: 'your DM with Research' });
  assert.equal(listed.runsAs.you, true);
  assert.equal(listed.version, created.version);
  assert.deepEqual(structured(await member('list_schedules', { scheduleId: listed.scheduleId })).schedules[0].where,
    { kind: 'dm', label: 'your DM with Research' });
  assert.deepEqual(structured(await owner('list_schedules', {})).schedules, [], 'nobody else sees it, an Owner included');

  const again = structured(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'dm-create' }));
  assert.equal(again.version, created.version);
  assert.equal(slack.calls.started.length, 1, 'a retry starts no second thread');

  const edited = structured(await member('save_schedule', {
    ...DM_SCHEDULE,
    dm: undefined,
    scheduleId: listed.scheduleId,
    version: listed.version,
    task: 'Summarize what changed overnight, newest first.',
    when: { keep: true },
    idempotencyKey: 'dm-edit',
  }));
  assert.equal(edited.summary, 'Saved the schedule.');
  const [after] = await f.routines.listRoutines(teamId, dm);
  assert.equal(after?.taskText, 'Summarize what changed overnight, newest first.');
  assert.deepEqual(after.destination, routine.destination);
  assert.equal(slack.calls.started.length, 1);

  const echoed = structured(await member('save_schedule', {
    ...DM_SCHEDULE, scheduleId: listed.scheduleId, version: edited.version, when: { keep: true }, idempotencyKey: 'dm-echo',
  }));
  assert.equal(echoed.status, 'done', 'dm "me" on a schedule already in that DM changes nothing about where it posts');

  const moved = errorOf(await member('save_schedule', {
    ...DM_SCHEDULE, dm: undefined, channelId: 'C_SUPPORT', scheduleId: listed.scheduleId, version: echoed.version,
    when: { keep: true }, idempotencyKey: 'dm-move',
  }), 'invalid_input');
  assert.equal(moved.message, 'A schedule keeps where it posts, so nothing changed.');
  assert.equal(slack.calls.withdrawn.length, 0);
});

test('a reply in a DM schedule\'s thread reads its first message as the Agent\'s own', async (t) => {
  const { f, member, teamId } = await harness(t, 'dm-history');
  structured(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'dm-history' }));
  const dm = `D_${f.member.user.slackUserId}`;
  const opening = 'I\'ll post *Morning check* in this thread when it runs.';
  const replyTs = '1800000500.000200';
  const reply: NormalizedSlackTurn = {
    workspaceId: teamId,
    channelId: dm,
    channelType: 'im',
    eventId: 'Ev_dm_history',
    text: 'What was the first message in this thread? Quote it and say who posted it.',
    userId: f.member.user.slackUserId,
    messageTs: replyTs,
    threadTs: THREAD_TS,
    source: 'dm_message',
    contextMode: 'thread',
  };
  // Slack's copy of the first message: posted under the Agent's name, with no author user.
  const slack = {
    conversations: {
      async replies() {
        return {
          ok: true,
          messages: [
            { type: 'message', subtype: 'bot_message', bot_id: 'BCHICKPEA1', username: 'Research', ts: THREAD_TS, text: opening },
            { type: 'message', user: f.member.user.slackUserId, ts: replyTs, thread_ts: THREAD_TS, text: reply.text },
          ],
        };
      },
    },
  };
  // The shared app reads a thread once a minute, and the run that just
  // posted took this minute's read. An install's own app reads Slack freely.
  const spentBudget = {
    async reserveSlackRead() { return { outcome: 'exhausted' as const, retryAt: NOW + 60_000, budgetVersion: 1 }; },
    async applySlackReadCooldown() { return { cooldownUntil: 0, budgetVersion: 1 }; },
  };
  for (const sharedAppReads of [true, false]) {
    const hydrated = await hydrateTurnSlackContext({
      client: slack as never,
      turn: reply,
      sharedAppReads,
      botUserId: 'UCHICKPEA1',
      state: spentBudget,
      record: f.config,
    });
    const context = await assembleRetainedSlackContext(hydrated, reply, { store: f.config, agentId: 'agent_research' });
    const first = context.messages.find((message) => message.ts === THREAD_TS);
    assert.ok(first, `the first message is in the context (shared app: ${sharedAppReads})`);
    assert.equal(first.text, opening);
    assert.equal(first.role, 'agent', `posted by an Agent, not an outside app (shared app: ${sharedAppReads})`);
    assert.equal(first.agentId, 'agent_research', 'and that Agent is the one answering');

    const prompt = assembleSlackPrompt(reply, context);
    assert.match(prompt, /Current Slack thread context \(same Slack root as this request\):\n/);
    const row = prompt.split('\n').find((line) => line.includes(`; ${THREAD_TS} `));
    assert.ok(row?.includes(` role=agent root=${THREAD_TS}] `) && row.endsWith(`: ${opening}`), prompt);
    assert.doesNotMatch(prompt, /incomplete/);
  }
});

test('when the thread record cannot take the first message, the schedule and the message stay', async (t) => {
  const { f, slack, member, teamId } = await harness(t, 'dm-unrecorded');
  f.config.putSlackPublicContext = () => { throw new Error('state down'); };
  assert.equal(structured(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'unrecorded' })).status, 'done');
  assert.equal(slack.calls.started.length, 1);
  assert.deepEqual(slack.calls.withdrawn, [], 'its runs post in that thread, so its first message stays');
  assert.equal((await f.routines.listRoutines(teamId)).length, 1);
});

test('save_schedule refuses any DM Slack would not let the caller schedule in, and posts nothing', async (t) => {
  const { f, slack, member, owner, teamId } = await harness(t, 'dm-refuse');

  // The Owner may edit the Agent, but only its creator may DM it while it is in no Channel.
  const notTheirs = errorOf(await owner('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'owner-dm' }), 'not_allowed');
  assert.match(String(notTheirs.message), /not available/);
  assert.equal(slack.calls.started.length, 0);

  const someoneElse = await owner('save_schedule', { ...DM_SCHEDULE, dm: f.member.user.slackUserId, idempotencyKey: 'other-dm' });
  assert.equal(someoneElse.isError, true, 'dm names only "me"');

  const both = errorOf(await member('save_schedule', { ...DM_SCHEDULE, channelId: 'C_SUPPORT', idempotencyKey: 'both' }), 'invalid_input');
  assert.equal(both.message, 'Send channelId or dm, not both: a schedule posts in one place.');
  const neither = errorOf(await member('save_schedule', { ...DM_SCHEDULE, dm: undefined, idempotencyKey: 'neither' }), 'invalid_input');
  assert.equal(neither.message, 'A new schedule needs where it posts, a channelId or dm: "me", and a time: cron, once or inMinutes.');

  errorOf(await member('save_schedule', { ...DM_SCHEDULE, when: { cron: '61 9 * * *' }, idempotencyKey: 'bad-cron' }), 'invalid_input');
  errorOf(await member('save_schedule', { ...DM_SCHEDULE, when: { once: '2020-01-01T09:00' }, idempotencyKey: 'past' }), 'invalid_input');
  assert.equal(slack.calls.started.length, 0, 'a timing the save refuses posts nothing');

  errorOf(await member('save_schedule', {
    ...DM_SCHEDULE, requiredConnections: ['conn_missing'], idempotencyKey: 'missing-connection',
  }), 'invalid_input');
  // The tool takes a longer name than a schedule keeps.
  errorOf(await member('save_schedule', { ...DM_SCHEDULE, name: 'Morning check '.repeat(8), idempotencyKey: 'long-name' }), 'invalid_input');
  assert.equal(slack.calls.started.length, 0, 'a connection or text the save refuses posts nothing');

  // Refused after its first message, here because the Agent was turned off
  // in between: the message goes, and no schedule stays.
  slack.hooks.afterStart = () => f.config.updateAgent('agent_research', { enabled: false });
  assert.equal((await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'turned-off' })).isError, true);
  delete slack.hooks.afterStart;
  await f.config.updateAgent('agent_research', { enabled: true });
  assert.equal(slack.calls.started.length, 1);
  assert.deepEqual(slack.calls.withdrawn, [{ conversationId: `D_${f.member.user.slackUserId}`, threadTs: THREAD_TS }]);
  assert.deepEqual(await f.routines.listRoutines(teamId), []);
  assert.deepEqual(await f.config.listSlackPublicContext(teamId, `D_${f.member.user.slackUserId}`, THREAD_TS), [],
    'nor does the thread record keep it');

  // Only the 5.0 door builds it: the 4.x schemas refuse it, and the service refuses it from Slack.
  const fromSlack: ManagementOperation = {
    itemId: 'save', kind: 'save_routine', agentId: 'agent_research', workspaceId: teamId,
    destination: { kind: 'initiator_dm' }, requiredConnectionAccountIds: [],
    name: 'Morning check', description: '', taskText: 'Summarize.',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5' }, timezone: 'UTC', outputPolicy: 'post',
  };
  assert.equal(managementOperationZodSchema.safeParse(fromSlack).success, false);
  assert.equal(v.safeParse(managementOperationValibotSchema, fromSlack).success, false);
  const slackApply = await f.service.applyWorkspaceChanges({
    context: chickpeaDm(f, f.member), idempotencyKey: 'from-slack', operations: [fromSlack],
  });
  assert.ok('outcomes' in slackApply);
  assert.equal(slackApply.outcomes[0]?.disposition, 'failed', JSON.stringify(slackApply.outcomes));
  assert.equal(slack.calls.started.length, 1);
});

const TRY_AGAIN = 'Slack could not post in your DM, so the schedule was not saved. Try again.';
const RECONNECT = 'Chickpea\'s Slack connection needs to be reconnected in Admin, so the schedule was not saved. Save it again after that.';
const DM_REFUSED = 'Slack would not let Chickpea post in your DM, so the schedule was not saved. A schedule in a Channel can still post.';
const NO_RETRY = 'Retrying will not help, and neither will opening the DM in Slack. Tell the person what the message says to do.';

/** A Slack Web API rejection, as the Slack SDK throws it. */
function slackRejects(error: string): Error {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: 'slack_webapi_platform_error', data: { ok: false, error },
  });
}

test('when Slack cannot open the DM, nothing is posted or saved, and it is retryable only when a retry can work', async (t) => {
  const cases: Array<{ error: unknown; reasonCode: string; retryable: boolean; message: string }> = [
    { error: new Error('socket hang up'), reasonCode: 'unknown', retryable: true, message: TRY_AGAIN },
    { error: slackRejects('ratelimited'), reasonCode: 'ratelimited', retryable: true, message: TRY_AGAIN },
    {
      error: new SlackInstallationUnavailableError('T1', 'credential_resolution_failed', { retryable: true }),
      reasonCode: 'credential_resolution_failed', retryable: true, message: TRY_AGAIN,
    },
    {
      error: new SlackInstallationUnavailableError('T1', 'installation_revoked'),
      reasonCode: 'installation_revoked', retryable: false, message: RECONNECT,
    },
    {
      error: new SlackInstallationUnavailableError('T1', 'credentials_missing'),
      reasonCode: 'credentials_missing', retryable: false, message: RECONNECT,
    },
    { error: slackRejects('token_revoked'), reasonCode: 'token_revoked', retryable: false, message: RECONNECT },
    { error: slackRejects('user_not_found'), reasonCode: 'user_not_found', retryable: false, message: DM_REFUSED },
    // The shared gateway's own failures: one it marks retryable can pass, and a refusal it relays from Slack stays.
    {
      error: new SlackTransportError('conversations.open', 'gateway_unreachable', { retryable: true }),
      reasonCode: 'gateway_unreachable', retryable: true, message: TRY_AGAIN,
    },
    {
      error: new SlackTransportError('conversations.open', 'gateway_rate_limited', { retryable: true, retryAfterMs: 1_000 }),
      reasonCode: 'gateway_rate_limited', retryable: true, message: TRY_AGAIN,
    },
    {
      error: new SlackTransportError('conversations.open', 'user_not_found', { retryable: false }),
      reasonCode: 'user_not_found', retryable: false, message: DM_REFUSED,
    },
  ];
  for (const [index, expected] of cases.entries()) {
    const warnings = captureWarnings(t);
    const { f, slack, member, teamId } = await harness(t, `dm-down-${index}`, fakeSlack({ openError: expected.error }));
    const down = errorOf(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'down' }), 'slack_unavailable');
    assert.equal(down.message, expected.message, expected.reasonCode);
    assert.equal(down.retryable, expected.retryable, expected.reasonCode);
    assert.equal(down.nextStep, expected.retryable ? undefined : NO_RETRY, expected.reasonCode);
    assert.equal(slack.calls.started.length, 0);
    assert.deepEqual(await f.routines.listRoutines(teamId), []);
    assert.ok(warnings.some((line) => line.startsWith('[chickpea:management] schedule DM did not open') &&
      line.includes(`"reasonCode":"${expected.reasonCode}"`)), `the log names why: ${warnings.join('\n')}`);
  }
});

const HOSTED_BOT_TOKEN = 'xoxb-hosted-dm-schedule';

/**
 * Slack's Web API as a hosted installation's bot reaches it: every call
 * names the bot token it came with, and a DM opens as the person's own.
 */
function hostedSlackApi(t: TestContext, teamId: string) {
  const calls: Array<{ method: string; token: string; body: Record<string, string> }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    assert.equal(url.hostname, 'slack.com', `only Slack is called: ${url.href}`);
    const method = url.pathname.split('/').at(-1)!;
    const text = await request.text();
    const body = Object.fromEntries(new URLSearchParams(text));
    calls.push({ method, token: request.headers.get('authorization') ?? '', body });
    switch (method) {
      case 'auth.test':
        return Response.json({ ok: true, team_id: teamId, user_id: 'UCHICKPEA1', app_id: 'ACHICKPEA1', bot_id: 'BCHICKPEA1' });
      case 'conversations.open':
        return Response.json({ ok: true, channel: { id: `D_${body.users}`, is_im: true } });
      case 'chat.postMessage':
        return Response.json({ ok: true, channel: body.channel, ts: THREAD_TS });
      default:
        return Response.json({ ok: false, error: 'unknown_method' });
    }
  });
  return calls;
}

/**
 * Chickpea Cloud: a deployment serving many installations, whose Slack
 * workspace installed Chickpea's hosted app, so its bot token lives in the
 * deployment's encrypted credential store and its installation is direct.
 * The service is the one the MCP route builds, with its own Slack.
 */
async function hostedHarness(t: TestContext, suffix: string, options: { botToken: boolean }) {
  const restore = Object.fromEntries(['CHICKPEA_TENANCY', 'SLACK_STATE_DB_PATH', 'SLACK_API_URL', 'SLACK_BOT_TOKEN']
    .map((name) => [name, process.env[name]]));
  process.env.CHICKPEA_TENANCY = 'installation';
  process.env.SLACK_STATE_DB_PATH = ':memory:';
  delete process.env.SLACK_API_URL;
  delete process.env.SLACK_BOT_TOKEN;
  const keyring = useDeploymentKeyring(t);
  const f = await authorityFixture(suffix);
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    f.close();
    settings.close();
    invalidateSlackInstallationCredentialCache();
    resetIdentityVerificationsForTests();
    for (const [name, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: `inst_${suffix}` }) as PlatformEnv;
  const credentials = { state: f.identity, keyring };
  if (options.botToken) {
    await writeHostedSlackBotCredentials(credentials, null, {
      botToken: HOSTED_BOT_TOKEN, botUserId: 'UCHICKPEA1', appId: 'ACHICKPEA1', teamId: f.workspaceId,
      grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES], validatedAt: NOW,
    });
  }
  assert.equal((await f.config.getWorkspaceInstallation(f.workspaceId))?.transportMode, 'direct');
  await createAgent(f, f.member, 'agent_research', { name: 'Research' });
  const service = createLiveWorkspaceManagementService(env, {
    identity: f.identity,
    settings,
    slackCredentials: credentials,
    overrides: {
      config: f.config,
      management: f.management,
      routines: f.routines,
      routineSchedulingAvailable: true,
      setupBaseUrl: 'http://localhost',
      now: () => NOW,
    },
  });
  return { f, member: mcpCaller(service, f.member, 'member', suffix), teamId: f.workspaceId };
}

test('on Chickpea Cloud, save_schedule with dm "me" opens the caller\'s DM as the installation\'s bot, posts its first message as the Agent and saves', async (t) => {
  const warnings = captureWarnings(t);
  const { f, member, teamId } = await hostedHarness(t, 'hosted-dm', { botToken: true });
  const slack = hostedSlackApi(t, teamId);
  const dm = `D_${f.member.user.slackUserId}`;

  const created = structured(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'hosted-dm' }));
  assert.equal(created.status, 'done', JSON.stringify(created));
  assert.equal(created.summary, 'Created the schedule. Every run posts in one thread in your DM with Research, which it just started.');

  const opened = slack.filter(({ method }) => method === 'conversations.open').map(({ body }) => body.users);
  assert.ok(opened.length > 0);
  assert.deepEqual([...new Set(opened)], [f.member.user.slackUserId], 'the DM is the signed-in person\'s own');
  const posted = slack.filter(({ method }) => method === 'chat.postMessage');
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.body.channel, dm);
  assert.equal(posted[0]!.body.username, 'Research', 'the first message is the Agent\'s');
  assert.equal(posted[0]!.body.text, 'I\'ll post *Morning check* in this thread when it runs.');
  assert.deepEqual([...new Set(slack.map(({ token }) => token))], [`Bearer ${HOSTED_BOT_TOKEN}`],
    'every Slack call is the hosted installation\'s own bot');

  const [routine, ...others] = await f.routines.listRoutines(teamId, dm);
  assert.deepEqual(others, []);
  assert.deepEqual(routine?.destination, {
    kind: 'direct_thread', conversationId: dm, threadTs: THREAD_TS, ownerMembershipId: f.member.membership.id,
  });
  assert.equal(routine.state, 'active');
  assert.equal((await f.config.getAgentThreadRoute(teamId, dm, THREAD_TS))?.agentId, 'agent_research');
  assert.deepEqual((await f.config.listSlackPublicContext(teamId, dm, THREAD_TS))
    .map(({ messageTs, role, agentId }) => ({ messageTs, role, agentId })),
  [{ messageTs: THREAD_TS, role: 'agent', agentId: 'agent_research' }], 'the thread records its first message as the Agent\'s');
  assert.deepEqual(warnings.filter((line) => line.includes('schedule')), []);
});

test('on Chickpea Cloud, an installation with no bot token refuses a DM schedule for good, and says what to do', async (t) => {
  const warnings = captureWarnings(t);
  const { f, member, teamId } = await hostedHarness(t, 'hosted-dm-no-bot', { botToken: false });
  const slack = hostedSlackApi(t, teamId);

  const refused = errorOf(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'no-bot' }), 'slack_unavailable');
  assert.equal(refused.message, RECONNECT);
  assert.equal(refused.retryable, false);
  assert.equal(refused.nextStep, NO_RETRY);
  assert.deepEqual(slack.filter(({ method }) => method !== 'auth.test'), [], 'nothing is opened or posted');
  assert.deepEqual(await f.routines.listRoutines(teamId), []);
  assert.ok(warnings.some((line) => line.startsWith('[chickpea:management] schedule DM did not open') &&
    line.includes('"reasonCode":"credentials_missing"')), warnings.join('\n'));
});
