import type { View } from '@slack/types';

import type { WorkspaceInstallation } from '../../config/types.ts';
import { missingRequiredSlackBotScopes } from '../scopes.ts';
import type { SlackEvent } from '../types.ts';

export type SlackTransportMode = 'direct' | 'gateway';

/** Credential-free envelope shared by direct ingress and the future gateway. */
export interface SlackInboundEnvelope {
  workspaceId: string;
  eventId: string;
  eventTime: number;
  event: SlackEvent;
}

export interface SlackMember {
  id: string;
  teamId?: string;
  name?: string;
  /** Mutable Slack username. Presentation only; never an identity key. */
  handle?: string;
  displayName?: string;
  realName?: string;
  email?: string;
  avatarUrl?: string;
  deleted: boolean;
  bot: boolean;
  appUser: boolean;
  restricted: boolean;
  ultraRestricted: boolean;
  stranger: boolean;
}

export interface SlackChannel {
  id: string;
  name?: string;
  private: boolean;
  member: boolean;
  archived: boolean;
}

export interface SlackChannelList {
  channels: SlackChannel[];
  truncated: boolean;
}

export interface SlackUserGroup {
  id: string;
  name: string;
  handle: string;
  description?: string;
  disabled: boolean;
  updatedAt?: number;
}

export interface SlackMessagePersona {
  name: string;
  avatarUrl: string;
}

export interface SlackMessageReference {
  channelId: string;
  ts: string;
}

export interface SlackAppHomeReference {
  viewId?: string;
  hash?: string;
}

export interface SlackWorkspaceInfo {
  teamId: string;
  teamName?: string;
}

/**
 * The complete Slack capability surface used by Agent product code. It exposes
 * neither an SDK client nor token-bearing request options, so the same runtime
 * can be backed by a direct customer installation or Chickpea's gateway.
 */
export interface SlackTransport {
  readonly mode: SlackTransportMode;
  /** Live workspace identity when the backing transport can verify it. */
  getWorkspaceInfo?(): Promise<SlackWorkspaceInfo>;
  lookupMember(userId: string): Promise<SlackMember>;
  lookupChannel(channelId: string): Promise<SlackChannel>;
  listChannels(): Promise<SlackChannelList>;
  /** Channels the bot shares with one Slack user. Used for directory discovery
   * so one user-scoped listing replaces a full member scan per Channel. */
  listMemberChannels(userId: string): Promise<ReadonlySet<string>>;
  channelHasMember(channelId: string, userId: string): Promise<boolean>;
  openDirectConversation(userId: string): Promise<SlackChannel>;
  joinPublicChannel(channelId: string): Promise<SlackChannel>;
  listUserGroups(options?: { includeDisabled?: boolean }): Promise<SlackUserGroup[]>;
  createUserGroup(input: {
    name: string;
    handle: string;
    description?: string;
  }): Promise<SlackUserGroup>;
  updateUserGroup(
    userGroupId: string,
    patch: { name?: string; handle?: string; description?: string },
  ): Promise<SlackUserGroup>;
  disableUserGroup(userGroupId: string): Promise<SlackUserGroup>;
  enableUserGroup(userGroupId: string): Promise<SlackUserGroup>;
  publishAppHome(input: {
    userId: string;
    view: View;
    hash?: string;
  }): Promise<SlackAppHomeReference>;
  postMessage(input: {
    channelId: string;
    threadTs?: string;
    text: string;
    blocks?: unknown[];
    persona?: SlackMessagePersona;
  }): Promise<SlackMessageReference>;
}

const RETRYABLE_SLACK_ERRORS = new Set([
  'fatal_error',
  'internal_error',
  'ratelimited',
  'request_timeout',
  'service_unavailable',
  'slack_unreachable',
]);

/** Stable failure shape consumed by reconciliation and recovery UI. */
export class SlackTransportError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly operation: string,
    readonly code: string,
    options: { retryable?: boolean } = {},
  ) {
    super(`Slack ${operation} failed (${code})`);
    this.name = 'SlackTransportError';
    this.retryable = options.retryable ?? RETRYABLE_SLACK_ERRORS.has(code);
  }
}

export type SlackInstallationHealthStatus =
  | 'healthy'
  | 'needs_reauthorization'
  | 'unverifiable';

export interface SlackInstallationHealthResult {
  status: SlackInstallationHealthStatus;
  missingScopes: string[];
  detail?: string;
  action?: {
    kind: 'reinstall';
    label: string;
    url?: string;
  };
}

/** Convert live OAuth evidence into a user-actionable health result. */
export function evaluateSlackInstallationHealth(
  grantedScopes: readonly string[] | undefined,
  options: { appId?: string } = {},
): SlackInstallationHealthResult {
  const missingScopes = missingRequiredSlackBotScopes(grantedScopes);
  if (missingScopes === undefined) {
    return {
      status: 'unverifiable',
      missingScopes: [],
      detail: 'Slack did not return the installed permission scopes.',
    };
  }
  if (missingScopes.length === 0) {
    return { status: 'healthy', missingScopes: [] };
  }
  return {
    status: 'needs_reauthorization',
    missingScopes,
    action: {
      kind: 'reinstall',
      label: 'Reinstall Chickpea in Slack',
      ...(options.appId
        ? { url: `https://api.slack.com/apps/${encodeURIComponent(options.appId)}/oauth` }
        : {}),
    },
    detail: `Reinstall Chickpea in Slack to grant: ${missingScopes.join(', ')}.`,
  };
}

/** One mode decision at the runtime edge; feature code receives one contract. */
export function selectSlackTransport(
  installation: Pick<WorkspaceInstallation, 'transportMode'>,
  adapters: { direct: SlackTransport; gateway: SlackTransport },
): SlackTransport {
  const selected = adapters[installation.transportMode];
  if (selected.mode !== installation.transportMode) {
    throw new Error(`Slack transport adapter mismatch for ${installation.transportMode}`);
  }
  return selected;
}
