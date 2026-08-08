export type AuditDomain =
  | 'identity'
  | 'memory'
  | 'scheduled_work'
  | 'network_event'
  | 'usage'
  | 'work'
  | 'slack_identity';

export type SlackIdentityAuditEventType =
  | 'slack_identity.setup_started'
  | 'slack_identity.credentials_connected'
  | 'slack_identity.credentials_rotated'
  | 'slack_identity.credentials_disconnected'
  | 'slack_identity.setup_verified'
  | 'slack_identity.refreshed'
  | 'slack_identity.profile_attached'
  | 'slack_identity.dm_binding_changed'
  | 'slack_identity.setup_canceled'
  | 'slack_identity.retired';

export interface SlackIdentityAuditMetadata {
  operation: string;
  priorLifecycle: string;
  newLifecycle: string;
  requestId: string;
}

export type WorkAuditEventType =
  | 'work.run_admitted'
  | 'work.run_claimed'
  | 'work.run_lease_renewed'
  | 'work.run_requeued'
  | 'work.run_recovery_required'
  | 'work.run_quarantined'
  | 'work.input_prepared'
  | 'work.execution_created'
  | 'work.execution_route_recorded'
  | 'work.execution_invoked'
  | 'work.execution_settled'
  | 'work.response_recorded'
  | 'work.delivery_started'
  | 'work.delivery_delivered'
  | 'work.delivery_failed'
  | 'work.delivery_unknown'
  | 'work.run_settled_without_delivery'
  | 'work.action_denied'
  | 'work.action_started'
  | 'work.action_succeeded'
  | 'work.action_failed'
  | 'work.action_unknown';

export interface WorkActionAuditMetadata {
  actionAttemptId: string;
  runId: string;
  runExecutionId: string;
  actionClass: string;
  targetKind: string;
  flueCorrelation: string;
  status: 'denied' | 'started' | 'succeeded' | 'failed' | 'unknown';
}

export interface AuditEvent {
  eventId: string;
  domain: AuditDomain;
  eventType: string;
  outcome: 'success' | 'denied' | 'conflict' | 'failure' | 'requested';
  actorClass: string;
  actorId: string | null;
  workspaceId: string | null;
  channelId: string | null;
  storeId: string | null;
  subjectId: string | null;
  subjectVersion: number | null;
  createdAt: number;
  reasonCode: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  metadataJson: string;
  idempotencyKey: string | null;
}

export interface AppendAuditEvent {
  eventId: string;
  domain: AuditDomain;
  eventType: string;
  outcome: AuditEvent['outcome'];
  actorClass: string;
  actorId?: string | null;
  workspaceId?: string | null;
  channelId?: string | null;
  storeId?: string | null;
  subjectId?: string | null;
  subjectVersion?: number | null;
  createdAt: number;
  reasonCode?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  metadataJson?: string;
  idempotencyKey?: string | null;
}

export interface AuditEventFilter {
  domain?: AuditDomain;
  eventType?: string;
  idempotencyKey?: string;
  subjectId?: string;
  subjectIds?: string[];
  storeId?: string;
  channelId?: string;
  limit?: number;
}
