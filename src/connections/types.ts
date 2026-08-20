import type {
  AgentConnectionBinding,
  ConnectionAccount,
  ConnectionAccountPolicy,
} from '../config/types.ts';

export type ConnectionAccountView = Omit<ConnectionAccount, 'secretRefId'> & {
  credentialConfigured: boolean;
};

export interface EffectiveConnectionAccount {
  account: ConnectionAccount;
  binding: AgentConnectionBinding;
  policy: ConnectionAccountPolicy;
  scope: 'team' | 'personal';
}

export type ConnectionSelection =
  | { kind: 'selected'; connection: EffectiveConnectionAccount; reason: 'only_eligible' | 'language' }
  | { kind: 'missing'; providerId: string }
  | { kind: 'ambiguous'; providerId: string; choices: EffectiveConnectionAccount[] };

export type OAuthContinuationStatus =
  | 'pending'
  | 'authorized'
  | 'resumed'
  | 'cancelled'
  | 'expired';

export interface OAuthContinuation {
  id: string;
  workspaceId: string;
  actorMembershipId: string;
  agentId: string;
  channelId: string;
  threadTs: string;
  taskId: string;
  providerId: string;
  accountId: string;
  stateHash: string;
  status: OAuthContinuationStatus;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export interface OAuthContinuationResult {
  continuation: OAuthContinuation;
  state: string;
}

