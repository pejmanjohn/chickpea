export type AuditDomain = 'memory' | 'scheduled_work' | 'network_event';

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
  storeId?: string;
  channelId?: string;
  limit?: number;
}
