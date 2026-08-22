import { useDelivery, useInstruction, useTool } from '@flue/runtime';
import * as v from 'valibot';

import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import {
  ApiOAuthError,
  connectionAccountOAuthRef,
  copyApiOAuthClient,
  describeApiOAuthSources,
  startApiOAuthAuthorization,
  type ApiOAuthDependencies,
} from '../config/api-oauth.ts';
import {
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConnectionAccount } from '../config/types.ts';
import { parseSlackManagementSignal, type PlatformEnvResolver } from '../management/slack-tools.ts';
import { resolveSlackPublicUrl } from '../slack/credentials.ts';
import {
  createOAuthContinuation,
  linkOAuthProviderState,
} from './oauth-continuation.ts';
import { resolvePersonalConnectionAuthorizationOptions } from './runtime.ts';

const AuthorizePersonalConnectionSchema = v.strictObject({
  providerId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
  accountLabel: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
});

export type PersonalConnectionAuthorizationResult =
  | { kind: 'authorization_required'; providerId: string; accountId: string; authorizationUrl: string }
  | { kind: 'already_connected'; providerId: string; accountId: string; label: string }
  | { kind: 'choose_account'; providerId: string; choices: Array<{ label: string; purpose?: string }> }
  | { kind: 'admin_setup_required'; providerId: string };

interface StartPersonalConnectionAuthorizationDependencies {
  config: ConfigStore;
  settings: SettingsStore;
  resolveMembership: (
    workspaceId: string,
    slackUserId: string,
  ) => Promise<{ membershipId: string } | undefined>;
  publicOrigin: () => Promise<string>;
  oauth?: Omit<ApiOAuthDependencies, 'settings' | 'validateConnection'>;
  randomId?: () => string;
}

/**
 * Start one actor-bound OAuth flow from a verified Slack turn. Member bindings
 * behave as provider capabilities: the account is owned by the actor and the
 * template contributes only non-secret policy plus the deployment OAuth app.
 */
export async function startPersonalConnectionAuthorization(input: {
  workspaceId: string;
  agentId: string;
  actorMembershipId: string;
  slackUserId: string;
  channelId: string;
  threadTs: string;
  taskId: string;
  providerId: string;
  accountLabel?: string;
}, dependencies: StartPersonalConnectionAuthorizationDependencies): Promise<PersonalConnectionAuthorizationResult> {
  const resolvedActor = await dependencies.resolveMembership(input.workspaceId, input.slackUserId);
  if (!resolvedActor || resolvedActor.membershipId !== input.actorMembershipId) {
    throw new Error('The Slack actor is no longer authorized for this personal connection.');
  }
  const options = await resolvePersonalConnectionAuthorizationOptions({
    config: dependencies.config,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    actorMembershipId: input.actorMembershipId,
  });
  const option = options.find(
    (candidate) => candidate.providerId.toLowerCase() === input.providerId.toLowerCase(),
  );
  if (!option || option.policy.kind !== 'api' || option.policy.authMode !== 'oauth' ||
      option.policy.oauthProvider !== 'google' || !option.policy.oauthScopes) {
    throw new Error('This Agent does not offer inline authorization for that provider.');
  }
  const allAccounts = await dependencies.config.listConnectionAccounts(input.workspaceId);
  const actorAccounts = allAccounts.filter((account) =>
    account.ownerKind === 'member' &&
    account.ownerMembershipId === input.actorMembershipId &&
    account.providerId.toLowerCase() === option.providerId.toLowerCase() &&
    account.lifecycle !== 'revoked'
  );
  let account = selectActorAccount(actorAccounts, input.accountLabel);
  if (!account && actorAccounts.length > 0) {
    return {
      kind: 'choose_account',
      providerId: option.providerId,
      choices: actorAccounts.map(({ label, purpose }) => ({
        label,
        ...(purpose ? { purpose } : {}),
      })),
    };
  }
  if (!account) {
    const suffix = (dependencies.randomId ?? (() => crypto.randomUUID().replace(/-/g, '')))();
    account = await dependencies.config.putConnectionAccount({
      id: `connection_${suffix}`,
      workspaceId: input.workspaceId,
      ownerKind: 'member',
      ownerMembershipId: input.actorMembershipId,
      createdByMembershipId: input.actorMembershipId,
      providerId: option.providerId,
      label: input.accountLabel ?? `${displayProvider(option.providerId)} account`,
      policy: option.policy,
      secretRefId: `secret_${suffix}`,
      lifecycle: 'needs_attention',
    }, 0);
  }
  if (account.lifecycle === 'ready') {
    return {
      kind: 'already_connected',
      providerId: option.providerId,
      accountId: account.id,
      label: account.label,
    };
  }

  const sourceRef = connectionAccountOAuthRef(option.templateAccountId);
  const accountRef = connectionAccountOAuthRef(account.id);
  const targetSources = await describeApiOAuthSources(accountRef, dependencies.settings);
  if (targetSources.client === 'missing') {
    try {
      await copyApiOAuthClient(sourceRef, accountRef, dependencies.settings);
    } catch (error) {
      if (error instanceof ApiOAuthError && error.code === 'client_missing') {
        return { kind: 'admin_setup_required', providerId: option.providerId };
      }
      throw error;
    }
  }
  account = await dependencies.config.putConnectionAccount(
    {
      ...account,
      lifecycle: 'pending',
      policy: { ...account.policy, oauthAttemptId: crypto.randomUUID() },
    },
    account.revision,
  );
  const accountRevision = account.revision;
  const oauthAttemptId = account.policy.oauthAttemptId!;
  const oauth = await startApiOAuthAuthorization({
    ref: accountRef,
    provider: 'google',
    callbackUrl: `${(await dependencies.publicOrigin()).replace(/\/$/, '')}/oauth/api/callback`,
    scopes: option.policy.oauthScopes,
    accountRevision,
    oauthAttemptId,
  }, {
    settings: dependencies.settings,
    ...(dependencies.oauth ?? {}),
    validateConnection: async (ref, provider, expectedRevision, expectedAttemptId) => {
      const current = (await dependencies.config.listConnectionAccounts(input.workspaceId))
        .find((candidate) => candidate.id === account!.id);
      const validConnection = ref.agentId === account!.id && ref.connectionId === 'account' &&
        provider === 'google' && current?.ownerKind === 'member' &&
        current.ownerMembershipId === input.actorMembershipId &&
        current.lifecycle !== 'revoked';
      if (!validConnection) return false;
      if (
        (expectedRevision !== undefined && current.revision !== expectedRevision) ||
        (expectedAttemptId !== undefined && current.policy.oauthAttemptId !== expectedAttemptId)
      ) {
        throw new ApiOAuthError(
          'oauth_attempt_superseded',
          'OAuth attempt was superseded',
        );
      }
      return true;
    },
  });
  const continuation = await createOAuthContinuation({
    settings: dependencies.settings,
    workspaceId: input.workspaceId,
    actorMembershipId: input.actorMembershipId,
    agentId: input.agentId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    taskId: input.taskId,
    providerId: option.providerId,
    accountId: account.id,
  });
  await linkOAuthProviderState({
    settings: dependencies.settings,
    providerState: oauth.state,
    continuationState: continuation.state,
  });
  return {
    kind: 'authorization_required',
    providerId: option.providerId,
    accountId: account.id,
    authorizationUrl: oauth.authorizationUrl.href,
  };
}

/** Mount the one user-facing authorization tool only on verified Slack turns. */
export function usePersonalConnectionAuthorizationSlackTool(
  plan: RuntimePlanV2,
  resolvePlatformEnv: PlatformEnvResolver,
): void {
  const signal = parseSlackManagementSignal(useDelivery(), plan);
  if (!signal || !plan.actorMembershipId) return;
  if (plan.connectionChoices?.length) {
    useInstruction([
      'Some connection credentials were withheld because the request did not identify one account uniquely.',
      `Ask the user to choose one of these labels before using that provider: ${JSON.stringify(plan.connectionChoices)}.`,
      'Do not guess, invoke a withheld account, or claim the connected service is unavailable.',
    ].join(' '));
  }
  if (!(plan.connectionAuthorizations?.length)) return;
  const providers = plan.connectionAuthorizations.map((option) => option.providerId);
  useInstruction([
    `Personal authorization is available for these Agent providers: ${providers.join(', ')}.`,
    'Call authorize_personal_connection only when the current task needs one of them and no ready connection can complete the task.',
    'If the tool returns choose_account, ask which labeled account to use. If it returns authorization_required, give the authorization link to the user and stop the task until Chickpea resumes it.',
  ].join(' '));
  useTool({
    name: 'authorize_personal_connection',
    description: 'Start or continue the current Slack member’s personal authorization for a provider enabled on this Agent.',
    input: AuthorizePersonalConnectionSchema,
    async run({ data }) {
      const env = await resolvePlatformEnv();
      const identity = getIdentityStore(env);
      const settings = getSettingsStore(env);
      const result = await startPersonalConnectionAuthorization({
        workspaceId: signal.workspaceId,
        agentId: plan.agentId,
        actorMembershipId: plan.actorMembershipId!,
        slackUserId: signal.slackUserId,
        channelId: signal.channelId,
        threadTs: signal.threadTs,
        taskId: signal.turnJobId,
        providerId: data.providerId,
        ...(data.accountLabel ? { accountLabel: data.accountLabel } : {}),
      }, {
        config: getConfigStore(env),
        settings,
        resolveMembership: async (workspaceId, slackUserId) => {
          const resolved = await identity.resolveSlackIdentity(workspaceId, slackUserId);
          return resolved?.membership.status === 'active'
            ? { membershipId: resolved.membership.id }
            : undefined;
        },
        publicOrigin: async () => {
          const origin = await resolveSlackPublicUrl(env, settings);
          if (!origin) throw new Error('Chickpea public URL is not configured.');
          return origin;
        },
      });
      return { output: JSON.stringify(result) };
    },
  });
}

function selectActorAccount(
  accounts: readonly ConnectionAccount[],
  requestedLabel: string | undefined,
): ConnectionAccount | undefined {
  if (accounts.length === 0) return undefined;
  if (!requestedLabel) return accounts.length === 1 ? accounts[0] : undefined;
  const wanted = normalize(requestedLabel);
  const matches = accounts.filter((account) => {
    const label = normalize(account.label);
    const purpose = normalize(account.purpose ?? '');
    return label === wanted || purpose === wanted || label.includes(wanted) || purpose.includes(wanted);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function displayProvider(providerId: string): string {
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}
