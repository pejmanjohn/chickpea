import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { z } from 'zod';

import type { RuntimePlanV2 } from '../../agents/runtime-plan.ts';
import { sharedSystemBlock, slackTenantInstructions } from '../../agents/shared-prefix-layout.ts';
import rendered from '../../agents/shared-prefix-tools.json' with { type: 'json' };
import { runtimePlanSkills } from '../../agents/slack-thread.ts';
import { BROWSER_TOOL_NAMES } from '../../browser/tools.ts';
import { connectionGuideSkillName } from '../../config/connector-skills.ts';
import type { AgentConnectionBinding, ConnectionAccount } from '../../config/types.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../../connections/catalog/index.ts';
import { ATTACH_FILE_TO_CONNECTION_TOOL_NAME, planAllowsConnectionFileUpload } from '../../connections/file-upload-tool.ts';
import {
  CONNECTION_REQUEST_TOOL_NAME,
  createConnectionRequestTool,
  planAllowsConnectionRequests,
} from '../../connections/request-tool.ts';
import type { EffectiveConnectionAccount } from '../../connections/types.ts';
import { agentMemoryPromptBlock } from '../../memory/runtime.ts';
import { ADVISORY_MEMORY_FINAL_CHECK } from '../../slack/web-client-context.ts';
import { AGENT_AUTHORING_PACKAGE } from '../agent-authoring/index.ts';
import { readAgentRun, readingView, resolveAgentRun, type AgentRunReading } from './agent-run.ts';
import { fail } from './conventions.ts';
import type { FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';

type Output = z.infer<typeof schemas.explainAgentOutput>;
type PromptPart = Output['prompt'][number];
type ToolGroup = Output['tools'][number];
type Missing = ToolGroup['missing'][number];

/** The estimate Flue's compaction uses (pi-ai, about 3.5 characters a token); src has none of its own. */
const TOKEN_ESTIMATE = 'Estimated the way Flue\'s compaction counts (pi-ai: characters ÷ 3.5). ' +
  'Chickpea\'s and catalog services\' tools are counted from their full definitions; MCP and API connection ' +
  'tools from their names and descriptions only; browser tools are not counted.';

const tokens = estimateTextTokens;
const toolTokens = (tool: unknown) => tokens(JSON.stringify(tool));

/** At most this many tools are listed as missing from one group. */
const MISSING_LIMIT = 30;

export async function explainAgent(
  deps: FiveZeroDeps,
  input: z.infer<typeof schemas.explainAgentInput>,
): Promise<Output> {
  const reading = await readAgentRun(deps, input);
  const { place } = reading;
  if (place.kind === 'channel' && !reading.grants.some(({ channelId, agentId }) =>
    channelId === place.channelId && agentId === reading.agent.id)) {
    fail('invalid_input', `${reading.agent.name} is not added to that Channel.`, {
      nextStep: 'Use a channelId from get_agent\'s channels, or place "dm".',
    });
  }
  const run = await resolveAgentRun(reading);
  const prompt: PromptPart[] = [{
    part: 'chickpea',
    title: 'Chickpea\'s base prompt, the same for every Agent',
    tokens: tokens(sharedSystemBlock('user')),
  }];
  if (run.assignment) {
    prompt.push({
      part: 'instructions',
      title: 'Its instructions, with its name and place, then again inside the rule that only the person asking authorizes actions',
      tokens: tokens(slackTenantInstructions(run.assignment)),
      text: reading.agent.instructions,
    });
  }
  const memory = await memoryPart(reading);
  if (memory) prompt.push(memory);
  const tools: ToolGroup[] = [];
  if (run.plan) {
    prompt.push(...skillParts(run.plan));
    tools.push(...chickpeaTools(run.plan, Boolean(run.parts?.sandboxUnavailableFallback), reading));
    tools.push(...await connectionTools(run.plan, run.parts?.connections ?? [], reading));
  }
  const contributors = [
    ...prompt.map(({ title, tokens: count }) => ({ what: title, tokens: count })),
    ...tools.map(({ group, tokens: count }) => ({ what: `${group} tools`, tokens: count })),
  ];
  return {
    ...readingView(reading),
    prompt,
    tools,
    model: {
      model: run.model.model,
      source: run.model.source,
      effort: run.model.effort,
      canRun: run.model.canRun,
      ...(run.model.why ? { why: run.model.why } : {}),
    },
    contextBudget: {
      tokens: contributors.reduce((sum, { tokens: count }) => sum + count, 0),
      top: contributors.filter(({ tokens: count }) => count > 0)
        .sort((left, right) => right.tokens - left.tokens).slice(0, 3),
      estimate: TOKEN_ESTIMATE,
    },
  };
}

async function memoryPart(reading: AgentRunReading): Promise<PromptPart | undefined> {
  const memory = reading.stores.memory ? await reading.stores.memory.getAgentMemory(reading.agent.id) : undefined;
  const block = memory ? agentMemoryPromptBlock(memory.body) : undefined;
  if (!memory || !block) return undefined;
  return {
    part: 'memory',
    title: 'Its memory',
    tokens: tokens(`${block}\n\n${ADVISORY_MEMORY_FINAL_CHECK}`),
    text: memory.body.trim(),
  };
}

/**
 * Flue lists each skill by name and description; its text loads only when
 * the Agent uses it. Chickpea adds built-in skills, and each connection guide
 * is a skill.
 */
function skillParts(plan: RuntimePlanV2): PromptPart[] {
  const own = new Set(plan.skills.map(({ name }) => name));
  const guides = new Map([...plan.apiConnections, ...plan.mcpConnections].flatMap(({ id, displayName, guide }) =>
    guide ? [[connectionGuideSkillName(id), displayName ?? id] as const] : []));
  const skills = [
    ...runtimePlanSkills(plan, { browser: plan.browserCapability !== undefined }),
    AGENT_AUTHORING_PACKAGE.skill,
  ] as ReadonlyArray<{ name: string; description?: string; instructions?: string }>;
  return skills.map((skill) => {
    const line = `- **${skill.name}**${skill.description ? ` — ${skill.description}` : ''}`;
    const guide = own.has(skill.name) ? undefined : guides.get(skill.name);
    return {
      part: guide ? 'connection_guide' : 'skill',
      title: guide ? `${guide}'s guide` : own.has(skill.name) ? `Skill: ${skill.name}` : `Chickpea's ${skill.name} skill`,
      tokens: tokens(line),
      text: line,
      whenUsed: { tokens: tokens(skill.instructions ?? '') },
    } satisfies PromptPart;
  });
}

/** Chickpea's own tools, by family, as the rendered definitions every Slack turn sends. */
const FAMILIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Files and shell', ['read', 'write', 'edit', 'bash', 'grep', 'glob']],
  ['Web', ['read_web_page', 'web_search']],
  ['Slack', [
    'read_slack_list', 'read_slack_list_item', 'create_slack_list_item', 'update_slack_list_item',
    'create_slack_task_list', 'share_slack_list', 'read_slack_thread', 'read_slack_channel', 'lookup_slack_user',
    'start_slack_group_dm', 'read_slack_canvas', 'create_slack_canvas', 'update_slack_canvas', 'create_slack_channel',
    'reply_in_thread',
  ]],
  ['Managing Chickpea', [
    'prepare_connector_setup', 'inspect_workspace', 'discover_slack_channels', 'test_connection', 'save_connection_key',
    'try_connection', 'inspect_memory', 'update_agent_memory', 'inspect_routines', 'request_chickpea_handoff',
    'export_workspace_recipe', 'preview_workspace_recipe', 'revoke_setup_link', 'import_skill', 'manage_agent_skill',
    'propose_skill_import',
  ]],
  ['Replies and cards', [
    'present_table', 'present_cards', 'present_chart', 'present_details', 'ask_user', 'offer_actions',
    'request_form', 'update_card', 'post_artifact', 'complete_file_delivery',
  ]],
  ['Images', ['generate_image', 'recover_image']],
];
const FAMILY_OF = new Map(FAMILIES.flatMap(([family, names]) => names.map((name) => [name, family] as const)));

/** A tool definition as a request carries it; its size is what it costs. */
type RenderedTool = { name: string } & Record<string, unknown>;

function chickpeaTools(plan: RuntimePlanV2, sandboxFallback: boolean, reading: AgentRunReading): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  const group = (name: string) => {
    let found = groups.get(name);
    if (!found) groups.set(name, found = { group: name, tools: [], tokens: 0, missing: [] });
    return found;
  };
  const mount = (family: string, tool: RenderedTool) => {
    const into = group(family);
    into.tools.push(tool.name);
    into.tokens += toolTokens(tool);
  };
  const segments = rendered.segments as Record<string, RenderedTool[]>;
  // Every Channel and DM message turn mounts the universal and interactive tools.
  for (const tool of [...rendered.tools, ...segments.interactive ?? []] as RenderedTool[]) {
    if (tool.name === 'web_search' && !plan.webSearch) {
      group('Web').missing.push({ tool: tool.name, why: 'not_set_up', detail: 'This deployment has no web search key.' });
      continue;
    }
    mount(FAMILY_OF.get(tool.name) ?? 'Chickpea', tool);
  }
  if (plan.imageCapability?.filled) {
    for (const tool of segments.image ?? []) mount('Images', tool);
  } else {
    group('Images').missing.push(...allMissing([], { why: 'not_set_up', detail: 'No image model is set for the workspace or this Agent.' }));
  }
  if (plan.codingWorkspace) {
    for (const tool of segments.coding ?? []) mount('Coding workspace', tool);
  } else if (sandboxFallback) {
    group('Coding workspace').missing.push(...allMissing([], { why: 'not_set_up', detail: 'This deployment has no coding sandbox.' }));
  }
  if (planAllowsConnectionRequests(plan)) {
    const request = createConnectionRequestTool({ agentId: plan.agentId, resolveAccess: async () => [] as never });
    mount('Chickpea', { name: request.name, description: request.description });
    if (planAllowsConnectionFileUpload(plan)) mount('Chickpea', { name: ATTACH_FILE_TO_CONNECTION_TOOL_NAME });
  }
  if (plan.browserCapability) {
    group('Browser').tools.push(...BROWSER_TOOL_NAMES);
  } else if ((reading.snapshotAgent.websiteLogins ?? []).some(({ enabled }) => enabled)) {
    group('Browser').missing.push(...allMissing([], {
      why: 'not_set_up',
      detail: 'No hosted browser is connected, so its website logins cannot be used.',
    }));
  }
  return [...groups.values()];
}

/**
 * One group per connection the person's run could use: what mounts from it,
 * and why anything expected does not. Another member's own accounts never
 * mount for this person and are not listed.
 */
async function connectionTools(
  plan: RuntimePlanV2,
  effective: readonly EffectiveConnectionAccount[],
  reading: AgentRunReading,
): Promise<ToolGroup[]> {
  const { stores, workspaceId, agent, person } = reading;
  const [accounts, bindings] = await Promise.all([
    stores.config.listConnectionAccounts(workspaceId),
    stores.config.listAgentConnectionBindings(agent.id),
  ]);
  const mounted = new Map(effective.map((connection) => [connection.account.id, connection]));
  const handle = connectionHandles(reading);
  const groups: ToolGroup[] = [];
  for (const binding of bindings) {
    const account = accounts.find(({ id, providerId }) => id === binding.connectionAccountId && providerId === binding.providerId);
    if (!account || account.lifecycle === 'revoked') continue;
    if (account.ownerKind === 'member' && account.ownerMembershipId !== person.membershipId) continue;
    const connection = mounted.get(account.id);
    groups.push(connection
      ? await mountedGroup(plan, connection, handle(account))
      : unmountedGroup(account, binding, handle(account)));
  }
  // A service each member connects for themselves, which this person has not.
  for (const authorization of plan.connectionAuthorizations ?? []) {
    const template = accounts.find(({ id }) => id === authorization.templateAccountId);
    const binding = bindings.find(({ connectionAccountId }) => connectionAccountId === authorization.templateAccountId);
    groups.push({
      group: template?.label ?? authorization.providerId,
      tools: [],
      tokens: 0,
      missing: allMissing(template && binding ? expectedTools(template, binding) : [], {
        why: 'not_connected',
        detail: person.you
          ? 'You have not connected your own account yet.'
          : `${person.name ?? 'This person'} has not connected their own account yet.`,
      }),
    });
  }
  return groups;
}

/** The connectionId get_agent and check_agent show for an account: its lane's, else its own. */
function connectionHandles(reading: AgentRunReading): (account: ConnectionAccount) => string {
  const lanes = [...reading.snapshotAgent.apiConnections, ...reading.snapshotAgent.mcpServers].map(({ id }) => id);
  return (account) => lanes.find((id) => id === account.id) ?? lanes.find((id) => id === account.providerId) ?? account.id;
}

async function mountedGroup(plan: RuntimePlanV2, connection: EffectiveConnectionAccount, connectionId: string): Promise<ToolGroup> {
  const { account, policy } = connection;
  const base = { group: account.label, connectionId };
  if (policy.kind === 'api') {
    return { ...base, tools: [CONNECTION_REQUEST_TOOL_NAME], tokens: 0, missing: [] };
  }
  if (policy.kind === 'mcp') {
    const discovered = new Map(policy.discoveredTools.map((tool) => [tool.name, tool]));
    const allowed = new Set(policy.allowedTools);
    const tools = policy.allowedTools.filter((name) => discovered.size === 0 || discovered.has(name));
    return {
      ...base,
      tools,
      tokens: tools.reduce((sum, name) => {
        const tool = discovered.get(name);
        return sum + toolTokens({ name, ...(tool?.description ? { description: tool.description } : {}) });
      }, 0),
      missing: [
        ...missingTools(discovered.size === 0 ? [] : policy.allowedTools.filter((name) => !discovered.has(name)), {
          why: 'not_discovered',
          detail: 'Chosen, but the server did not list it the last time Chickpea checked.',
        }),
        ...missingTools([...discovered.keys()].filter((name) => !allowed.has(name)), {
          why: 'not_chosen',
          detail: 'The server offers it, but it is not chosen for this Agent.',
        }),
      ].slice(0, MISSING_LIMIT),
    };
  }
  const declaration = plan.managedConnections?.find(({ id }) => id === account.id);
  const chosen = new Set(declaration?.allowedCapabilities ?? []);
  const detail = await MANAGED_CONNECTOR_CATALOG.detail(policy.toolkit)?.load().catch(() => undefined);
  const capabilities = detail?.connector.capabilities ?? [];
  const mountedCapabilities = capabilities.filter(({ id }) => chosen.has(id));
  return {
    ...base,
    tools: [...chosen].map((id) => MANAGED_CONNECTOR_CATALOG.capability(id)?.toolName ?? id),
    tokens: mountedCapabilities.reduce((sum, capability) => sum + toolTokens({
      name: capability.toolName,
      description: capability.description,
      input_schema: capability.input,
    }), 0),
    missing: missingTools(
      MANAGED_CONNECTOR_CATALOG.capabilities(policy.toolkit, 'write')
        .filter(({ id }) => !chosen.has(id)).map(({ toolName }) => toolName),
      { why: 'not_chosen', detail: 'The service offers it, but this Agent\'s connection does not include it.' },
    ),
  };
}

function unmountedGroup(account: ConnectionAccount, binding: AgentConnectionBinding, connectionId: string): ToolGroup {
  const why: Reason = !binding.enabled
    ? { why: 'not_chosen', detail: 'This connection is turned off for this Agent.' }
    : account.lifecycle === 'pending'
      ? { why: 'needs_attention', detail: 'Its setup has not finished.' }
      : { why: 'needs_attention', detail: 'It needs to be reconnected.' };
  return {
    group: account.label,
    connectionId,
    tools: [],
    tokens: 0,
    missing: allMissing(expectedTools(account, binding), why),
  };
}

/** The tools a connection would mount if it were ready and on. */
function expectedTools(account: ConnectionAccount, binding: AgentConnectionBinding): string[] {
  const { policy } = account;
  if (policy.kind === 'api') return [CONNECTION_REQUEST_TOOL_NAME];
  if (policy.kind === 'mcp') return [...policy.allowedTools];
  const chosen = binding.allowedCapabilities.length > 0
    ? binding.allowedCapabilities
    : MANAGED_CONNECTOR_CATALOG.capabilities(policy.toolkit, 'write').map(({ id }) => id);
  return chosen.map((id) => MANAGED_CONNECTOR_CATALOG.capability(id)?.toolName ?? id);
}

type Reason = Omit<Missing, 'tool'>;

function missingTools(names: readonly string[], reason: Reason): Missing[] {
  return names.slice(0, MISSING_LIMIT).map((tool) => ({ ...reason, tool }));
}

/** Every tool of a group that mounts none; `*` stands for all of them when they are not named. */
function allMissing(names: readonly string[], reason: Reason): Missing[] {
  return missingTools(names.length > 0 ? names : ['*'], reason);
}
