import type {
  AgentConnectionBinding,
  ConnectionAccount,
  ConnectionAccountManagedPolicy,
  ConnectionAccountPolicy,
  ManagedBindingResourceConstraints,
} from '../config/types.ts';

export type ManagedConnectionAccountViewPolicy = Omit<
  ConnectionAccountManagedPolicy,
  'principalRef' | 'accountRef' | 'resourceConstraints'
> & {
  resourceConstraints?: Record<string, Array<{ handle: string; label: string }>>;
};

export type ConnectionAccountView = Omit<ConnectionAccount, 'secretRefId' | 'policy'> & {
  policy: Exclude<ConnectionAccountPolicy, ConnectionAccountManagedPolicy> |
    ManagedConnectionAccountViewPolicy;
  credentialConfigured: boolean;
};

export interface EffectiveConnectionAccount {
  account: ConnectionAccount;
  binding: AgentConnectionBinding;
  policy: ConnectionAccountPolicy;
  scope: 'team' | 'personal';
}

/** Secret-free managed connection declaration safe to freeze in a runtime plan. */
export interface ManagedConnectionDeclaration {
  id: string;
  providerId: string;
  adapterId: string;
  toolkit: string;
  allowedCapabilities: string[];
  resourceConstraints?: ManagedBindingResourceConstraints;
}

export interface PersonalConnectionAuthorizationOption {
  providerId: string;
  templateAccountId: string;
  policy: ConnectionAccountPolicy;
  allowedCapabilities: string[];
  accounts: Array<{
    id: string;
    label: string;
    purpose?: string;
    lifecycle: ConnectionAccount['lifecycle'];
  }>;
}

export type ConnectionSelection =
  | { kind: 'selected'; connection: EffectiveConnectionAccount; reason: 'only_eligible' | 'language' }
  | { kind: 'missing'; providerId: string }
  | { kind: 'ambiguous'; providerId: string; choices: EffectiveConnectionAccount[] };

export interface ConnectionRequestResolution {
  selected: EffectiveConnectionAccount[];
  ambiguous: Array<{
    providerId: string;
    choices: Array<{ label: string; purpose?: string; scope: 'team' | 'personal' }>;
  }>;
}

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
