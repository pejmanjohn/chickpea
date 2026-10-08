import type { SemanticActivityDescriptor, SemanticTargetFamily } from '../activity/semantic.ts';
import { BROWSER_TOOL_NAMES } from '../browser/tools.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../connections/catalog/index.ts';
import { ATTACH_FILE_TO_CONNECTION_TOOL_NAME } from '../connections/file-upload-tool.ts';
import { CONNECTION_REQUEST_TOOL_NAME } from '../connections/request-tool.ts';
import { WORKSPACE_MANAGEMENT_TOOL_NAMES } from '../management/tool-adapter.ts';
import { POST_ARTIFACT_TOOL_NAME } from '../sandbox/artifact-tool.ts';
import { GENERATE_IMAGE_TOOL_NAME } from '../sandbox/image-tool.ts';
import { WORKSPACE_TOOL_NAMES } from '../sandbox/workspace-tools.ts';
import { COMPLETE_FILE_DELIVERY_TOOL } from '../slack/file-delivery-completion.ts';
import type { SLACK_LIST_TOOL_NAMES } from '../slack/lists/tools.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../slack/presentation-intent.ts';
import type { SLACK_READ_TOOL_NAMES } from '../slack/reading/tools.ts';
import { SLACK_PRESENT_TABLE_TOOL_NAME } from '../slack/table-presentation.ts';
import {
  SLACK_ASK_USER_TOOL_NAME,
  SLACK_OFFER_ACTIONS_TOOL_NAME,
  SLACK_PRESENT_CARDS_TOOL_NAME,
  SLACK_PRESENT_CHART_TOOL_NAME,
  SLACK_PRESENT_DETAILS_TOOL_NAME,
  SLACK_REQUEST_FORM_TOOL_NAME,
} from '../slack/ui/presentation-tools.ts';

/** A run a person asked for in Slack, or a scheduled run. */
export type RunKind = 'interactive' | 'scheduled';

export type RunAction =
  | { readonly kind: 'tool'; readonly toolName: string; readonly descriptor: SemanticActivityDescriptor | undefined }
  /** A scheduled run delivering its result. */
  | { readonly kind: 'post' };

// Keyed by the exported name lists: a name added to one fails to compile until
// it is classified here.
const SLACK_READ_TOOLS: Record<(typeof SLACK_READ_TOOL_NAMES)[number], boolean> = {
  read_slack_channel: true,
  read_slack_thread: false,
  lookup_slack_user: false,
};

const SLACK_LIST_TOOLS: Record<(typeof SLACK_LIST_TOOL_NAMES)[number], boolean> = {
  read_slack_list: true,
  read_slack_list_item: true,
  create_slack_list_item: true,
  update_slack_list_item: true,
  create_slack_task_list: true,
  share_slack_list: true,
};

const QUALIFYING_TOOLS: readonly string[] = [
  ...MANAGED_CONNECTOR_CATALOG.list().flatMap(({ capabilities }) => capabilities.map(({ toolName }) => toolName)),
  CONNECTION_REQUEST_TOOL_NAME,
  ATTACH_FILE_TO_CONNECTION_TOOL_NAME,
  ...BROWSER_TOOL_NAMES,
  ...WORKSPACE_TOOL_NAMES,
];

const NON_QUALIFYING_TOOLS: readonly string[] = [
  ...WORKSPACE_MANAGEMENT_TOOL_NAMES,
  'manage_scheduled_work',
  'update_agent_memory',
  'authorize_personal_connection',
  'request_chickpea_handoff',
  'activate_skill',
  'read_skill_resource',
  POST_ARTIFACT_TOOL_NAME,
  COMPLETE_FILE_DELIVERY_TOOL,
  GENERATE_IMAGE_TOOL_NAME,
  'recover_image',
  SLACK_PRESENT_TABLE_TOOL_NAME,
  SLACK_STREAM_ANSWER_TOOL_NAME,
  SLACK_ASK_USER_TOOL_NAME,
  SLACK_OFFER_ACTIONS_TOOL_NAME,
  SLACK_PRESENT_CARDS_TOOL_NAME,
  SLACK_PRESENT_CHART_TOOL_NAME,
  SLACK_PRESENT_DETAILS_TOOL_NAME,
  SLACK_REQUEST_FORM_TOOL_NAME,
  'submit_routine_result',
  'submit_routine_intent',
  // The sandbox these work in holds only the current message's files and the
  // reply's staged files, which are absorbed or are artifacts.
  'bash', 'read', 'write', 'edit', 'grep', 'glob', 'task',
];

function closedTable(): ReadonlyMap<string, boolean> {
  const table = new Map<string, boolean>();
  const entries: [string, boolean][] = [
    ...Object.entries(SLACK_READ_TOOLS),
    ...Object.entries(SLACK_LIST_TOOLS),
    ...QUALIFYING_TOOLS.map((name): [string, boolean] => [name, true]),
    ...NON_QUALIFYING_TOOLS.map((name): [string, boolean] => [name, false]),
  ];
  for (const [name, qualifies] of entries) {
    if (table.has(name)) throw new Error(`Tool ${name} is classified twice`);
    table.set(name, qualifies);
  }
  return table;
}

/** Every tool Core registers by a fixed name, and whether calling it makes an interactive run a task. */
export const TASK_TOOL_TABLE: ReadonlyMap<string, boolean> = closedTable();

const MCP_TOOL_PREFIX = 'mcp__';

const TASK_FAMILIES: ReadonlySet<SemanticTargetFamily> = new Set(['managed_connector', 'custom_connection']);

/** Whether an action makes a run a task, which posts the run's task fee row. */
export function qualifiesAsTask(runKind: RunKind, action: RunAction): boolean {
  if (runKind === 'scheduled') return action.kind === 'post';
  if (action.kind === 'post') return false;
  const named = TASK_TOOL_TABLE.get(action.toolName);
  if (named !== undefined) return named;
  if (action.toolName.startsWith(MCP_TOOL_PREFIX)) return true;
  return action.descriptor !== undefined && TASK_FAMILIES.has(action.descriptor.target);
}
