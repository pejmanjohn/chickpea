export type AuditDomain = 'memory' | 'scheduled_work' | 'network_event' | 'usage' | 'work';

export type WorkAuditEventType =
  | 'work.run_admitted'
  | 'work.run_recovery_required'
  | 'work.run_quarantined'
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
