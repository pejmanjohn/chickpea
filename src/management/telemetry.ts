export type ManagementMetricValue = boolean | number | string;

const MANAGEMENT_METRIC_FIELDS = new Set([
  'action',
  'agentCount',
  'channelCount',
  'conflictCount',
  'durationMs',
  'operation',
  'operationCount',
  'outcome',
  'reason',
  'setupRequiredCount',
  'stage',
  'surface',
  'tool',
]);

const MANAGEMENT_METRIC_EVENTS = new Set([
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
  outcome: new Set([
    'admitted', 'applied', 'completed', 'confirmation_required', 'delivered',
    'denied', 'error', 'failed', 'partial', 'retry', 'setup_required',
    'skipped', 'success',
  ]),
  stage: new Set([
    'authorization_server', 'bearer', 'exchange', 'membership', 'quota',
    'registration', 'resource', 'scope', 'validation',
  ]),
  surface: new Set(['admin', 'mcp', 'service', 'setup', 'slack', 'unknown']),
  tool: new Set([
    'inspect_workspace', 'discover_slack_channels', 'test_mcp_connection',
    'inspect_memory', 'inspect_routines',
    'export_workspace_recipe', 'preview_workspace_recipe',
    'apply_workspace_changes', 'confirm_workspace_change',
    'undo_workspace_change', 'get_operation', 'revoke_setup_link',
  ]),
};

const REASON_TOKENS = new Set([
  'capability_scope_expansion', 'credential_replacement', 'dependency_not_applied',
  'forbidden', 'idempotency_conflict', 'insufficient_scope', 'invalid_request',
  'invalid_state', 'invalid_token', 'live_access_denied', 'management_error',
  'missing_token', 'operation_in_progress', 'operation_not_found', 'other',
  'operational_access_required', 'owner_required', 'proposal_binding_mismatch', 'proposal_expired',
  'proposal_not_found', 'proposal_stale', 'revision_conflict', 'setup_expired',
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
