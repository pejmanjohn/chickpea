import { AGENT_AUTHORING_GUIDE_URI } from '../agent-authoring/index.ts';
import type { FiveZeroToolName } from './tools.ts';

/**
 * What contract 5.0.0 removed from the management MCP server, and what
 * replaced each: a client still on the 4.x tools, prompts or resources gets
 * an answer that names the replacement (transport.ts), never a bare "not
 * found". The answers stay for every 5.x contract; 6.0 may drop them.
 */

interface RemovedTool {
  /** The 5.0 tools that replace it, typed so renaming one breaks the build rather than the answer. */
  replacedBy: readonly FiveZeroToolName[];
  /** Where a bare list of tools would mislead: the sentence that says how they replace it. */
  use?: string;
  /** What else the model needs, such as an id that carries over. */
  carryOver?: string;
}

export const REMOVED_TOOLS = {
  inspect_workspace: {
    replacedBy: ['get_workspace', 'list_agents', 'get_agent', 'list_services', 'list_models', 'list_members', 'list_slack_channels'],
  },
  prepare_connector_setup: { replacedBy: ['connect_service', 'reconnect_service'] },
  prepare_provider_setup: { replacedBy: ['connect_model_provider'] },
  discover_slack_channels: { replacedBy: ['list_slack_channels'] },
  test_connection: { replacedBy: ['check_agent'] },
  save_connection_key: {
    replacedBy: ['connect_service', 'reconnect_service'],
    use: 'Use connect_service or reconnect_service instead: the setup page asks for the key and checks it.',
  },
  try_connection: {
    replacedBy: ['connect_service'],
    use: 'Use connect_service instead: its setup page checks the key.',
  },
  inspect_memory: { replacedBy: ['get_agent_memory'] },
  inspect_routines: { replacedBy: ['list_schedules'] },
  export_workspace_recipe: { replacedBy: ['export_agents'] },
  preview_workspace_recipe: { replacedBy: ['create_agent', 'update_agent'] },
  import_skill: { replacedBy: ['import_skill_from_github'] },
  upload_skills: { replacedBy: ['upload_skill_files'] },
  manage_agent_skill: { replacedBy: ['set_agent_skill'] },
  apply_workspace_changes: {
    replacedBy: ['create_agent', 'update_agent'],
    use: 'Use one tool per change instead, such as create_agent or update_agent.',
  },
  confirm_workspace_change: {
    replacedBy: ['confirm_change'],
    carryOver: 'A confirmation made before Chickpea 5.0 has expired. Call the 5.0 tool for that change again to get a new preview, then confirm_change.',
  },
  undo_workspace_change: {
    replacedBy: ['undo_change'],
    carryOver: 'undo_change takes the change\'s operationId as its undoToken.',
  },
  get_operation: {
    replacedBy: ['get_setup_status'],
    use: 'Use get_setup_status for a setup link. For a change\'s result, send the change again with the same idempotencyKey.',
    carryOver: 'get_setup_status takes a setup link\'s setupOperationId as its setupToken.',
  },
  revoke_setup_link: { replacedBy: ['cancel_setup_link'] },
  list_mcp_clients: { replacedBy: ['list_connected_apps'] },
  revoke_mcp_client: { replacedBy: ['disconnect_app'] },
} as const satisfies Record<string, RemovedTool>;

export type RemovedToolName = keyof typeof REMOVED_TOOLS;
export const REMOVED_TOOL_NAMES = Object.keys(REMOVED_TOOLS) as RemovedToolName[];

export const REMOVED_PROMPT_NAMES = ['new-agent', 'edit-agent', 'connect', 'schedule', 'import-skill', 'status'] as const;

/** The operation inventory's URI; the `resource` metric label still counts reads of it. */
export const OPERATION_INVENTORY_URI = 'chickpea://schema/operations/v2';
export const WORKSPACE_SNAPSHOT_URI = 'chickpea://workspace';
/** The authoring guide's coding-agent copy went; the Slack copy keeps its URI as the guide's id. */
export const REMOVED_RESOURCE_URIS = [OPERATION_INVENTORY_URI, AGENT_AUTHORING_GUIDE_URI, WORKSPACE_SNAPSHOT_URI] as const;

const REMOVED_TOOL_SET: ReadonlySet<string> = new Set(REMOVED_TOOL_NAMES);
const REMOVED_PROMPT_SET: ReadonlySet<string> = new Set(REMOVED_PROMPT_NAMES);
const REMOVED_RESOURCE_SET: ReadonlySet<string> = new Set(REMOVED_RESOURCE_URIS);

export function removedTool(name: string): name is RemovedToolName {
  return REMOVED_TOOL_SET.has(name);
}

export function removedPrompt(name: string): boolean {
  return REMOVED_PROMPT_SET.has(name);
}

export function removedResource(uri: string): boolean {
  return REMOVED_RESOURCE_SET.has(uri);
}

function listed(tools: readonly string[]): string {
  return tools.length === 1 ? tools[0]! : `${tools.slice(0, -1).join(', ')} or ${tools.at(-1)!}`;
}

/**
 * The answer to a call of a removed tool: an error result, which a client
 * passes to its model. It alone among 5.0 results keeps 4.x's `ok: false`,
 * because only a 4.x caller reaches it and `ok` is what that caller checks:
 * chickpea-cli 0.2 prints `TOOL_TOOL_REMOVED` from it. Every name it gives is
 * a 5.0 tool, but for the removed one called.
 */
export function removedToolResult(name: RemovedToolName) {
  const tool: RemovedTool = REMOVED_TOOLS[name];
  const message = [
    `Chickpea 5.0 removed ${name}.`,
    tool.use ?? `Use ${listed(tool.replacedBy)} instead.`,
    'Start a new session or reconnect Chickpea to load the 5.0 tools.',
    'If you use chickpea-cli, update it with npx chickpea-cli@latest.',
  ].join(' ');
  const nextStep = [
    'This session\'s Chickpea tool list is out of date. Tell the person, and name the tools above.',
    ...tool.carryOver ? [tool.carryOver] : [],
  ].join(' ');
  const error = { code: 'tool_removed' as const, message, retryable: false, nextStep, replacedBy: [...tool.replacedBy] };
  return {
    content: [{ type: 'text' as const, text: `${message}\n${nextStep}` }],
    structuredContent: { ok: false as const, error },
    isError: true as const,
  };
}

/** The message of the protocol error a removed prompt gets. */
export function removedPromptMessage(name: string): string {
  return `Chickpea 5.0 removed the ${name} command. Start a new session, then ask for what you want in plain words.`;
}

/** The message of the protocol error a removed resource gets. */
export const REMOVED_RESOURCE_MESSAGE =
  'Chickpea 5.0 removed this resource. Call get_guide for guidance, or get_workspace and list_agents for the workspace.';
