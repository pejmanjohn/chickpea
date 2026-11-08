import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import { emitManagementMetric } from '../telemetry.ts';
import {
  mcpErrorResult,
  mcpSuccessResult,
  mcpToolError,
  READ_HINTS,
  toolMeta,
  type McpToolVisibility,
} from './conventions.ts';
import { proposeAgent, proposeAgentChange } from './proposals.ts';
import * as reads from './reads.ts';
import type { FiveZeroDeps } from './reads.ts';
import * as schemas from './schemas.ts';

type Structured = Record<string, unknown>;

/** One 5.0 tool, type-erased for the registry; `tool()` checks each one. */
interface FiveZeroTool {
  title: string;
  /** About 60 words: what it does and its one side effect, never a procedure. */
  description: string;
  input: z.ZodType<Structured>;
  output: z.ZodType<Structured>;
  visibility?: readonly McpToolVisibility[];
  profile?: true;
  run(deps: FiveZeroDeps, args: Structured): Promise<Structured>;
}

/** Checks that `run` takes what `input` parses and returns what `output` accepts. */
function tool<I extends z.ZodType<Structured>, O extends z.ZodType<Structured>>(definition: {
  title: string;
  description: string;
  input: I;
  output: O;
  visibility?: readonly McpToolVisibility[];
  profile?: true;
  run: (deps: FiveZeroDeps, args: z.output<I>) => Promise<z.output<O>>;
}): FiveZeroTool {
  return definition;
}

/**
 * The 5.0 tools U3a-1 adds beside the 4.x surface: reads, read-only previews
 * and one card-only read. Every one reads only Chickpea's own state.
 */
export const FIVE_ZERO_TOOLS = {
  get_account: tool({
    title: 'Get Chickpea account',
    description: 'Who is signed in to Chickpea through this connection: an opaque profile id that never changes, the person\'s name, and a nickname naming their Slack workspace and role. Reads only; changes nothing.',
    input: schemas.getAccountInput,
    output: schemas.getAccountOutput,
    profile: true,
    run: (deps) => reads.getAccount(deps),
  }),
  get_workspace: tool({
    title: 'Get Chickpea workspace',
    description: 'The Slack workspace Chickpea serves and the signed-in person\'s role in it: its name, how many Agents they can use, the Admin link, and what only Admin in a browser can change, such as Agent pictures and, for Owners and Admins, the Settings pages. Reads only; changes nothing.',
    input: schemas.getWorkspaceInput,
    output: schemas.getWorkspaceOutput,
    run: (deps) => reads.getWorkspace(deps),
  }),
  list_agents: tool({
    title: 'List Agents',
    description: 'The Agents, AI teammates in Slack, that the signed-in person can use: each one\'s agentId, @handle, whether it is on, whether they can edit it, plain reasons it needs attention, and its Admin and Slack links. include "mine" lists only the ones they created. Reads only; changes nothing.',
    input: schemas.listAgentsInput,
    output: schemas.listAgentsOutput,
    run: (deps, args) => reads.listAgents(deps, args),
  }),
  get_agent: tool({
    title: 'Get Agent',
    description: 'One Agent as it is now: instructions, models, skills, connections, website logins, repositories, Slack Channels and Slack status, plus the version a later change sends back. Read it before you propose a change. A member sees only the Agents they may edit. Reads only; changes nothing.',
    input: schemas.getAgentInput,
    output: schemas.getAgentOutput,
    run: (deps, args) => reads.getAgent(deps, args),
  }),
  list_services: tool({
    title: 'List services',
    description: 'The services Chickpea can connect an Agent to, such as Gmail, Notion or HubSpot. This is a catalog, not what any Agent reaches now: get_agent lists an Agent\'s connections. search keeps the services whose name or description has every word. Reads only; changes nothing.',
    input: schemas.listServicesInput,
    output: schemas.listServicesOutput,
    run: (deps, args) => reads.listServices(deps, args),
  }),
  list_models: tool({
    title: 'List models',
    description: 'The chat and image models this workspace can use now, with each chat model\'s reasoning efforts. For an Owner or Admin, also the workspace default models with their versions, and each model provider: whether it is ready and whose key it runs on. Reads only; changes nothing.',
    input: schemas.listModelsInput,
    output: schemas.listModelsOutput,
    run: (deps) => reads.listModels(deps),
  }),
  list_members: tool({
    title: 'List members',
    description: 'The people in this Chickpea workspace, with each one\'s Slack user ID, name, role and status. Owners and Admins only, as on Admin\'s Team page; a member gets not_allowed. Reads only; changes nothing.',
    input: schemas.listMembersInput,
    output: schemas.listMembersOutput,
    run: (deps) => reads.listMembers(deps),
  }),
  list_slack_channels: tool({
    title: 'List Slack Channels',
    description: 'The Slack Channels the signed-in person is in: whether Chickpea is in each, Chickpea\'s settings for it, and which Agents answer there. search matches part of a name. complete is false when Slack\'s list was cut short or could not be read. Reads only; changes nothing.',
    input: schemas.listSlackChannelsInput,
    output: schemas.listSlackChannelsOutput,
    run: (deps, args) => reads.listSlackChannels(deps, args),
  }),
  get_agent_memory: tool({
    title: 'Get Agent memory',
    description: 'The one memory text an Agent keeps across conversations, with the version a later memory change sends back. Only for an Agent the person may edit. Reads only; changes nothing.',
    input: schemas.getAgentMemoryInput,
    output: schemas.getAgentMemoryOutput,
    run: (deps, args) => reads.getAgentMemory(deps, args),
  }),
  list_schedules: tool({
    title: 'List schedules',
    description: 'Schedules (routines) that make an Agent post on its own: where each posts, when it runs next, how its last run went, whether it is on, who it runs as, and its version. Filter by agentId, channelId or scheduleId. A person sees their own direct-message schedules, never anyone else\'s. Reads only; changes nothing.',
    input: schemas.listSchedulesInput,
    output: schemas.listSchedulesOutput,
    run: (deps, args) => reads.listSchedules(deps, args),
  }),
  get_setup_status: tool({
    title: 'Get setup status',
    description: 'Where one setup link stands, by the setupToken it came with: waiting, opened, signing in, done, failed, cancelled or expired, what it sets up, and when it expires. Only the person\'s own links. Reads only; changes nothing.',
    input: schemas.getSetupStatusInput,
    output: schemas.getSetupStatusOutput,
    run: (deps, args) => reads.getSetupStatus(deps, args),
  }),
  export_agents: tool({
    title: 'Export Agents',
    description: 'Export Agents the person can edit as a portable recipe: instructions, skills, models and the connections each one needs, never a key. Omit agentIds to export all of them. Reads only; changes nothing.',
    input: schemas.exportAgentsInput,
    output: schemas.exportAgentsOutput,
    run: (deps, args) => reads.exportAgents(deps, args),
  }),
  list_connected_apps: tool({
    title: 'List connected apps',
    description: 'The apps the signed-in person connected to Chickpea, such as ChatGPT, Claude Code or Codex: each one\'s appId, name, when it was connected, when it was last active, and whether it is the one making this call. Only the person\'s own. Reads only; changes nothing.',
    input: schemas.listConnectedAppsInput,
    output: schemas.listConnectedAppsOutput,
    run: (deps) => reads.listConnectedApps(deps),
  }),
  propose_agent: tool({
    title: 'Propose an Agent',
    description: 'Preview a new Agent before anything exists: its name, @handle and whether the handle is free, its job, a sample Slack exchange, the services to connect after it is created, and the Channels it would answer in. Saves nothing. create holds the exact create_agent arguments; issues lists what to settle first.',
    input: schemas.proposeAgentInput,
    output: schemas.proposeAgentOutput,
    run: (deps, args) => proposeAgent(deps, args),
  }),
  propose_agent_change: tool({
    title: 'Propose an Agent change',
    description: 'Preview an edit to one Agent\'s name, description, handle, instructions, on or off, models or who can edit it: each field before and after, short quotes of an instructions edit, and whether saving needs the person\'s confirmation. Send the version get_agent returned. Saves nothing. Connections and schedules change through their own tools.',
    input: schemas.proposeAgentChangeInput,
    output: schemas.proposeAgentChangeOutput,
    run: (deps, args) => proposeAgentChange(deps, args),
  }),
  get_creation_status: tool({
    title: 'Get Agent creation status',
    description: 'For the creation card: how a new Agent\'s arrival in Slack is going (joining, said hello, ready, or needs attention), whether it has joined its Channels, and the Slack link. Reads only; changes nothing.',
    input: schemas.getCreationStatusInput,
    output: schemas.getCreationStatusOutput,
    visibility: ['app'],
    run: (deps, args) => reads.getCreationStatus(deps, args),
  }),
} as const satisfies Record<string, FiveZeroTool>;

export type FiveZeroToolName = keyof typeof FIVE_ZERO_TOOLS;

/** In registration order, after the 4.x tools. */
export const FIVE_ZERO_TOOL_NAMES = Object.keys(FIVE_ZERO_TOOLS) as FiveZeroToolName[];

/** One schema per 5.0 tool, for request telemetry's refusal check. */
export const FIVE_ZERO_TOOL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = Object.fromEntries(
  FIVE_ZERO_TOOL_NAMES.map((name) => [name, FIVE_ZERO_TOOLS[name].input]),
);

export function registerFiveZeroTools(server: McpServer, deps: FiveZeroDeps): void {
  for (const name of FIVE_ZERO_TOOL_NAMES) register(server, deps, name, FIVE_ZERO_TOOLS[name]);
}

function register(server: McpServer, deps: FiveZeroDeps, name: FiveZeroToolName, definition: FiveZeroTool): void {
  server.registerTool(name, {
    title: definition.title,
    description: definition.description,
    inputSchema: definition.input,
    outputSchema: definition.output,
    annotations: READ_HINTS,
    _meta: toolMeta({
      ...(definition.visibility ? { visibility: definition.visibility } : {}),
      ...(definition.profile ? { profile: definition.profile } : {}),
    }),
  }, async (args) => {
    const startedAt = Date.now();
    try {
      const structured = await definition.run(deps, args);
      emitManagementMetric('tool.call', { surface: 'mcp', tool: name, outcome: 'success', durationMs: Date.now() - startedAt });
      return mcpSuccessResult(structured);
    } catch (error) {
      const failure = mcpToolError(error);
      if (failure.code === 'temporarily_unavailable') {
        console.warn('[chickpea:management] unexpected 5.0 tool failure', JSON.stringify({
          tool: name,
          errorName: error instanceof Error ? error.name : typeof error,
        }));
      }
      emitManagementMetric('tool.call', {
        surface: 'mcp',
        tool: name,
        outcome: 'error',
        reason: failure.code,
        durationMs: Date.now() - startedAt,
      });
      return mcpErrorResult(failure);
    }
  });
}
