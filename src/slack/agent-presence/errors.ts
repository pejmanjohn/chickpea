import { SlackTransportError } from '../transport/types.ts';

export type AgentPresenceErrorCode =
  | 'paid_plan_required'
  | 'user_group_policy_denied'
  | 'two_factor_required'
  | 'handle_collision'
  | 'invalid_handle'
  | 'channel_membership_required'
  | 'private_channel_invite_required'
  | 'rate_limited'
  | 'user_group_create_ambiguous'
  | 'slack_unavailable'
  | 'slack_operation_failed';

export class AgentPresenceError extends Error {
  constructor(
    readonly code: AgentPresenceErrorCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      suggestions?: string[];
      slackCode?: string;
    } = {},
  ) {
    super(message);
    this.name = 'AgentPresenceError';
  }

  get retryable(): boolean { return this.options.retryable ?? false; }
  get suggestions(): string[] { return this.options.suggestions ?? []; }
  get slackCode(): string | undefined { return this.options.slackCode; }
}

const PAID_PLAN_ERRORS = new Set([
  'paid_teams_only',
  'paid_team_only',
  'feature_not_enabled',
]);
const POLICY_ERRORS = new Set([
  'permission_denied',
  'not_allowed',
  'restricted_action',
]);
const TWO_FACTOR_ERRORS = new Set([
  'two_factor_setup_required',
  'two_factor_required',
]);
const COLLISION_ERRORS = new Set([
  'handle_already_exists',
  'name_already_exists',
  'already_exists',
]);
const INVALID_HANDLE_ERRORS = new Set([
  'invalid_handle',
  'invalid_name',
  'invalid_arguments',
]);

export function classifyAgentPresenceError(error: unknown): AgentPresenceError {
  if (error instanceof AgentPresenceError) return error;
  if (!(error instanceof SlackTransportError)) {
    return new AgentPresenceError(
      'slack_unavailable',
      'Slack could not be reached. The Agent is saved; retry when Slack is available.',
      { retryable: true },
    );
  }
  const common = { slackCode: error.code };
  if (PAID_PLAN_ERRORS.has(error.code)) {
    return new AgentPresenceError(
      'paid_plan_required',
      'Slack user groups require a paid Slack plan.',
      common,
    );
  }
  if (POLICY_ERRORS.has(error.code)) {
    return new AgentPresenceError(
      'user_group_policy_denied',
      'Slack blocked Chickpea from creating or editing the Agent handle.',
      common,
    );
  }
  if (TWO_FACTOR_ERRORS.has(error.code)) {
    return new AgentPresenceError(
      'two_factor_required',
      'Slack requires two-factor authentication before this Agent handle can be managed.',
      common,
    );
  }
  if (COLLISION_ERRORS.has(error.code)) {
    return new AgentPresenceError(
      'handle_collision',
      'That Slack handle or user-group name is already in use.',
      common,
    );
  }
  if (INVALID_HANDLE_ERRORS.has(error.code)) {
    return new AgentPresenceError(
      'invalid_handle',
      'Slack rejected the Agent handle.',
      common,
    );
  }
  if (error.code === 'ratelimited') {
    return new AgentPresenceError(
      'rate_limited',
      'Slack is rate limiting Agent-handle changes. Retry in a moment.',
      { ...common, retryable: true },
    );
  }
  return new AgentPresenceError(
    error.retryable ? 'slack_unavailable' : 'slack_operation_failed',
    error.retryable
      ? 'Slack could not complete the Agent-handle change. Retry in a moment.'
      : 'Slack could not complete the Agent-handle change.',
    { ...common, retryable: error.retryable },
  );
}

export interface AgentPresenceRecovery {
  title: string;
  explanation: string;
  steps: string[];
  actionLabel: 'Retry';
  adminUrl?: string;
  note?: string;
}

/** Atlas-quality explanation plus exact remediation instead of reconnect advice. */
export function agentPresenceRecovery(
  error: Pick<AgentPresenceError, 'code' | 'message'>,
  handle: string,
): AgentPresenceRecovery {
  if (error.code === 'paid_plan_required') {
    return {
      title: `Slack won't create @${handle}`,
      explanation: 'Agent handles are Slack user groups, which require a paid Slack plan. The Agent itself is saved.',
      steps: ['Upgrade the Slack workspace to a paid plan.', 'Come back here and select Retry.'],
      actionLabel: 'Retry',
      adminUrl: 'https://slack.com/plans',
    };
  }
  if (error.code === 'user_group_policy_denied') {
    return {
      title: `Slack blocked Chickpea from creating @${handle}`,
      explanation: 'Agent handles are Slack user groups, and new workspaces may allow only Owners and Admins to create them. Reconnecting Slack will not change this permission.',
      steps: [
        'Ask a Slack Workspace Owner or Admin to open Roles & permissions → Account types at slack.com/admin.',
        'Next to “Create and edit user groups,” choose … → Edit permission.',
        'Add Members, then Save.',
        'Come back here and select Retry.',
      ],
      actionLabel: 'Retry',
      adminUrl: 'https://slack.com/admin',
      note: 'On Enterprise Grid, an Org Owner sets the same permission from Organization settings → Roles & permissions.',
    };
  }
  if (error.code === 'two_factor_required') {
    return {
      title: 'Slack requires two-factor authentication',
      explanation: `The Agent is saved, but Slack will not create @${handle} until the acting member completes 2FA.`,
      steps: ['Complete two-factor authentication in Slack.', 'Come back here and select Retry.'],
      actionLabel: 'Retry',
      adminUrl: 'https://slack.com/account/settings',
    };
  }
  if (error.code === 'handle_collision') {
    return {
      title: `@${handle} is already in use`,
      explanation: 'Slack handles are workspace-global across members and user groups. The Agent is saved.',
      steps: ['Choose one of the suggested available handles or enter another handle.', 'Select Retry.'],
      actionLabel: 'Retry',
    };
  }
  if (error.code === 'channel_membership_required') {
    return {
      title: 'Join the Channel first',
      explanation: 'You can add an Agent only to Slack Channels you belong to.',
      steps: ['Join the Channel in Slack.', 'Come back here and select Retry.'],
      actionLabel: 'Retry',
    };
  }
  if (error.code === 'private_channel_invite_required') {
    return {
      title: 'Invite Chickpea to this private Channel',
      explanation: `The Agent is saved, but Slack does not let apps join private Channels themselves.`,
      steps: ['In the private Channel, run /invite @Chickpea.', 'Come back here and select Retry.'],
      actionLabel: 'Retry',
    };
  }
  return {
    title: `Slack couldn't finish @${handle}`,
    explanation: `${error.message} The Agent is saved.`,
    steps: ['Check the Slack installation and try again.', 'Select Retry.'],
    actionLabel: 'Retry',
  };
}
