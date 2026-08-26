import type { ManagementOperation } from './types.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from './agent-authoring/index.ts';

export type ManagementMetricValue = boolean | number | string;

export type AgentAuthoringArtifactClass =
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
  'conflictCount',
  'durationMs',
  'guideVersion',
  'handoffClass',
  'operation',
  'operationCount',
  'outcome',
  'posture',
  'proposalOutcome',
  'reason',
  'setupRequiredCount',
  'stage',
  'staleReason',
  'surface',
  'tool',
]);

const MANAGEMENT_METRIC_EVENTS = new Set([
  'agent_authoring.outcome',
  'live_revision.admission',
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
    'api_oauth', 'api_credential', 'exchange', 'live', 'mcp_oauth',
    'mcp_credentials', 'provider_credential', 'repository_access', 'snapshot',
  ]),
  operation: new Set([
    'create_agent', 'update_agent', 'delete_agent', 'archive_agent', 'restore_agent', 'put_channel',
    'grant_agent_channel', 'revoke_agent_channel',
    'update_member', 'remove_provider_credential',
    'update_agent_memory', 'save_routine', 'control_routine', 'delete_routine',
    'request_setup',
  ]),
  artifactClass: new Set([
    'identity', 'instructions', 'skill', 'memory', 'connection', 'repository',
    'schedule', 'model', 'slack_presence', 'reach', 'edit_authority', 'mixed', 'other',
  ]),
  guideVersion: new Set([AGENT_AUTHORING_GUIDE_VERSION]),
  handoffClass: new Set(['cross_agent', 'workspace_authority', 'none']),
  outcome: new Set([
    'admitted', 'applied', 'completed', 'confirmation_required', 'delivered',
    'chickpea_handoff', 'denied', 'error', 'failed', 'partial', 'retry', 'setup_required',
    'skipped', 'success',
  ]),
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
    'inspect_workspace', 'prepare_connector_setup', 'discover_slack_channels', 'test_mcp_connection',
    'inspect_memory', 'inspect_routines',
    'export_workspace_recipe', 'preview_workspace_recipe',
    'propose_workspace_changes', 'apply_workspace_changes', 'confirm_workspace_change',
    'undo_workspace_change', 'get_operation', 'revoke_setup_link',
  ]),
};

const REASON_TOKENS = new Set([
  'capability_scope_expansion', 'credential_replacement', 'dependency_not_applied',
  'chickpea_handoff',
  'forbidden', 'idempotency_conflict', 'insufficient_scope', 'invalid_request',
  'invalid_state', 'invalid_token', 'live_access_denied', 'management_error',
  'missing_token', 'operation_in_progress', 'operation_not_found', 'other',
  'operational_access_required', 'owner_required', 'proposal_binding_mismatch', 'proposal_expired',
  'proposal_not_found', 'proposal_stale', 'revision_conflict', 'setup_expired',
  'base_agent_capabilities_require_setup',
  'setup_failed', 'setup_not_found', 'setup_session_mismatch', 'setup_unavailable',
  'target_changed', 'undo_unavailable', 'validation_failed',
  'archive_agent_reach', 'restore_agent_reach',
  'paid_plan_required', 'user_group_policy_denied', 'two_factor_required',
  'handle_collision', 'invalid_handle', 'channel_membership_required',
  'private_channel_invite_required', 'rate_limited', 'user_group_create_ambiguous',
  'slack_unavailable', 'slack_operation_failed',
]);

export interface ManagementTelemetrySink {
  info(message: string): void;
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
    event: MANAGEMENT_METRIC_EVENTS.has(eventToken) ? eventToken : 'other',
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!MANAGEMENT_METRIC_FIELDS.has(key)) continue;
    if (typeof value === 'string') payload[key] = safeFieldToken(key, value);
    else if (typeof value === 'number' && Number.isFinite(value)) payload[key] = Math.max(0, value);
    else if (typeof value === 'boolean') payload[key] = value;
  }
  try {
    sink.info(`[chickpea:management] ${JSON.stringify(payload)}`);
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
      case 'save_routine':
      case 'control_routine':
      case 'delete_routine':
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
  const token = safeToken(value);
  if (token === 'other') return token;
  if (key === 'reason') {
    return REASON_TOKENS.has(token) || /^http_[1-5][0-9]{2}$/.test(token) ? token : 'other';
  }
  const allowed = METRIC_TOKENS[key];
  return allowed?.has(token) ? token : 'other';
}
