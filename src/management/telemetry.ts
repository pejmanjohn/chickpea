import { createHash } from 'node:crypto';
import type { FlueObservation } from '@flue/runtime';
import { MCP_CLIENT_REGISTRATION_DENIALS } from '../auth/mcp-oauth.ts';
import type { ManagementOperation } from './types.ts';
import {
  AGENT_AUTHORING_GUIDE_URI,
  AGENT_AUTHORING_GUIDE_VERSION,
  DISCOVERY_GUIDE_URI,
} from './agent-authoring/index.ts';
import { MANAGEMENT_OPERATION_SCHEMA_URI } from './schemas.ts';

export type ManagementMetricValue = boolean | number | string;

type AgentAuthoringArtifactClass =
  | 'identity'
  | 'instructions'
  | 'skill'
  | 'memory'
  | 'connection'
  | 'repository'
  | 'schedule'
  | 'model'
  | 'slack_presence'
  | 'reach'
  | 'edit_authority'
  | 'mixed'
  | 'other';

const MANAGEMENT_METRIC_FIELDS = new Set([
  'action',
  'agentCount',
  'artifactClass',
  'channelCount',
  'client',
  'conflictCount',
  'connectorActionCount',
  'connectorNoticeCount',
  'deliveryPersona',
  'durationMs',
  'errorCode',
  'guideVersion',
  'handoffClass',
  'method',
  'operation',
  'operationCount',
  'outcome',
  'posture',
  'publicationStatus',
  'proposalOutcome',
  'reason',
  'resource',
  'setupRequiredCount',
  'stage',
  'staleReason',
  'surface',
  'tool',
]);

const MANAGEMENT_METRIC_EVENTS = new Set([
  'agent_creation.outcome',
  'agent_creation.welcome_claim',
  'agent_creation.welcome_delivery',
  'agent_authoring.outcome',
  'live_revision.admission',
  'mcp.request',
  'oauth.dcr',
  'oauth.discovery',
  'oauth.request',
  'oauth.token',
  'operation.outcome',
  'receipt.delivery',
  'recipe.preview',
  'setup.lifecycle',
  'tool.call',
]);

const METRIC_TOKENS: Readonly<Record<string, ReadonlySet<string>>> = {
  action: new Set([
    'api_oauth', 'api_credential', 'catalog_connection', 'exchange', 'live', 'mcp_oauth',
    'mcp_credentials', 'provider_credential', 'repository_access', 'snapshot',
  ]),
  operation: new Set([
    'create_agent', 'update_agent', 'delete_agent', 'archive_agent', 'restore_agent', 'put_channel',
    'grant_agent_channel', 'revoke_agent_channel', 'disconnect_connection', 'remove_website_login',
    'update_member', 'remove_provider_credential', 'set_workspace_model', 'set_agent_image_model',
    'update_agent_memory', 'save_routine', 'control_routine', 'run_routine', 'delete_routine',
    'reassign_routine_agent',
    'take_over_routine',
    'request_setup',
  ]),
  artifactClass: new Set([
    'identity', 'instructions', 'skill', 'memory', 'connection', 'repository',
    'schedule', 'model', 'slack_presence', 'reach', 'edit_authority', 'mixed', 'other',
  ]),
  // The MCP client, by clientInfo.name; see management/mcp-request-telemetry.ts.
  client: new Set([
    'openai-mcp', 'openai-mcp-codex', 'codex-mcp-client', 'claude-code', 'claude-ai',
    'gemini-cli-mcp-client', 'chickpea-cli', 'other', 'unknown',
  ]),
  guideVersion: new Set([AGENT_AUTHORING_GUIDE_VERSION]),
  handoffClass: new Set(['cross_agent', 'workspace_authority', 'none']),
  outcome: new Set([
    'admitted', 'applied', 'completed', 'confirmation_required', 'delivered',
    'chickpea_handoff', 'clarification', 'created', 'denied', 'error', 'failed', 'partial',
    'replayed', 'retry', 'setup_required', 'skipped', 'success',
    'abandoned', 'input_refused', 'jsonrpc_error', 'received', 'tool_error',
  ]),
  deliveryPersona: new Set(['agent', 'chickpea']),
  publicationStatus: new Set(['complete', 'partial']),
  posture: new Set(['commit', 'explore', 'capability_question', 'clarify']),
  proposalOutcome: new Set([
    'created', 'applied', 'partial', 'setup_required', 'stale', 'denied', 'failed',
  ]),
  stage: new Set([
    'authorization_server', 'bearer', 'exchange', 'membership', 'quota',
    'registration', 'resource', 'scope', 'validation',
  ]),
  staleReason: new Set([
    'binding', 'digest_mismatch', 'expired', 'permission_changed', 'target_revision', 'unknown',
  ]),
  surface: new Set(['admin', 'mcp', 'service', 'setup', 'slack', 'unknown']),
  tool: new Set([
    'inspect_workspace', 'prepare_connector_setup', 'prepare_provider_setup',
    'discover_slack_channels', 'test_connection', 'save_connection_key', 'try_connection',
    'inspect_memory', 'inspect_routines',
    'export_workspace_recipe', 'preview_workspace_recipe',
    'import_skill', 'upload_skills', 'manage_agent_skill', 'propose_skill_import',
    'propose_workspace_changes', 'apply_workspace_changes', 'confirm_workspace_change',
    'undo_workspace_change', 'get_operation', 'revoke_setup_link',
    'list_mcp_clients', 'revoke_mcp_client',
    // 5.0 tools (management/mcp-v5/tools.ts).
    'get_account', 'get_workspace', 'get_guide', 'list_agents', 'get_agent', 'list_services', 'get_service', 'list_models',
    'list_members', 'list_slack_channels', 'get_agent_memory', 'list_schedules', 'get_setup_status',
    'export_agents', 'list_connected_apps', 'propose_agent', 'propose_agent_change',
    'get_creation_status', 'practice_agent', 'get_practice_run', 'list_practice_runs', 'explain_agent', 'check_agent',
    'create_agent', 'update_agent', 'update_agent_memory', 'archive_agent', 'restore_agent',
    'add_agent_to_channel', 'save_channel_settings', 'import_skill_from_github', 'upload_skill_files', 'set_agent_skill',
    'save_schedule', 'pause_schedule', 'resume_schedule', 'run_schedule_now', 'take_over_schedule',
    'set_workspace_model', 'connect_model_provider', 'confirm_change', 'decline_change', 'get_confirmation', 'undo_change',
    'connect_service', 'reconnect_service', 'update_connection', 'remove_connection', 'set_agent_repositories',
    'delete_agent', 'remove_website_login', 'remove_agent_from_channel', 'delete_schedule',
    'remove_model_provider_key', 'update_member', 'cancel_setup_link', 'disconnect_app',
    'list_agent_runs', 'get_agent_run',
  ]),
};

/** Tokens with `/` or `:`, which `safeToken` refuses, matched exactly. */
const EXACT_METRIC_TOKENS: Readonly<Record<string, ReadonlySet<string>>> = {
  method: new Set([
    'initialize', 'ping', 'server/discover', 'tools/list', 'tools/call',
    'resources/list', 'resources/templates/list', 'resources/read',
    'resources/subscribe', 'resources/unsubscribe', 'prompts/list', 'prompts/get',
    'completion/complete', 'logging/setLevel', 'subscriptions/listen',
    'notifications/initialized', 'notifications/cancelled', 'notifications/progress',
    'notifications/roots/list_changed',
  ]),
  // Chickpea's own static guides only: any other URI can carry an identifier.
  resource: new Set([AGENT_AUTHORING_GUIDE_URI, DISCOVERY_GUIDE_URI, MANAGEMENT_OPERATION_SCHEMA_URI]),
};

const REASON_TOKENS = new Set([
  'capability_scope_expansion', 'credential_replacement', 'dependency_not_applied',
  'chickpea_handoff', 'confirmation_needs_own_call',
  'forbidden', 'idempotency_conflict', 'insufficient_scope', 'invalid_request',
  'invalid_state', 'invalid_token', 'key_rejected', 'key_unconfirmed', 'live_access_denied', 'management_error',
  'management_outcome_unknown',
  'missing_token', 'operation_in_progress', 'operation_not_found', 'other',
  'operational_access_required', 'owner_required', 'proposal_binding_mismatch',
  'proposal_not_found', 'proposal_stale', 'proposal_expired', 'removal_incomplete', 'revision_conflict', 'setup_expired',
  'base_agent_capabilities_require_setup',
  'setup_failed', 'setup_not_found', 'setup_session_mismatch', 'setup_unavailable',
  'target_changed', 'undo_unavailable', 'validation_failed', 'mcp_client_not_found',
  'routines_unavailable_on_target', 'schedule_authority_missing',
  'archive_agent_reach', 'restore_agent_reach',
  'schedule_agent_reassignment',
  'paid_plan_required', 'user_group_policy_denied', 'two_factor_required',
  'handle_collision', 'name_collision', 'invalid_handle', 'channel_membership_required',
  'private_channel_invite_required', 'rate_limited', 'user_group_create_ambiguous',
  'slack_unavailable', 'slack_operation_failed', 'agent_off',
  // 5.0 error codes (management/mcp-v5/conventions.ts) not already above.
  'not_allowed', 'not_found', 'invalid_input', 'changed_since_read', 'confirmation_expired',
  'in_progress', 'key_reused', 'still_in_use', 'setup_link_unusable', 'model_unavailable',
  'schedule_unavailable', 'nothing_to_undo', 'usage_limit', 'temporarily_unavailable', 'tool_removed',
  'needs_setup', 'not_testable', 'test_run_unavailable',
  ...MCP_CLIENT_REGISTRATION_DENIALS,
]);

interface ManagementTelemetrySink {
  info(record: Record<string, unknown>): void;
}

/**
 * Emit one content-free management metric. Only allowlisted fields and short
 * machine tokens cross this boundary: no actor, workspace, object, recipe,
 * prompt, account, credential, URL, or error text is accepted.
 */
export function emitManagementMetric(
  event: string,
  fields: Readonly<Record<string, ManagementMetricValue>> = {},
  sink: ManagementTelemetrySink = console,
): void {
  const eventToken = safeToken(event);
  const payload: Record<string, ManagementMetricValue> = {
    component: 'management',
    event: MANAGEMENT_METRIC_EVENTS.has(eventToken) ? eventToken : 'other',
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!MANAGEMENT_METRIC_FIELDS.has(key)) continue;
    if (typeof value === 'string') payload[key] = safeFieldToken(key, value);
    else if (typeof value === 'number' && Number.isFinite(value)) payload[key] = Math.max(0, value);
    else if (typeof value === 'boolean') payload[key] = value;
  }
  try {
    sink.info(payload);
  } catch {
    // Observability is best effort and never changes control-plane behavior.
  }
}

/** Reduce exact operations to a content-free Agent-authoring primitive. */
export function agentAuthoringArtifactClass(
  operations: readonly ManagementOperation[],
): AgentAuthoringArtifactClass {
  const classes = new Set<Exclude<AgentAuthoringArtifactClass, 'mixed'>>();
  for (const operation of operations) {
    switch (operation.kind) {
      case 'create_agent':
        classes.add('identity');
        if (operation.agent.instructions) classes.add('instructions');
        if (operation.agent.skills.length > 0) classes.add('skill');
        if (operation.agent.model) classes.add('model');
        if (operation.agent.requestedHandle) classes.add('slack_presence');
        if (operation.agent.editPolicy) classes.add('edit_authority');
        break;
      case 'update_agent':
        if ('name' in operation.patch || 'description' in operation.patch) classes.add('identity');
        if ('instructions' in operation.patch) classes.add('instructions');
        if ('skills' in operation.patch) classes.add('skill');
        if ('model' in operation.patch) classes.add('model');
        if ('requestedHandle' in operation.patch || 'slackPresence' in operation.patch) {
          classes.add('slack_presence');
        }
        if ('editPolicy' in operation.patch) classes.add('edit_authority');
        if ('mcpServers' in operation.patch || 'apiConnections' in operation.patch) {
          classes.add('connection');
        }
        if ('repositories' in operation.patch) classes.add('repository');
        break;
      case 'update_agent_memory':
        classes.add('memory');
        break;
      case 'set_workspace_model':
      case 'set_agent_image_model':
        classes.add('model');
        break;
      case 'save_routine':
      case 'control_routine':
      case 'run_routine':
      case 'delete_routine':
      case 'reassign_routine_agent':
      case 'take_over_routine':
        classes.add('schedule');
        break;
      case 'grant_agent_channel':
      case 'revoke_agent_channel':
      case 'put_channel':
      case 'archive_agent':
      case 'restore_agent':
      case 'delete_agent':
        classes.add('reach');
        break;
      case 'request_setup':
        if (operation.target.kind === 'repository_access') classes.add('repository');
        else classes.add('connection');
        break;
      case 'update_member':
        classes.add('edit_authority');
        break;
      case 'remove_provider_credential':
      case 'disconnect_connection':
      case 'remove_website_login':
        classes.add('connection');
        break;
      default:
        classes.add('other');
    }
  }
  if (classes.size === 0) return 'other';
  if (classes.size > 1) return 'mixed';
  return [...classes][0]!;
}

function safeToken(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value) ? value : 'other';
}

function safeFieldToken(key: string, value: string): string {
  const exact = EXACT_METRIC_TOKENS[key];
  if (exact) return exact.has(value) ? value : 'other';
  // JSON-RPC error codes are negative, which the number path clamps to zero.
  if (key === 'errorCode') return /^-?[0-9]{1,6}$/.test(value) ? value : 'other';
  const token = safeToken(value);
  if (token === 'other') return token;
  if (key === 'reason') {
    return REASON_TOKENS.has(token) || /^http_[1-5][0-9]{2}$/.test(token) ? token : 'other';
  }
  const allowed = METRIC_TOKENS[key];
  return allowed?.has(token) ? token : 'other';
}

/** Tool failures, including schema rejection before the tool handler runs.
 * Keep correlation IDs and known field names, never arguments or error text.
 * The digest identifies repeated failures/static throw sites without publishing
 * messages that can contain requester-authored values.
 */
export function emitManagementToolFailure(
  observation: FlueObservation,
  sink: ManagementTelemetrySink = console,
): void {
  if (observation.type !== 'tool' || !observation.isError || ![
    'manage_scheduled_work', 'propose_workspace_changes', 'confirm_workspace_change',
  ].includes(observation.toolName)) return;
  try {
    const error = observation.errorInfo;
    const knownFields = new Set([
      'action', 'name', 'description', 'taskText', 'scheduleKind', 'cronExpression',
      'timezone', 'localDateTime', 'minutes', 'outputPolicy', 'delivery', 'routineId',
      'expectedVersion', 'ownerAgentId', 'idempotencyKey', 'guideVersion',
      'authoringReason', 'operations', 'itemId', 'kind', 'agentId',
      'expectedRevision', 'patch', 'instructions', 'proposalId',
    ]);
    const issues = error?.meta?.issues;
    const fields = new Set<string>(Array.isArray(issues) ? issues.flatMap((issue) =>
      issue && Array.isArray(issue.path)
        ? issue.path.filter((field: unknown) => typeof field === 'string' && knownFields.has(field))
        : [],
    ) : []);
    // Pi's JSON-schema precheck happens before Flue's handler wrapper. It
    // returns text rather than throwing through errorInfo. Discard the entire
    // Received arguments section, and project only recognized validation data.
    const result = observation.result as { content?: { type?: string; text?: string }[] } | undefined;
    const validation = result?.content?.find((part) => part.type === 'text' &&
      part.text?.startsWith(`Validation failed for tool "${observation.toolName}":\n`))
      ?.text?.split('\n\nReceived arguments:')[0];
    const validationCodes = new Set<string>();
    if (validation) {
      for (const line of validation.split('\n').slice(1)) {
        const path = line.match(/^  - ([^:]+):/)?.[1];
        for (const field of path?.split('.') ?? []) if (knownFields.has(field)) fields.add(field);
        for (const [phrase, code] of [
          ['additional properties', 'additional_properties'], ['required', 'required'],
          ['constant', 'const'], ['type', 'type'], ['anyOf', 'any_of'], ['pattern', 'pattern'],
        ]) if (line.toLowerCase().includes(phrase!.toLowerCase())) validationCodes.add(code!);
      }
    }
    sink.info({
      component: 'management',
      event: 'tool.validation_failure', tool: observation.toolName,
      ...diagnosticCorrelation(observation),
      errorType: validation ? 'schema_validation' : ['ManagementError', 'ToolInputValidationError', 'ToolOutputValidationError']
        .includes(error?.name ?? '') ? error!.name : 'other',
      code: validation ? 'validation_failed' : safeFieldToken('reason', error?.code ?? 'other'),
      fields: [...fields].sort(), validationCodes: [...validationCodes].sort(),
      messageDigest: typeof (validation ?? error?.message) === 'string'
        ? createHash('sha256').update((validation ?? error!.message)!).digest('hex') : undefined,
    });
  } catch {
    // A diagnostic cannot change the tool's outcome.
  }
}

function diagnosticCorrelation(source: object): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['instanceId', 'submissionId', 'conversationId', 'toolCallId', 'turnJobId', 'messageTs']) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) result[key] = value;
  }
  return result;
}

interface ToolInputIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
}

const ZOD_ISSUE_CODES = new Set([
  'custom', 'invalid_element', 'invalid_format', 'invalid_key', 'invalid_type',
  'invalid_union', 'invalid_value', 'not_multiple_of', 'too_big', 'too_small',
  'unrecognized_keys',
]);

/**
 * An MCP `tools/call` the SDK refused on its input schema, so the handler and
 * `tool.call` never ran. Same event as the Flue surface. Each field is a path of
 * schema property names and array indexes; any other key (a record key, an
 * unrecognized key) becomes `*`, so no requester-authored text crosses.
 */
export function emitMcpToolInputRefusal(
  tool: string,
  issues: readonly ToolInputIssue[],
  propertyNames: ReadonlySet<string>,
  sink: ManagementTelemetrySink = console,
): void {
  const fields = new Set<string>();
  const validationCodes = new Set<string>();
  for (const issue of issues) {
    if (ZOD_ISSUE_CODES.has(issue.code)) validationCodes.add(issue.code);
    if (issue.path.length === 0) continue;
    fields.add(issue.path.map((segment) => typeof segment === 'number'
      ? String(segment)
      : typeof segment === 'string' && propertyNames.has(segment) ? segment : '*').join('.'));
  }
  try {
    sink.info({
      component: 'management',
      event: 'tool.validation_failure',
      surface: 'mcp',
      tool: safeFieldToken('tool', tool),
      errorType: 'schema_validation',
      code: 'validation_failed',
      fields: [...fields].sort(),
      validationCodes: [...validationCodes].sort(),
    });
  } catch {
    // A diagnostic cannot change the tool's outcome.
  }
}
