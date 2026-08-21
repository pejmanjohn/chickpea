export type AuditDomain =
  | 'identity'
  | 'memory'
  | 'scheduled_work'
  | 'network_event'
  | 'usage'
  | 'work'
  | 'management';

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
