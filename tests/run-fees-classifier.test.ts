import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';

import { fauxAssistantMessage, fauxProvider, type Context } from '@earendil-works/pi-ai';
import { init, useDelivery, type AgentProps } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import {
  unknownSemanticDescriptor,
  type SemanticActivityDescriptor,
  type SemanticTargetFamily,
} from '../src/activity/semantic.ts';
import { ChickpeaRoutineExecution } from '../src/agents/routine-execution.ts';
import { ChickpeaRoutineIntent } from '../src/agents/routine-intent.ts';
import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { useChickpeaSlackRuntimeCapabilities } from '../src/agents/slack-thread.ts';
import { BROWSER_TOOL_NAMES } from '../src/browser/tools.ts';
import { closeNodeStateStores, getConfigStore } from '../src/config/state-backend.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import { WORKSPACE_MANAGEMENT_TOOL_NAMES } from '../src/management/tool-adapter.ts';
import { parseSlackManagementSignal } from '../src/management/slack-tools.ts';
import { parseCurrentRequestEnvelope, serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import { WORKSPACE_TOOL_NAMES } from '../src/sandbox/workspace-tools.ts';
import { slackPresentationIntentCapability } from '../src/slack/presentation-intent.ts';
import { qualifiesAsTask, TASK_TOOL_TABLE, type RunAction } from '../src/usage/run-fees.ts';
import { withEnv } from './helpers/env.ts';

const MODEL = 'faux/run-fees-classifier';
const WORKSPACE = 'T_FEES';
const CHANNEL = 'C_FEES';
const THREAD_TS = '1787000000.000100';
const MESSAGE_TS = '1787000000.000200';
const ACTOR = 'U_HUMAN';

const AGENT: CustomAgentConfig = {
  id: 'agent_fees', kind: 'user', revision: 1, name: 'Fees', instructions: 'Answer the request.',
  enabled: true, model: MODEL, skills: [], mcpServers: [], apiConnections: [], repositories: [],
};

/**
 * Every capability a plan can grant except remote tool servers, which the
 * name-prefix rule decides, and coding workspaces, which mount only on the
 * Worker target.
 */
const FULL_PLAN: RuntimePlanV2 = {
  schemaVersion: 2,
  continuityPolicy: 'synthetic-test',
  agentId: AGENT.id,
  actorMembershipId: 'membership_fees',
  connectionAuthorizations: [{
    providerId: 'google',
    templateAccountId: 'acct_template',
    accounts: [{ id: 'acct_personal', label: 'Work Google', lifecycle: 'pending' }],
  }],
  conversation: {
    workspaceId: WORKSPACE,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    surface: 'channel_thread',
    continuityKey: `agent_${'a'.repeat(40)}`,
  },
  model: MODEL,
  imageCapability: { role: 'image', filled: true, acceptsImageInput: true },
  browserCapability: { provider: 'browserbase' },
  websiteLogins: [{
    id: `wl_${'b'.repeat(32)}`, host: 'app.example.com', label: 'Example', level: 'act', method: 'credentials',
    username: 'ops',
  }],
  instructions: AGENT.instructions,
  memoryEpoch: 1,
  skills: [{ name: 'weekly-report', description: 'Write the weekly report.', instructions: 'Write it.' }],
  mcpConnections: [],
  apiConnections: [{
    id: 'conn_api',
    displayName: 'Example API',
    allowedHosts: ['api.example.com'],
    pathPrefixes: ['/'],
    allowedMethods: ['GET', 'POST'],
    headerName: 'Authorization',
    authMode: 'credential',
  }],
  repositories: [],
  sandbox: { mode: 'bash' },
  artifactDestination: { kind: 'slack_conversation', channelId: CHANNEL },
  harnessRevision: 'c'.repeat(64),
};

const ROUTINE_PLAN = compileRuntimePlanV2({
  turn: {
    workspaceId: WORKSPACE, channelId: CHANNEL, threadTs: THREAD_TS, eventId: 'E_ROUTINE', text: 'Run the saved task.',
    userId: ACTOR, messageTs: MESSAGE_TS, source: 'app_mention', contextMode: 'thread',
  },
  assignment: {
    workspaceId: WORKSPACE, channelId: CHANNEL, agentId: AGENT.id, agent: AGENT, model: MODEL,
    modelAttribution: { source: 'workspace_default', providerId: 'faux', workspaceDefaultRevision: 1 },
  },
  instructions: AGENT.instructions,
  memoryEpoch: 1,
  effectiveConnections: [],
  artifactThreadTs: null,
});

function slackMessage() {
  return {
    kind: 'signal' as const,
    type: 'slack.message',
    tagName: 'slack_message',
    body: serializeCurrentRequestEnvelope('Do the work.', false, ACTOR, MESSAGE_TS, {
      schemaVersion: 2,
      progressiveStreamingOffered: true,
    }),
    attributes: {
      workspaceId: WORKSPACE,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      slackUserId: ACTOR,
      eventId: 'E_FEES',
      messageTs: MESSAGE_TS,
      turnJobId: 'turn_fees',
      conversationKind: 'channel',
      requesterText: 'Do the work.',
      admittedListIds: '["FEXISTING"]',
    },
  };
}

function scheduleSignal() {
  return {
    kind: 'signal' as const,
    type: 'schedule',
    tagName: 'schedule',
    body: 'Run the saved task.',
    attributes: {
      workspaceId: WORKSPACE,
      conversationId: CHANNEL,
      ownerAgentId: AGENT.id,
      destinationKind: 'channel',
      threadTs: '',
    },
  };
}

/** The production capability seam, given the plan directly instead of through the staged turn input. */
function SlackCapabilityProbe({ id }: AgentProps) {
  const delivery = useDelivery();
  useChickpeaSlackRuntimeCapabilities(
    FULL_PLAN,
    id,
    slackPresentationIntentCapability(parseCurrentRequestEnvelope(delivery.body)),
    () => {},
    () => {},
    parseSlackManagementSignal(delivery, FULL_PLAN) !== undefined,
    () => {},
    undefined,
    undefined,
    () => {},
    () => {},
  );
  return FULL_PLAN.instructions;
}

let probeRun = 0;

async function mountedToolNames(
  agent: Parameters<typeof init>[0],
  name: string,
  dispatch: { message: unknown; initialData?: unknown },
): Promise<string[]> {
  const faux = fauxProvider({ models: [{ id: 'run-fees-classifier' }] });
  const captures: Context[] = [];
  faux.setResponses([(context: Context) => {
    captures.push(context);
    return fauxAssistantMessage('Done.');
  }]);
  const flue = await start({ agents: [{ agent, name }], providers: [faux.provider] });
  try {
    const handle = init(agent, { id: `run-fees-probe-${probeRun += 1}` });
    await handle.read(await handle.dispatch(dispatch as Parameters<typeof handle.dispatch>[0]));
  } finally {
    await flue.stop();
  }
  assert.equal(captures.length, 1, `${name} reached the model`);
  return (captures[0]!.tools ?? []).map(({ name }) => name);
}

async function withLiveAgent<T>(run: () => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-fees-'));
  try {
    return await withEnv({
      TAG_DB_PATH: join(directory, 'state.sqlite'),
      SLACK_STATE_DB_PATH: join(directory, 'state.sqlite'),
      CHICKPEA_CREDENTIAL_KEYRING_PATH: join(directory, 'credential-keyring.json'),
    }, async () => {
      closeNodeStateStores();
      await getConfigStore().createAgent(AGENT);
      return run();
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
}

const CATALOG_TOOL_NAMES = MANAGED_CONNECTOR_CATALOG
  .list().flatMap(({ capabilities }) => capabilities.map(({ toolName }) => toolName));

const FLUE_BUILT_IN_TOOLS = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'task', 'activate_skill', 'read_skill_resource'];

/** Where each tool name Core registers comes from, independently of the table. */
let registered: ReadonlyMap<string, string>;

before(async () => {
  const sources: [string, readonly string[]][] = await withLiveAgent(async () => [
    ['the Slack agent render', await mountedToolNames(
      SlackCapabilityProbe,
      'run-fees-slack-probe',
      { message: slackMessage() },
    )],
    ['the routine execution agent render', await mountedToolNames(
      ChickpeaRoutineExecution,
      ChickpeaRoutineExecution.agentName,
      { message: scheduleSignal(), initialData: { runtimePlan: ROUTINE_PLAN, requestedModel: MODEL } },
    )],
    ['the routine intent agent render', await mountedToolNames(
      ChickpeaRoutineIntent,
      ChickpeaRoutineIntent.agentName,
      { message: 'Every Monday post the report.', initialData: { model: MODEL } },
    )],
  ]);
  sources.push(
    ['the managed connector catalog', CATALOG_TOOL_NAMES],
    ['the coding workspace tools', WORKSPACE_TOOL_NAMES],
    // The management server registers the whole list; a turn render mounts part of it.
    ['the workspace management tools', WORKSPACE_MANAGEMENT_TOOL_NAMES],
    ['Flue built-ins', FLUE_BUILT_IN_TOOLS],
  );
  const names = new Map<string, string>();
  for (const [source, toolNames] of sources) {
    for (const name of toolNames) if (!names.has(name)) names.set(name, source);
  }
  registered = names;
});

const tool = (toolName: string, descriptor?: SemanticActivityDescriptor): RunAction => ({ kind: 'tool', toolName, descriptor });
const CHAT_SANDBOX = { kind: 'interactive', repositoryShell: false } as const;
const REPOSITORY_SANDBOX = { kind: 'interactive', repositoryShell: true } as const;
const SCHEDULED = { kind: 'scheduled' } as const;
const interactive = (toolName: string, descriptor?: SemanticActivityDescriptor) =>
  qualifiesAsTask(CHAT_SANDBOX, tool(toolName, descriptor));
const withTarget = (target: SemanticTargetFamily): SemanticActivityDescriptor => ({ ...unknownSemanticDescriptor(), target });

test('the table classifies every tool name Core registers', () => {
  const unclassified = [...registered]
    .filter(([name]) => !TASK_TOOL_TABLE.has(name))
    .map(([name, source]) => `${name} (from ${source})`);
  assert.deepEqual(unclassified, [], 'every registered tool has a row');
});

test('the table holds no row for a tool Core does not register', () => {
  const stale = [...TASK_TOOL_TABLE.keys()].filter((name) => !registered.has(name));
  assert.deepEqual(stale, [], 'every row names a registered tool');
});

test('writing in a Slack List makes a reply a task', () => {
  for (const name of ['create_slack_list_item', 'update_slack_list_item', 'create_slack_task_list', 'share_slack_list']) {
    assert.equal(interactive(name), true, name);
  }
});

test('reading a Slack List makes a reply a task', () => {
  for (const name of ['read_slack_list', 'read_slack_list_item']) assert.equal(interactive(name), true, name);
});

test('reading another Slack channel makes a reply a task, the current thread does not', () => {
  assert.equal(interactive('read_slack_channel'), true);
  assert.equal(interactive('read_slack_thread'), false);
});

test('setting up Chickpea itself never makes a reply a task', () => {
  const setup = {
    'Agent authoring': ['propose_workspace_changes', 'apply_workspace_changes', 'confirm_workspace_change', 'undo_workspace_change', 'get_operation'],
    schedules: ['manage_scheduled_work', 'inspect_routines'],
    skills: ['propose_skill_import', 'import_skill', 'manage_agent_skill'],
    destinations: ['discover_slack_channels', 'prepare_connector_setup', 'test_mcp_connection', 'authorize_personal_connection', 'revoke_setup_link'],
    settings: ['inspect_workspace', 'prepare_provider_setup', 'export_workspace_recipe', 'preview_workspace_recipe'],
    memory: ['update_agent_memory', 'inspect_memory'],
  };
  for (const [area, names] of Object.entries(setup)) {
    for (const name of names) assert.equal(interactive(name), false, `${area}: ${name}`);
  }
});

test('connector, browser and coding workspace tools make a reply a task', () => {
  const work = [
    ...CATALOG_TOOL_NAMES,
    'connection_request',
    'attach_file_to_connection',
    ...BROWSER_TOOL_NAMES,
    ...WORKSPACE_TOOL_NAMES,
  ];
  for (const name of work) assert.equal(interactive(name), true, name);
});

test('replying, presenting and generating images never make a reply a task', () => {
  const reply = [
    'present_table', 'stream_answer', 'ask_user', 'offer_actions', 'present_cards', 'present_chart', 'present_details',
    'request_form', 'generate_image', 'recover_image', 'request_chickpea_handoff', 'submit_routine_result',
    'submit_routine_intent',
  ];
  for (const name of reply) assert.equal(interactive(name), false, name);
});

test("the Agent's own sandbox tools never make a reply a task when its shell reaches no repository", () => {
  for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'task']) assert.equal(interactive(name), false, name);
});

test('the shell makes a reply a task when it reaches a granted repository', () => {
  assert.equal(qualifiesAsTask(REPOSITORY_SANDBOX, tool('bash')), true);
});

test('reading or editing files never makes a reply a task, even beside a repository shell', () => {
  for (const name of ['read', 'write', 'edit', 'grep', 'glob', 'task']) {
    assert.equal(qualifiesAsTask(REPOSITORY_SANDBOX, tool(name)), false, name);
  }
});

test('skills, artifacts and a person lookup never make a reply a task', () => {
  for (const name of ['activate_skill', 'read_skill_resource', 'post_artifact', 'complete_file_delivery', 'lookup_slack_user']) {
    assert.equal(interactive(name), false, name);
  }
});

test('a scheduled run is never a task by its tools, even a connector', () => {
  for (const name of [...registered.keys(), 'mcp__docs__search', 'unlisted_tool']) {
    for (const family of ['managed_connector', 'custom_connection'] as const) {
      assert.equal(qualifiesAsTask(SCHEDULED, tool(name, withTarget(family))), false, `${name} as ${family}`);
    }
  }
});

test('a scheduled run posting its result is a task', () => {
  assert.equal(qualifiesAsTask(SCHEDULED, { kind: 'post' }), true);
});

test('an interactive run posting is not a task', () => {
  assert.equal(qualifiesAsTask(CHAT_SANDBOX, { kind: 'post' }), false);
});

test('an MCP tool makes a reply a task with no descriptor', () => {
  assert.equal(interactive('mcp__docs__search'), true);
  assert.equal(interactive('mcp__tracker__create_issue', withTarget('unknown')), true);
});

test('an unlisted tool makes a reply a task only through a connector family', () => {
  const families: Record<SemanticTargetFamily, boolean> = {
    managed_connector: true,
    custom_connection: true,
    skill: false,
    repository: false,
    memory: false,
    scheduled_work: false,
    workspace: false,
    connection_setup: false,
    agent_authoring: false,
    artifact: false,
    response: false,
    unknown: false,
    internal: false,
  };
  for (const [family, qualifies] of Object.entries(families) as [SemanticTargetFamily, boolean][]) {
    assert.equal(interactive('unlisted_tool', withTarget(family)), qualifies, family);
  }
  assert.equal(interactive('unlisted_tool'), false, 'no descriptor');
});

test('a tool in the table is decided by its name, not its descriptor', () => {
  assert.equal(interactive('read_slack_thread', withTarget('managed_connector')), false);
  assert.equal(interactive('read_slack_channel', withTarget('unknown')), true);
});
