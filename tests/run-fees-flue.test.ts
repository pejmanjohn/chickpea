import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { normalizeContext, type JsonObject } from '@earendil-works/pi-ai';
import { init, instrument, useModel, useTool, type FlueExecutionInterceptor } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { resolveRepositoryAccess, runtimePlanRepositoryShell } from '../src/agents/slack-thread.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { RepositoryGrant } from '../src/config/types.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  withModelAccess,
  withModelRequestPurpose,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type DailyLimitAdmission,
  type FeeOutcome,
  type FeePost,
  type OutOfUsage,
  type RunRef,
} from '../src/config/platform-funding.ts';
import { buildSemanticActivityContext, registerActivityContext } from '../src/activity/status.ts';
import { readWebPage } from '../src/web/page.ts';
import { createWebTools, webRequest } from '../src/web/tools.ts';
import type { WebSearchProvider } from '../src/web/search.ts';
import { createWebTurn, WEB_READS_PER_TURN, WEB_SEARCHES_PER_TURN, type WebTurnState } from '../src/web/turn.ts';
import { genericSemanticDescriptor } from '../src/activity/semantic.ts';
import { runFeeInterceptor } from '../src/config/run-fee-interceptor.ts';
import { CHICKPEA_TEST_TURN_AGENT_NAME } from '../src/agents/names.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import { SlackCanvasService } from '../src/slack/canvases/service.ts';
import { createSlackCanvasTools } from '../src/slack/canvases/tools.ts';
import type { SlackCanvasOperation } from '../src/slack/canvases/types.ts';
import { AgentPromptFailure, agentFailureText, promptSlackThreadAgent } from '../src/slack/flue-dispatch.ts';
import {
  CHANNEL_CREATE_RECEIPT_CODEC,
  SlackChannelCreateService,
  type ChannelCreateReceipt,
} from '../src/slack/channel-creation/service.ts';
import { createSlackCreateChannelTool } from '../src/slack/channel-creation/tools.ts';
import { GroupDmReceipts } from '../src/slack/group-dm/receipts.ts';
import { SlackGroupDmService } from '../src/slack/group-dm/service.ts';
import { createSlackGroupDmTool } from '../src/slack/group-dm/tools.ts';
import { textCell } from '../src/slack/lists/schema.ts';
import { SlackListsService } from '../src/slack/lists/service.ts';
import { createSlackListTools } from '../src/slack/lists/tools.ts';
import { SlackListError } from '../src/slack/lists/types.ts';
import { ListWriteLedger } from '../src/slack/lists/writes.ts';
import { createSlackReadGate } from '../src/slack/read-budget.ts';
import { SlackReadingService } from '../src/slack/reading/service.ts';
import { RequestReceipt } from '../src/slack/requested-conversations/receipts.ts';
import { createSlackReadingTools } from '../src/slack/reading/tools.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { fundingRefusalText } from '../src/slack/credits-ask.ts';
import type { RunKind } from '../src/usage/run-fees.ts';
import { withEnv } from './helpers/env.ts';
import { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } from './helpers/platform-funding.ts';
import { answers, callsTools, SCRIPTED_MODEL, scriptedMessage, scriptedProvider } from './helpers/scripted-provider.ts';
import { LIST_URL, StrictListsFake } from './helpers/slack-lists.ts';

const INSTALLATION = 'inst_fees';

function hostedEnv(): PlatformEnv {
  return scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: INSTALLATION }) as PlatformEnv;
}

function ownKeyGrant(runId: string): ModelAccessGrant {
  return {
    installationId: INSTALLATION, providerId: 'anthropic', runId, fundingSource: 'customer',
    credentialRefId: 'cred_anthropic', credentialVersion: 1,
  };
}

/** Each run the port was asked to admit a task for. */
const admissions: RunRef[] = [];
/** Admission answers, fee posts and tool runs, in the order they happened. */
const timeline: string[] = [];
/** Long enough that parallel calls are all waiting on the answer when it arrives. */
const ADMISSION_DELAY_MS = 20;

function hostedPort(
  t: TestContext,
  options: {
    refuse?: FeePost['tier'];
    fail?: FeePost['tier'];
    stall?: FeePost['tier'];
    admission?: 'refused' | 'stall' | 'fail' | 'stop' | 'malformed' | 'pending' | DailyLimitAdmission | OutOfUsage;
    /** The cause a refused task row gives. */
    postRefusal?: OutOfUsage['cause'];
    port?: boolean;
  } = {},
) {
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  configureInstallationAdmission(async () => 'admitted');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-run-fee-test-key' }) });
  const posts: Array<FeePost & { outcome: FeeOutcome['kind'] | 'failed' }> = [];
  const rows = new Set<string>();
  admissions.length = 0;
  timeline.length = 0;
  if (options.port !== false) {
    configurePlatformFunding({
      ...EVERY_PROVIDER_FUNDED,
      ...NO_RUN_FEES,
      funding: async () => 'customer',
      admit: async () => 'admitted',
      charge: async () => {},
      admitTask: async (run) => {
        admissions.push(run);
        if (options.admission === 'stall') return new Promise<never>(() => {});
        if (options.admission === 'fail') throw new Error('ledger unavailable');
        if (options.admission === 'malformed') return { kind: 'daily_limit', scope: 'workspace', resumesAt: Number.NaN };
        if (options.admission === 'pending') return 'pending';
        if (options.admission === 'stop') {
          await stopTurn();
          timeline.push('admit:admitted');
          return 'admitted';
        }
        await new Promise((resolve) => setTimeout(resolve, ADMISSION_DELAY_MS));
        const answer = options.admission ?? 'admitted';
        timeline.push(`admit:${typeof answer === 'string' ? answer : answer.kind}`);
        return answer;
      },
      postFee: async (post) => {
        if (post.tier === options.stall) {
          posts.push({ ...post, outcome: 'failed' });
          return new Promise<never>(() => {});
        }
        if (post.tier === options.fail) {
          posts.push({ ...post, outcome: 'failed' });
          throw new Error('ledger unavailable');
        }
        const key = `${post.installationId}:${post.runId}:${post.tier}`;
        const outcome = post.tier === options.refuse ? 'refused' : rows.has(key) ? 'duplicate' : 'posted';
        if (outcome === 'posted') rows.add(key);
        posts.push({ ...post, outcome });
        timeline.push(`${post.tier}:${outcome}`);
        return outcome === 'refused' && options.postRefusal ? { kind: outcome, cause: options.postRefusal } : { kind: outcome };
      },
    });
  }
  t.after(() => {
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  return posts;
}

function interceptors(
  t: TestContext,
  lookup: (runId: string | undefined) => AttemptModelAccess,
  beforeRunFees?: FlueExecutionInterceptor,
) {
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => lookup(context.submissionId),
    installationGrants: async () => [],
  });
  t.after(instrument({ key: Symbol('model-access'), interceptor: modelAccess, observe() {}, dispose() {} }));
  if (beforeRunFees) t.after(instrument({ key: Symbol('before-run-fees'), interceptor: beforeRunFees, observe() {}, dispose() {} }));
  t.after(instrument({ key: Symbol('run-fees'), interceptor: runFeeInterceptor, observe() {}, dispose() {} }));
}

const ran: string[] = [];

function FeeProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  for (const name of ['read_slack_channel', 'read_slack_thread']) {
    useTool({
      name,
      description: `The synthetic ${name}.`,
      input: v.object({}),
      output: v.string(),
      run: () => {
        ran.push(name);
        timeline.push(`tool:${name}`);
        return { output: JSON.stringify({ status: 'ok' }) };
      },
    });
  }
  useTool({
    name: 'create_slack_list_item',
    description: 'The synthetic create_slack_list_item, still working when the turn is stopped.',
    input: v.object({}),
    output: v.string(),
    run: () => {
      ran.push('create_slack_list_item');
      void stopTurn();
      return new Promise<never>(() => {});
    },
  });
  useTool({
    name: 'read_slack_list',
    description: 'The synthetic read_slack_list, which fails after it does its work.',
    input: v.object({}),
    output: v.string(),
    run: () => {
      ran.push('read_slack_list');
      throw new Error('Slack answered with an unreadable response.');
    },
  });
  return 'Use the scripted tools.';
}

const MENTION = { workspaceId: 'T0FEES', channelId: 'C0FEES', threadTs: '1000.000100', messageTs: '1000.000100' };
const slackHistoryCalls: unknown[] = [];
const readBudgetDecisions: boolean[] = [];
const grantChecks: string[] = [];
/** A channel the requester belongs to but this Agent was never added to. */
const UNGRANTED_CHANNEL = 'C0UNGRANTED';

/** The real Slack read tools on a shared app, paced at one read a minute. */
function ChannelMentionProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  const budget = createSlackReadGate({ state: undefined, workspaceId: MENTION.workspaceId, gated: true });
  const service = new SlackReadingService({
    client: { conversations: { history: async (args: unknown) => { slackHistoryCalls.push(args); return { ok: true, messages: [] }; } } } as never,
    gate: {
      ...budget,
      reserve: async (method) => {
        const decision = await budget.reserve(method);
        readBudgetDecisions.push(decision.ok);
        return decision;
      },
    },
    authority: {
      workspaceId: MENTION.workspaceId, managementAgent: false, requesterSlackUserId: 'U_REQUESTER', current: MENTION,
      assertActive: async () => {},
      conversation: async (id) => ({ id, teamId: MENTION.workspaceId, im: false, mpim: false, private: false, member: true, shared: false }),
      isMember: async () => true,
      hasActiveGrant: async (id) => { grantChecks.push(id); return id !== UNGRANTED_CHANNEL; },
    },
    self: { botUserId: 'U_BOT' },
  });
  for (const tool of createSlackReadingTools(async () => service)) useTool(tool);
  return 'Read the channel.';
}

const readsChannel = (channel: string) => (model: Parameters<typeof answers>[0]) => scriptedMessage(model, [
  { type: 'toolCall', id: 'call_read_channel', name: 'read_slack_channel', arguments: { channel } },
], 'toolUse');

const groupDmCalls: string[] = [];

function GroupDmProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  const record = (method: string, answer: Record<string, unknown>) => async () => {
    groupDmCalls.push(method);
    return { ok: true, ...answer };
  };
  useTool(createSlackGroupDmTool((people, message) => new SlackGroupDmService({
    workspaceId: MENTION.workspaceId,
    requesterSlackUserId: 'U_REQUESTER',
    requesterText: 'start a group DM with <@U0SAM>',
    requesterTextSource: undefined,
    currentConversation: {
      current: { channelId: 'D_REQUESTER', threadTs: '1000.000100', messageTs: '1000.000100' },
      conversation: async (id) => ({ id, im: true, mpim: false, private: false, member: true, shared: false }),
    },
    chickpeaBot: {
      users: { info: record('users.info', { user: { id: 'U0SAM', team_id: MENTION.workspaceId } }) },
      conversations: { open: record('conversations.open', { channel: { id: 'C0GROUP' } }) },
      chat: { postMessage: record('chat.postMessage', { channel: 'C0GROUP', ts: '1000.000200' }) },
    } as never,
    persona: { username: 'Fee Agent' },
    assertStanding: async () => {},
    receipts: new GroupDmReceipts(new SqliteSettingsStore(':memory:'), `fees-group-dm-${groupDmCalls.length}`),
    routeRepliesToAgent: async () => {},
  }).start(people, message)));
  return 'Start the group DM.';
}

const startsGroupDm = (person: string) => (model: Parameters<typeof answers>[0]) => scriptedMessage(model, [
  { type: 'toolCall', id: 'call_group_dm', name: 'start_slack_group_dm', arguments: { people: [person], message: 'Hello' } },
], 'toolUse');

const channelCalls: string[] = [];

function CreateChannelProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  const record = (method: string, answer: Record<string, unknown>) => async () => {
    channelCalls.push(method);
    return { ok: true, ...answer };
  };
  useTool(createSlackCreateChannelTool((request) => new SlackChannelCreateService({
    workspaceId: MENTION.workspaceId,
    requesterSlackUserId: 'U_REQUESTER',
    requesterText: 'make a channel for the launch with <@U0SAM>',
    requesterTextSource: undefined,
    currentConversation: {
      current: { channelId: 'D_REQUESTER', threadTs: '1000.000100', messageTs: '1000.000100' },
      conversation: async (id) => ({ id, im: true, mpim: false, private: false, member: true, shared: false }),
    },
    chickpeaBot: {
      users: { info: record('users.info', { user: { id: 'U0SAM', team_id: MENTION.workspaceId } }) },
      conversations: {
        create: record('conversations.create', { channel: { id: 'C0LAUNCH' } }),
        invite: record('conversations.invite', {}),
      },
      chat: { postMessage: record('chat.postMessage', { channel: 'C0LAUNCH', ts: '1000.000200' }) },
    } as never,
    persona: { username: 'Fee Agent' },
    assertStanding: async () => {},
    receipt: new RequestReceipt<ChannelCreateReceipt>(
      new SqliteSettingsStore(':memory:'), `fees-channel-${channelCalls.length}`, CHANNEL_CREATE_RECEIPT_CODEC,
    ),
    routeRepliesToAgent: async () => {},
    agentAccess: async () => ({ status: 'not_needed' }),
  }).create(request)));
  return 'Create the channel.';
}

const createsChannel = (person: string) => (model: Parameters<typeof answers>[0]) => scriptedMessage(model, [
  { type: 'toolCall', id: 'call_create_channel', name: 'create_slack_channel', arguments: { name: 'launch', people: [person], message: 'Hello' } },
], 'toolUse');

const DOCS = 'https://docs.fees.example/api';
const LOGO = 'https://docs.fees.example/logo.png';
const DOWN = 'https://docs.fees.example/down';
/** The requester's message: the docs, an image, a page that is down and a local address, each typed. */
const DOCS_ASKED = `connect the Fees API, docs at <${DOCS}>, logo at <${LOGO}>, status at <${DOWN}>, mirror at <https://localhost/docs>`;
/** URLs the synthetic web was asked for. */
const fetched: string[] = [];
const docsWeb = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { url } = new Request(input, init);
  fetched.push(url);
  if (url === DOCS) return new Response('<h1>Fees API</h1><p>GET /v1/fees lists fees.</p>', { headers: { 'content-type': 'text/html' } });
  if (url === DOWN) return new Response('error code: 1016', { status: 530, headers: { 'content-type': 'text/plain' } });
  return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
}) as typeof fetch;
/** The web state the probe's turn starts from. */
let webTurnStart: WebTurnState = { turnKey: 'fees-web', reads: 0, searches: 0, sourced: [] };
/** Queries that reached the stub search service, and whether it answers. */
const searched: string[] = [];
let searchAnswers = true;
const searchService: WebSearchProvider = {
  async search(query) {
    searched.push(query);
    if (!searchAnswers) throw new Error('search service down');
    return [{ url: 'https://docs.fees.example/api', title: 'Fees API', text: 'GET /v1/fees lists fees.' }];
  },
};

/** The web tools as a turn mounts them, over the synthetic web, answering the requester's message. */
function WebProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  const turn = createWebTurn('fees-web', webTurnStart);
  for (const tool of createWebTools({
    turn,
    request: webRequest(DOCS_ASKED),
    agentSpaces: [],
    readPage: (url) => readWebPage(url, { cloudflare: true, fetch: docsWeb }),
    searchProvider: async () => searchService,
  })) useTool(tool);
  return 'Read the docs.';
}

const readsPage = (url: string) => (model: Parameters<typeof answers>[0]) => scriptedMessage(model, [
  { type: 'toolCall', id: 'call_read_page', name: 'read_web_page', arguments: { url } },
], 'toolUse');

const searches = (query: string) => (model: Parameters<typeof answers>[0]) => scriptedMessage(model, [
  { type: 'toolCall', id: 'call_search', name: 'web_search', arguments: { query } },
], 'toolUse');

const canvasCalls: SlackCanvasOperation[] = [];
let canvasAnswers: Partial<Record<SlackCanvasOperation, JsonObject>> = {};
let canvasConversation: 'channel with a canvas' | 'channel' | 'dm' = 'channel with a canvas';
const CANVAS_WRITES: readonly SlackCanvasOperation[] = ['conversations.canvases.create', 'canvases.create', 'canvases.edit'];
let accessRevoked = false;

function assertAccess(): void {
  if (accessRevoked) throw new SlackListError('actor_unavailable', 'The requester no longer has active Chickpea access.');
}

function CanvasProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  const current = { ...MENTION, channelId: canvasConversation === 'dm' ? 'D0FEES' : MENTION.channelId };
  for (const tool of createSlackCanvasTools(async () => {
    assertAccess();
    return new SlackCanvasService({
      workspaceId: MENTION.workspaceId,
      botUserId: 'U_BOT',
      call: async (method, input) => {
        canvasCalls.push(method);
        const answer = canvasAnswers[method];
        if (answer) return answer;
        if (method === 'files.info') return { ok: true, file: { id: input.file, user: 'U_BOT', linked_channel_id: MENTION.channelId } };
        if (method === 'canvases.sections.lookup') return { ok: true, sections: [] };
        return { ok: true, canvas_id: 'FNEW1' };
      },
      authority: {
        workspaceId: MENTION.workspaceId, managementAgent: false, requesterSlackUserId: 'U_REQUESTER', current,
        assertActive: async () => {},
        conversation: async (id) => ({
          id, teamId: MENTION.workspaceId, im: canvasConversation === 'dm', mpim: false, private: false, member: true, shared: false,
          ...(canvasConversation === 'channel' ? {} : { canvasIds: ['FCHANNEL'] }),
        }),
        isMember: async () => true,
        hasActiveGrant: async () => true,
      },
      ledger: new ListWriteLedger(new SqliteSettingsStore(':memory:'), MENTION.workspaceId, 'fees-canvas', 'canvas'),
      hosted: true,
    });
  })) useTool(tool);
  return 'Write the canvas.';
}

let listsSlack = new StrictListsFake();
let listsSettings = new SqliteSettingsStore(':memory:');
let listsAdmitted: string[] = [];

function ListsProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  for (const tool of createSlackListTools(async () => {
    assertAccess();
    return new SlackListsService({
      workspaceId: 'TWORK',
      call: listsSlack.call,
      ledger: new ListWriteLedger(listsSettings, 'TWORK', 'fees-lists'),
      admittedListIds: listsAdmitted,
      hosted: true,
    });
  })) useTool(tool);
  return 'Change the List.';
}

function freshLists(admitted = true): StrictListsFake {
  listsSlack = new StrictListsFake();
  listsSlack.lists.get('FEXISTING')!.items.push({ id: 'RecFEES', list_id: 'FEXISTING', fields: [textCell('ColTITLE', 'Send the invoice')] });
  listsSettings = new SqliteSettingsStore(':memory:');
  listsAdmitted = admitted ? ['FEXISTING'] : [];
  return listsSlack;
}

const LIST_WRITES = [
  ['create_slack_list_item', { listUrl: LIST_URL, title: 'Send the invoice' }, 'slackLists.items.create'],
  ['update_slack_list_item', { listUrl: LIST_URL, itemId: 'RecFEES', set: { completed: true } }, 'slackLists.items.update'],
  ['create_slack_task_list', { name: 'Launch' }, 'slackLists.create'],
  ['share_slack_list', { listUrl: LIST_URL, access: 'view', channelId: 'C0SHARE' }, 'slackLists.access.set'],
] as const;

const LIST_READS = [
  ['read_slack_list', { listUrl: LIST_URL }],
  ['read_slack_list_item', { listUrl: LIST_URL, itemId: 'RecFEES' }],
] as const;

const isListWrite = (method: string) => LIST_WRITES.some(([, , write]) => write === method);

type ListCase = readonly [tool: string, args: JsonObject, setUp: () => unknown, expected: string];

const callsTool = (name: string, args: JsonObject) => (model: Parameters<typeof answers>[0]) => scriptedMessage(model, [
  { type: 'toolCall', id: `call_${name}`, name, arguments: args },
], 'toolUse');

const toolResults: Array<{ status?: unknown; code?: unknown }> = [];
const recordsResults: FlueExecutionInterceptor = async (operation, _context, next) => {
  const result = await next();
  if (operation.type === 'tool') toolResults.push(JSON.parse(String((result as { details?: { output?: unknown } }).details?.output)));
  return result;
};

/** Stops the turn `slackTurn` is running as a requester's stop does: Flue aborts the instance's work. */
let stopTurn: () => Promise<void> = async () => {
  throw new Error('No turn is running.');
};

async function slackTurn(id: string, probe: typeof FeeProbe = FeeProbe): Promise<{ text: string } | unknown> {
  const runtime = await start({
    agents: [{ agent: probe, name: 'fee-probe' }],
    providers: [registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!],
  });
  try {
    const agent = init(probe, { id });
    stopTurn = () => agent.abort();
    const receipt = await agent.dispatch('Hello');
    return await promptSlackThreadAgent({
      handle: agent, message: 'unused saved dispatch', turnId: id,
      conversationKey: 'T_FIXTURE:C_FIXTURE:1',
      requestedModel: `anthropic/${SCRIPTED_MODEL}`,
      state: {
        dispatchEnvelope: { instanceId: id } as FlueDispatchEnvelopeV1,
        dispatchReceipt: receipt,
        prepare: () => { throw new Error('Must reuse saved dispatch'); },
        reconcileExistingInstance: () => { throw new Error('Must reuse saved instance'); },
        recordReceipt: (value) => value,
        recordSettlement: (value) => value,
        markRecoveryRequired: () => {},
      },
    }).then((result) => ({ text: result.text }), (error: unknown) => error);
  } finally {
    await runtime.stop();
  }
}

/** A GitHub App this process can sign installation-token requests for. */
async function withGithubApp<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-run-fees-github-'));
  const dbPath = join(dir, 'state.db');
  const settings = new SqliteSettingsStore(dbPath);
  try {
    await settings.setSetting(GITHUB_SETTING_KEYS.appId, 'run-fees-app');
    await settings.setSetting(GITHUB_SETTING_KEYS.privateKey, String(
      generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ));
    return await withEnv({ SLACK_STATE_DB_PATH: dbPath, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }, run);
  } finally {
    settings.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFetch<T>(answer: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = answer;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const tiers = (posts: ReadonlyArray<{ tier: string; outcome: string }>) => posts.map(({ tier, outcome }) => `${tier}:${outcome}`);
const admissionAnswers = () => timeline.filter((entry) => entry.startsWith('admit:'));
const replyRun = (env: PlatformEnv | undefined, runKind: RunKind = 'interactive') =>
  (runId: string | undefined): AttemptModelAccess => ({ env, grant: ownKeyGrant(runId!), agentId: 'agent_fees', runKind });

test('an own-key turn with nothing spendable runs no tool, not even a parallel one, and ends out of usage before another request is sent', { timeout: 20_000 }, async (t) => {
  const refusal = { kind: 'credits_exhausted', cause: { kind: 'own_key_tasks_used' } } as const;
  const posts = hostedPort(t, { admission: refusal, refuse: 'task' });
  interceptors(t, replyRun(hostedEnv()));
  const { sent } = scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-refused');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted');
  assert.equal(failure.retryable, false);
  assert.deepEqual(failure.outOfUsage, refusal, 'the host\'s cause reaches the reply');
  assert.equal(agentFailureText(failure), fundingRefusalText(refusal));
  assert.match(agentFailureText(failure), /I can still chat/);
  assert.equal(sent.length, 1, 'no provider request after the refusal');
  assert.deepEqual(ran, [], 'no tool ran');
  assert.equal(admissions.length, 1);
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('a turn at its daily limit runs no tool and ends with the daily-limit reply, not the credits one', { timeout: 20_000 }, async (t) => {
  const limit = { kind: 'daily_limit', scope: 'fleet', resumesAt: Date.UTC(2026, 10, 5) } as const;
  const posts = hostedPort(t, { admission: limit });
  interceptors(t, replyRun(hostedEnv()));
  const { sent } = scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-daily-limit');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.deepEqual([failure.kind, failure.dailyLimit, failure.retryable], ['daily-limit', limit, false]);
  assert.equal(agentFailureText(failure), fundingRefusalText(limit));
  assert.equal(sent.length, 1, 'no provider request after the refusal');
  assert.deepEqual(ran, [], 'no tool ran');
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('parallel qualifying calls wait on one admission, then both run and post one task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  const entered: FlueExecutionInterceptor = async (operation, _context, next) => {
    if (operation.type === 'tool') timeline.push(`enter:${operation.toolCallId}`);
    return next();
  };
  interceptors(t, replyRun(hostedEnv()), entered);
  scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-admission-shared'), { text: 'done' });
  assert.deepEqual(timeline.filter((entry) => /^(enter|admit):/.test(entry)), [
    'enter:call_0_read_slack_channel', 'enter:call_1_read_slack_channel', 'admit:admitted',
  ], 'both calls were waiting when the one admission answered');
  assert.equal(admissions.length, 1);
  assert.deepEqual(ran, ['read_slack_channel', 'read_slack_channel']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('an admitted task runs its qualifying call, then posts the task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel'), answers]);

  assert.deepEqual(await slackTurn('fees-admitted'), { text: 'done' });
  assert.deepEqual(timeline, ['chat:posted', 'admit:admitted', 'tool:read_slack_channel', 'task:posted']);
  assert.deepEqual(admissions, [{ installationId: INSTALLATION, runId: posts[0]!.runId }], 'the port is asked about the run alone');
});

test('after an own-key post is refused, a parallel qualifying call that starts later never runs', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { refuse: 'task', postRefusal: { kind: 'own_key_no_plan', plansFromCents: 10_000 } });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  const secondStartsAfterRefusal: FlueExecutionInterceptor = async (operation, _context, next) => {
    if (operation.type === 'tool' && operation.toolCallId === 'call_1_read_slack_channel') {
      while (!posts.some(({ outcome }) => outcome === 'refused')) await tick();
      await tick();
    }
    return next();
  };
  interceptors(t, replyRun(hostedEnv()), secondStartsAfterRefusal);
  const { sent } = scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-refused-parallel');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted');
  assert.deepEqual(failure.outOfUsage?.cause, { kind: 'own_key_no_plan', plansFromCents: 10_000 });
  assert.equal(sent.length, 1, 'no provider request after the refusal');
  assert.deepEqual(ran, ['read_slack_channel'], 'only the call that started before the refusal ran');
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:refused']);
});

test('a qualifying tool that throws after doing its work posts one task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_list'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-thrown-after-work'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_list']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a stop that lands while a qualifying call waits to start posts no task row, and the call never runs', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { admission: 'stop' });
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  await slackTurn('fees-stopped-before-start');

  assert.deepEqual(admissionAnswers(), ['admit:admitted'], 'the stop landed while the call waited on its admission');
  assert.deepEqual(ran, []);
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('a stop that lands while a qualifying call is working still posts one task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('create_slack_list_item'), answers]);
  ran.length = 0;

  await slackTurn('fees-stopped-while-working');

  assert.deepEqual(ran, ['create_slack_list_item']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a channel read the Slack read budget refuses posts no task row, and Slack is never called', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([readsChannel(MENTION.channelId), answers]);
  slackHistoryCalls.length = 0;
  readBudgetDecisions.length = 0;
  const preRead = await createSlackReadGate({ state: undefined, workspaceId: MENTION.workspaceId, gated: true }).reserve('conversations.history');
  assert.equal(preRead.ok, true, 'the mention\'s history pre-read spent the minute\'s read');

  assert.deepEqual(await slackTurn('fees-read-refused', ChannelMentionProbe), { text: 'done' });
  assert.deepEqual(readBudgetDecisions, [false], 'the read budget refused the channel read');
  assert.deepEqual(slackHistoryCalls, []);
  assert.deepEqual(admissionAnswers(), ['admit:admitted'], 'the read was admitted, then charged nothing');
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('a read of a channel this Agent was never added to posts no task row, and Slack is never called', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([readsChannel(UNGRANTED_CHANNEL), answers]);
  slackHistoryCalls.length = 0;
  readBudgetDecisions.length = 0;
  grantChecks.length = 0;

  assert.deepEqual(await slackTurn('fees-read-ungranted', ChannelMentionProbe), { text: 'done' });
  assert.deepEqual(grantChecks, [UNGRANTED_CHANNEL], 'the Agent\'s channel access refused the read');
  assert.deepEqual(readBudgetDecisions, []);
  assert.deepEqual(slackHistoryCalls, []);
  assert.deepEqual(admissionAnswers(), ['admit:admitted'], 'the read was admitted, then charged nothing');
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('a group DM refused before anything is posted posts no task row, and Slack is never called', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([startsGroupDm('U0NOTNAMED'), answers]);
  groupDmCalls.length = 0;

  assert.deepEqual(await slackTurn('fees-group-dm-refused', GroupDmProbe), { text: 'done' });
  assert.deepEqual(groupDmCalls, []);
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('a group DM that posted its opening message posts the task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([startsGroupDm('U0SAM'), answers]);
  groupDmCalls.length = 0;

  assert.deepEqual(await slackTurn('fees-group-dm-posted', GroupDmProbe), { text: 'done' });
  assert.deepEqual(groupDmCalls, ['users.info', 'conversations.open', 'chat.postMessage']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a channel refused before anything is created posts no task row, and Slack is never called', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([createsChannel('U0NOTNAMED'), answers]);
  channelCalls.length = 0;

  assert.deepEqual(await slackTurn('fees-channel-refused', CreateChannelProbe), { text: 'done' });
  assert.deepEqual(channelCalls, []);
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('a channel the Agent created posts the task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([createsChannel('U0SAM'), answers]);
  channelCalls.length = 0;

  assert.deepEqual(await slackTurn('fees-channel-created', CreateChannelProbe), { text: 'done' });
  assert.deepEqual(channelCalls, ['users.info', 'conversations.create', 'conversations.invite', 'chat.postMessage']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a read_web_page refused before anything is fetched posts no task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  let output = '';
  const captureOutput: FlueExecutionInterceptor = async (operation, _context, next) => {
    const result = await next();
    if (operation.type === 'tool') output = String((result as { details?: { output?: unknown } }).details?.output);
    return result;
  };
  interceptors(t, replyRun(hostedEnv()), captureOutput);
  fetched.length = 0;
  for (const [url, reads, expected] of [
    ['https://docs.fees.example/other?page=2', 0, /may not have a query string/],
    ['https://localhost/docs', 0, /only public https pages/],
    ['not a url', 0, /pass one full https URL/],
    [DOCS, WEB_READS_PER_TURN, /already read 6 pages/],
  ] as const) {
    webTurnStart = { turnKey: 'fees-web', reads, searches: 0, sourced: [] };
    const before = posts.length;
    output = '';
    scriptedProvider([readsPage(url), answers]);
    assert.deepEqual(await slackTurn(`fees-web-refused-${posts.length}`, WebProbe), { text: 'done' });
    assert.match(output, expected, url);
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted'], `${url} posts no task row`);
  }
  assert.deepEqual(fetched, [], 'nothing was fetched');
});

test('a read_web_page that fetched posts its task row, even when it brought back no page', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  fetched.length = 0;
  for (const url of [DOCS, LOGO, DOWN]) {
    webTurnStart = { turnKey: 'fees-web', reads: 0, searches: 0, sourced: [] };
    const before = posts.length;
    scriptedProvider([readsPage(url), answers]);
    assert.deepEqual(await slackTurn(`fees-web-fetched-${posts.length}`, WebProbe), { text: 'done' });
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted', 'task:posted'], url);
  }
  assert.deepEqual(fetched, [DOCS, LOGO, DOWN]);
});

test('a web_search refused before it goes out posts no task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  let output = '';
  const captureOutput: FlueExecutionInterceptor = async (operation, _context, next) => {
    const result = await next();
    if (operation.type === 'tool') output = String((result as { details?: { output?: unknown } }).details?.output);
    return result;
  };
  interceptors(t, replyRun(hostedEnv()), captureOutput);
  searched.length = 0;
  searchAnswers = true;
  const token = ['ghp', 'synthetic0000000000000000000000000000'].join('_');
  for (const [query, searchesSpent, expected] of [
    [`why does ${token} fail`, 0, /looks like it contains a credential/],
    ['fees api pagination', WEB_SEARCHES_PER_TURN, /already ran 4 searches/],
  ] as const) {
    webTurnStart = { turnKey: 'fees-web', reads: 0, searches: searchesSpent, sourced: [] };
    const before = posts.length;
    output = '';
    scriptedProvider([searches(query), answers]);
    assert.deepEqual(await slackTurn(`fees-search-refused-${posts.length}`, WebProbe), { text: 'done' });
    assert.match(output, expected, query);
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted'], `${query} posts no task row`);
  }
  assert.deepEqual(searched, [], 'nothing reached the search service');
});

test('a web_search that went out posts its task row, even when the service failed', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  searched.length = 0;
  for (const answering of [true, false]) {
    searchAnswers = answering;
    webTurnStart = { turnKey: 'fees-web', reads: 0, searches: 0, sourced: [] };
    const before = posts.length;
    scriptedProvider([searches('fees api pagination'), answers]);
    assert.deepEqual(await slackTurn(`fees-search-sent-${posts.length}`, WebProbe), { text: 'done' });
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted', 'task:posted'], `answering: ${answering}`);
  }
  assert.deepEqual(searched, ['fees api pagination', 'fees api pagination']);
});

const CREATE_CANVAS = ['create_slack_canvas', { title: 'Brief', markdown: '# Brief' }] as const;
const APPEND_CANVAS = ['update_slack_canvas', { operation: 'append', markdown: 'More' }] as const;
const ALREADY_EXISTS = { ok: false, error: 'channel_canvas_already_exists' };

test('a canvas write refused before anything changed in Slack posts no task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()), recordsResults);
  t.after(() => { accessRevoked = false; });
  for (const [[tool, args], where, revoked, slackAnswers, code, writes] of [
    [CREATE_CANVAS, 'channel with a canvas', true, {}, 'actor_unavailable', []],
    [CREATE_CANVAS, 'dm', false, {}, 'channel_only', []],
    [CREATE_CANVAS, 'channel with a canvas', false, { 'canvases.create': { ok: false, error: 'missing_scope' } }, 'missing_scope', ['canvases.create']],
    [CREATE_CANVAS, 'channel', false, {
      'conversations.canvases.create': ALREADY_EXISTS,
      'canvases.create': { ok: false, error: 'free_teams_cannot_create_standalone_canvases' },
    }, 'free_teams_cannot_create_standalone_canvases', ['conversations.canvases.create', 'canvases.create']],
    [['update_slack_canvas', { operation: 'replace_section', markdown: 'New', sectionText: 'Missing' }], 'channel with a canvas', false, {}, 'section_not_found', []],
    [APPEND_CANVAS, 'channel with a canvas', false, { 'canvases.edit': { ok: false, error: 'canvas_editing_locked' } }, 'canvas_editing_locked', ['canvases.edit']],
  ] as const) {
    canvasConversation = where;
    accessRevoked = revoked;
    canvasAnswers = slackAnswers;
    canvasCalls.length = 0;
    toolResults.length = 0;
    const before = posts.length;
    scriptedProvider([callsTool(tool, args), answers]);
    assert.deepEqual(await slackTurn(`fees-canvas-refused-${posts.length}`, CanvasProbe), { text: 'done' });
    assert.deepEqual(toolResults.map(({ status, code }) => [status, code]), [['not_written', code]], code);
    assert.deepEqual(canvasCalls.filter((method) => CANVAS_WRITES.includes(method)), writes, `${code}: the writes sent to Slack`);
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted'], `${code} posts no task row`);
  }
});

test('a canvas write that changed Slack, or may have, posts the task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()), recordsResults);
  for (const [[tool, args], where, slackAnswers, status] of [
    [CREATE_CANVAS, 'channel', {}, 'created'],
    [CREATE_CANVAS, 'channel', { 'conversations.canvases.create': ALREADY_EXISTS }, 'created'],
    [CREATE_CANVAS, 'channel with a canvas', {}, 'created'],
    [APPEND_CANVAS, 'channel with a canvas', { 'canvases.edit': { ok: true } }, 'updated'],
    [CREATE_CANVAS, 'channel', { 'conversations.canvases.create': ALREADY_EXISTS, 'canvases.create': { ok: false, error: 'internal_error' } }, 'unverified'],
    [APPEND_CANVAS, 'channel with a canvas', { 'canvases.edit': { ok: false, error: 'fatal_error' } }, 'unverified'],
  ] as const) {
    canvasConversation = where;
    canvasAnswers = slackAnswers;
    toolResults.length = 0;
    const before = posts.length;
    scriptedProvider([callsTool(tool, args), answers]);
    assert.deepEqual(await slackTurn(`fees-canvas-written-${posts.length}`, CanvasProbe), { text: 'done' });
    assert.deepEqual(toolResults.map(({ status }) => status), [status], tool);
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted', 'task:posted'], `${tool} ${status}`);
  }
});

test('a List call refused before anything changed in Slack posts no task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()), recordsResults);
  t.after(() => { accessRevoked = false; });
  const [createItem] = LIST_WRITES;
  const refusals: Array<readonly [...ListCase, writes: readonly string[]]> = [
    [createItem[0], createItem[1], () => { freshLists(); accessRevoked = true; }, 'actor_unavailable', []],
    ...LIST_WRITES.filter(([tool]) => tool !== 'create_slack_task_list')
      .map(([tool, args]) => [tool, args, () => freshLists(false), 'list_reference_required', []] as const),
    ...LIST_WRITES.map(([tool, args, write]) => [tool, args, () => {
      const slack = freshLists();
      slack.before = async (method) => { if (method === write) slack.failure = 'no_permission'; };
    }, 'no_permission', [write]] as const),
    ...LIST_READS.map(([tool, args]) => [tool, args, () => { freshLists().failure = 'missing_scope'; }, 'missing_scope', []] as const),
  ];
  for (const [tool, args, setUp, code, writes] of refusals) {
    accessRevoked = false;
    setUp();
    toolResults.length = 0;
    const before = posts.length;
    scriptedProvider([callsTool(tool, args), answers]);
    assert.deepEqual(await slackTurn(`fees-lists-refused-${posts.length}`, ListsProbe), { text: 'done' });
    assert.deepEqual(toolResults.map(({ status, code }) => [status, code]), [['not_written', code]], `${tool} ${code}`);
    assert.deepEqual(listsSlack.calls.map(({ method }) => method).filter(isListWrite), writes, `${tool} ${code}: the writes sent to Slack`);
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted'], `${tool} ${code} posts no task row`);
  }
});

test('a List call that changed Slack, may have, or read a List posts the task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()), recordsResults);
  const [createItem, updateItem] = LIST_WRITES;
  const charged: ListCase[] = [
    ...LIST_WRITES.map(([tool, args]): ListCase => [tool, args, () => freshLists(), 'confirmed']),
    ...LIST_WRITES.map(([tool, args, write]): ListCase => [tool, args, () => {
      freshLists().after = (method, response) => method === write ? { ok: false, error: 'internal_error' } : response;
    }, 'unverified']),
    [createItem[0], createItem[1], async () => {
      freshLists();
      await new ListWriteLedger(listsSettings, 'TWORK', 'fees-lists').reserve('call_earlier_attempt', createItem[2], { list_id: 'FEXISTING' });
    }, 'already_attempted'],
    [updateItem[0], updateItem[1], () => {
      const slack = freshLists();
      slack.lists.get('FEXISTING')!.items[0]!.fields = [textCell('ColTITLE', '漢'.repeat(12_000))];
      slack.ignoreColumn = 'ColDONE';
    }, 'result_unavailable'],
    ...LIST_READS.map(([tool, args]): ListCase => [tool, args, () => freshLists(), 'read']),
  ];
  for (const [tool, args, setUp, status] of charged) {
    await setUp();
    toolResults.length = 0;
    const before = posts.length;
    scriptedProvider([callsTool(tool, args), answers]);
    assert.deepEqual(await slackTurn(`fees-lists-charged-${posts.length}`, ListsProbe), { text: 'done' });
    assert.deepEqual(toolResults.map(({ status }) => status), [status], tool);
    assert.deepEqual(tiers(posts.slice(before)), ['chat:posted', 'task:posted'], `${tool} ${status}`);
  }
});

test('a hosted reply run posts one chat row, keyed by its submission and Agent, and no task row without a qualifying tool', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_thread'), answers]);
  ran.length = 0;

  const result = await slackTurn('fees-chat');

  assert.deepEqual(result, { text: 'done' });
  assert.deepEqual(ran, ['read_slack_thread']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.tier, 'chat');
  assert.equal(posts[0]!.installationId, INSTALLATION);
  assert.equal(posts[0]!.agentId, 'agent_fees');
  assert.match(posts[0]!.runId, /^sub_/, 'the run ID is the Flue submission the request records carry');
  assert.deepEqual(admissions, [], 'a call that does not qualify asks no admission');
});

test('parallel qualifying tools in one attempt post one task row once they complete', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel', 'read_slack_thread'), callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const result = await slackTurn('fees-parallel');

  assert.deepEqual(result, { text: 'done' });
  assert.deepEqual(ran.filter((name) => name === 'read_slack_channel').length, 3);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
  assert.equal(new Set(posts.map(({ runId }) => runId)).size, 1);
  assert.equal(admissions.length, 1, 'one admission for the attempt, across its model turns');
});

test('a scheduled run posts its chat row and never a task row for a tool, even a qualifying one', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv(), 'scheduled'));
  scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-scheduled'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_channel']);
  assert.deepEqual(tiers(posts), ['chat:posted']);
  assert.equal(admissions.length, 1, 'a routine is admitted as a task once, before its first request');
});

test('a scheduled run refused as a task sends no request and ends out of usage with the host\'s cause', { timeout: 20_000 }, async (t) => {
  const refusal = { kind: 'credits_exhausted', cause: { kind: 'plan_used' } } as const;
  const posts = hostedPort(t, { admission: refusal });
  interceptors(t, replyRun(hostedEnv(), 'scheduled'));
  const { sent } = scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-scheduled-refused');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.deepEqual([failure.kind, failure.outOfUsage], ['credits-exhausted', refusal]);
  assert.deepEqual([sent.length, ran], [0, []], 'no model request and no tool');
  assert.deepEqual([admissions.length, tiers(posts)], [1, ['chat:posted']]);
});

test('a task admission the host answers pending is not taken as admitted when the host then stops answering', { timeout: 20_000 }, async (t) => {
  let now = 0;
  const posts = hostedPort(t, { admission: 'pending' });
  resetPlatformFundingForTests({ now: () => now, sleep: async (ms) => { now += ms; } });
  configurePlatformFunding({
    ...EVERY_PROVIDER_FUNDED,
    ...NO_RUN_FEES,
    funding: async () => 'customer',
    admit: async () => 'admitted',
    charge: async () => {},
    postFee: async (post) => { posts.push({ ...post, outcome: 'posted' }); return { kind: 'posted' }; },
    admitTask: async (run) => {
      admissions.push(run);
      if (admissions.length > 1) throw new Error('ledger unavailable');
      return 'pending';
    },
  });
  interceptors(t, replyRun(hostedEnv()));
  const { sent } = scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-pending');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted', 'a slow ledger admits a task, but not one whose top-up never landed');
  assert.deepEqual([sent.length, ran, admissions.length, now], [1, [], 11, 10_000]);
});

test('an attempt with no reply run, such as a coding worker\'s, posts no fee row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, (runId) => ({ env: hostedEnv(), grant: ownKeyGrant(runId!), agentId: 'agent_fees' }));
  scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-worker'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_channel']);
  assert.deepEqual(posts, []);
});

test('a task row the host cannot post lets the tool run, and the next qualifying tool asks again', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { fail: 'task' });
  const warn = t.mock.method(console, 'warn', () => undefined);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel'), callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-unavailable'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_channel', 'read_slack_channel']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:failed', 'task:failed']);
  const logged = warn.mock.calls.map(({ arguments: [line] }) => String(line)).filter((line) => line.includes('fee_post_failed'));
  assert.equal(logged.length, 2);
  assert.ok(logged.every((line) => !line.includes(INSTALLATION) && !line.includes('sub_')), 'the log names no installation or run');
});

for (const [admission, how] of [
  ['stall', 'never answers'], ['fail', 'fails'], ['malformed', 'answers with a malformed daily limit'],
] as const) {
  test(`an admission the host ${how} admits the task: the tool runs and the task row posts`, { timeout: 20_000 }, async (t) => {
    const posts = hostedPort(t, { admission });
    const warn = t.mock.method(console, 'warn', () => undefined);
    interceptors(t, replyRun(hostedEnv()));
    scriptedProvider([callsTools('read_slack_channel'), answers]);
    ran.length = 0;

    assert.deepEqual(await slackTurn(`fees-admission-${admission}`), { text: 'done' });
    assert.equal(admissions.length, 1);
    assert.deepEqual(ran, ['read_slack_channel']);
    assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
    const logged = warn.mock.calls.map(({ arguments: [line] }) => String(line)).filter((line) => line.includes('task_admission_failed'));
    assert.equal(logged.length, 1);
    assert.ok(!logged[0]!.includes(INSTALLATION) && !logged[0]!.includes('sub_'), 'the log names no installation or run');
  });
}

test('a chat row the host never answers does not delay the first model request', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { stall: 'chat' });
  t.mock.method(console, 'warn', () => undefined);
  interceptors(t, replyRun(hostedEnv()));
  const { sentAt } = scriptedProvider([answers]);
  const startedAt = performance.now();

  assert.deepEqual(await slackTurn('fees-chat-stalled'), { text: 'done' });
  assert.deepEqual(tiers(posts), ['chat:failed']);
  assert.ok(sentAt[0]! - startedAt < 1_000, `the first request waited ${Math.round(sentAt[0]! - startedAt)} ms`);
});

test('a chat row the host cannot post never fails the attempt', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { fail: 'chat' });
  t.mock.method(console, 'warn', () => undefined);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([answers]);

  assert.deepEqual(await slackTurn('fees-chat-unavailable'), { text: 'done' });
  assert.deepEqual(tiers(posts), ['chat:failed']);
});

test('a retried attempt of the same run posts only duplicates', async (t) => {
  const posts = hostedPort(t);
  const env = hostedEnv();
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => replyRun(env)(context.submissionId),
    installationGrants: async () => [],
  });
  const attempt = () => modelAccess(
    { type: 'agent', operationId: 'op_retry', operationKind: 'prompt' },
    { instanceId: 'fees-retry', submissionId: 'sub_retry' },
    () => runFeeInterceptor(
      { type: 'tool', toolCallId: 'call_retry', toolName: 'read_slack_list' },
      { instanceId: 'fees-retry', submissionId: 'sub_retry' },
      async () => 'ran',
    ),
  );

  assert.equal(await attempt(), 'ran');
  assert.equal(await attempt(), 'ran');
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted', 'chat:duplicate', 'task:duplicate']);
  assert.equal(admissions.length, 2, 'each attempt asks again');
});

test('a channel read whose result has an unexpected shape posts the task row and keeps its result', async (t) => {
  const posts = hostedPort(t);
  const malformed = [null, 'ran', { details: { output: 42 } }, { details: { output: 'not json' } }, { details: { output: 'null' } }];
  for (const [index, result] of malformed.entries()) {
    const modelAccess = createModelAccessInterceptor({
      lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
      installationGrants: async () => [],
    });
    const context = { instanceId: `fees-malformed-${index}`, submissionId: `sub_malformed_${index}` };
    const returned = await modelAccess({ type: 'agent', operationId: 'op_malformed', operationKind: 'prompt' }, context, () =>
      runFeeInterceptor({ type: 'tool', toolCallId: 'call_read', toolName: 'read_slack_channel' }, context, async () => result));
    assert.equal(returned, result);
  }
  assert.deepEqual(posts.filter(({ tier }) => tier === 'task').map(({ runId }) => runId),
    malformed.map((_, index) => `sub_malformed_${index}`));
});

test('the shell posts the task row only when its plan\'s repository grant minted a credential this turn', async (t) => {
  const posts = hostedPort(t);
  t.mock.method(console, 'warn', () => undefined);
  await withGithubApp(async () => {
    for (const [mint, installationId] of [['failed', 70_001], ['minted', 70_002]] as const) {
      const grant: RepositoryGrant = {
        id: `repo_${mint}`, installationId, accountLogin: 'acme', fullName: 'acme/app', enabled: true,
      };
      const access = await withFetch(
        mint === 'failed'
          ? async () => new Response('failed', { status: 500 })
          : async () => Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        () => resolveRepositoryAccess([grant]),
      );
      assert.equal(access.grants.length, mint === 'failed' ? 0 : 1);
      const modelAccess = createModelAccessInterceptor({
        lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
        installationGrants: async () => [],
      });
      const context = { instanceId: `fees-shell-${mint}`, submissionId: `sub_shell_${mint}` };
      await modelAccess({ type: 'agent', operationId: 'op_shell', operationKind: 'prompt' }, context, () => {
        runtimePlanRepositoryShell(access);
        return runFeeInterceptor({ type: 'tool', toolCallId: 'call_bash', toolName: 'bash' }, context, async () => 'ran');
      });
    }
  });
  assert.deepEqual(posts.map(({ runId, tier }) => `${runId}:${tier}`),
    ['sub_shell_failed:chat', 'sub_shell_minted:chat', 'sub_shell_minted:task']);
});

test('an unlisted tool qualifies by the family its render registered for it', async (t) => {
  const posts = hostedPort(t);
  registerActivityContext('fees-descriptor', buildSemanticActivityContext([
    { toolName: 'custom_lookup', descriptor: genericSemanticDescriptor('custom_connection') },
    { toolName: 'custom_note', descriptor: genericSemanticDescriptor('memory') },
  ]));
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
    installationGrants: async () => [],
  });
  const context = { instanceId: 'fees-descriptor', submissionId: 'sub_descriptor' };
  const call = (toolName: string) => runFeeInterceptor({ type: 'tool', toolCallId: `call_${toolName}`, toolName }, context, async () => toolName);

  await modelAccess({ type: 'agent', operationId: 'op_descriptor', operationKind: 'prompt' }, context, async () => {
    assert.equal(await call('custom_note'), 'custom_note');
    assert.deepEqual(tiers(posts), ['chat:posted']);
    assert.equal(await call('custom_lookup'), 'custom_lookup');
  });
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a qualifying tool inside an absorbed purpose, such as reading an attachment, posts no task row', async (t) => {
  const posts = hostedPort(t);
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
    installationGrants: async () => [],
  });
  const context = { instanceId: 'fees-attachment', submissionId: 'sub_attachment' };
  const read = () => runFeeInterceptor(
    { type: 'tool', toolCallId: 'call_read', toolName: 'read_slack_list' }, context, async () => 'ran',
  );

  await modelAccess({ type: 'agent', operationId: 'op_attachment', operationKind: 'prompt' }, context, async () => {
    assert.equal(await withModelRequestPurpose('attachment', read), 'ran');
    assert.deepEqual(tiers(posts), ['chat:posted']);
    assert.equal(await read(), 'ran');
  });
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a stateless call, such as the intent check, posts no fee row', async (t) => {
  const posts = hostedPort(t);
  const { sent, model } = scriptedProvider([answers]);
  const call = () => registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!.streamSimple(model, normalizeContext({
    systemPrompt: 'probe', messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  }), {}).result();

  const reply = await withModelAccess(ownKeyGrant('slack-interaction-intent'), hostedEnv(), 'intent', call);

  assert.equal(reply.stopReason, 'stop');
  assert.equal(sent.length, 1);
  assert.deepEqual(posts, []);
});

for (const [name, env, port] of [
  ['standalone, even with a host port configured,', undefined, true],
  ['a hosted deployment with no host port', hostedEnv(), false],
] as const) {
  test(`${name} posts nothing and runs as before`, { timeout: 20_000 }, async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const posts = hostedPort(t, { port });
    interceptors(t, replyRun(env));
    const { sent } = scriptedProvider([callsTools('read_slack_channel'), answers]);
    ran.length = 0;

    assert.deepEqual(await slackTurn(`fees-${port ? 'standalone' : 'no-port'}`), { text: 'done' });
    assert.deepEqual(ran, ['read_slack_channel']);
    assert.equal(sent.length, 2);
    assert.deepEqual(posts, []);
    assert.deepEqual(admissions, [], 'nothing asked for admission');
    assert.equal(warn.mock.callCount(), 0, 'nothing tried to post');
  });
}

/** A practice run's model access and run fees, as app.ts registers them for every agent. */
function testTurnInterceptors(t: TestContext) {
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
    installationGrants: async () => [],
  });
  for (const interceptor of [modelAccess, runFeeInterceptor]) {
    t.after(instrument({ key: Symbol('test-turn-fees'), interceptor, observe() {}, dispose() {} }));
  }
}

/** FeeProbe's tools, as their own agent function: Flue binds a function to one name. */
function TestTurnFeeProbe() {
  return FeeProbe();
}

/** One test run's reply: the agent is registered under the test run's name, which the limit keys on. */
async function testTurnReply(id: string): Promise<string> {
  const runtime = await start({
    agents: [{ agent: TestTurnFeeProbe, name: CHICKPEA_TEST_TURN_AGENT_NAME }],
    providers: [registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!],
  });
  try {
    const agent = init(TestTurnFeeProbe, { id });
    return (await agent.read(await agent.dispatch('Hello'))).text;
  } finally {
    await runtime.stop();
  }
}

const freeReads = (count: number) => callsTools(...Array.from({ length: count }, () => 'read_slack_thread'));

test('a practice run makes as many calls as a direct message would, and pays the fees that direct message would', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  testTurnInterceptors(t);
  const script = () => scriptedProvider([freeReads(40), callsTools('read_slack_channel'), answers]);
  script();
  ran.length = 0;
  assert.equal(await testTurnReply('test-turn-unlimited'), 'done');
  assert.deepEqual(ran, [...Array.from({ length: 40 }, () => 'read_slack_thread'), 'read_slack_channel'], 'every call ran, none refused');
  const practiced = tiers(posts);
  posts.length = 0;
  script();
  assert.deepEqual(await slackTurn('test-turn-as-a-dm'), { text: 'done' });
  assert.deepEqual(practiced, tiers(posts), 'the same fees as a direct message making the same calls');
  assert.deepEqual(practiced, ['chat:posted', 'task:posted']);
});
