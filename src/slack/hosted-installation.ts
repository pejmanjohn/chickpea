import {
  InstallationContextError,
  requireInstallationScope,
} from '../config/installation-scope.ts';
import {
  getConfigStore,
  getSlackCredentialResolutionDependencies,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  HOSTED_SLACK_INSTALLATION_ID,
  type WorkspaceInstallation,
} from '../config/types.ts';
import {
  readActiveSlackCredentialMetadata,
  type SlackCredentialResolutionDependencies,
} from './installation-credentials.ts';

/** The marker standalone uses while it waits for Slack's events proof. */
const AWAITING_EVENTS = 'events_verification_pending';
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;

type HostedInstallationConfig = Pick<ConfigStore,
  'getWorkspaceInstallation' | 'listWorkspaceInstallations' |
  'ensureWorkspaceInstallation' | 'updateWorkspaceInstallation'>;

export interface HostedWorkspaceInstallationInput {
  teamId: string;
  appId: string;
  botUserId: string;
}

/**
 * Writes the workspace installation record of the installation `env` serves,
 * the record every Slack path in Core looks up by the delivery's team before
 * it acts: a direct installation of `teamId` for the hosted app and its bot
 * user, written after the bot bundle.
 *
 * Standalone writes it during its own install, and promotes a credential only
 * after Slack verifies the customer's Events URL for that app and team. A
 * hosted app's Request URL is verified once, at the app, so no per-install
 * challenge arrives: the host validates the bot live at install time, and
 * this record waits for events until the first signed delivery routed to it
 * (recordFirstHostedSlackDelivery). Health only reports; it never blocks.
 *
 * The first write materializes the Chickpea Agent and the workspace model
 * default as standalone's does. A repeat is a no-op; a new bot user (a
 * reinstall Slack gave another) is recorded without resetting health.
 * Another team, another app, a gateway record or an ended one is refused: a
 * workspace that ends is installed again as a new installation.
 */
export async function syncHostedWorkspaceInstallation(
  env: PlatformEnv,
  input: HostedWorkspaceInstallationInput,
  config: HostedInstallationConfig = getConfigStore(env),
): Promise<WorkspaceInstallation> {
  requireHostedScope(env);
  for (const value of [input.teamId, input.appId, input.botUserId]) {
    if (!SLACK_ID.test(value)) throw new Error('Hosted Slack installation identifiers are malformed.');
  }
  let installation = await config.getWorkspaceInstallation(input.teamId);
  if (!installation) {
    // Refuses a store that already holds another workspace.
    installation = await config.ensureWorkspaceInstallation({
      workspaceId: input.teamId,
      transportMode: 'direct',
      teamId: input.teamId,
      appId: input.appId,
      botUserId: input.botUserId,
    });
  }
  if (installation.transportMode !== 'direct') {
    throw new Error('A hosted installation never uses the shared gateway.');
  }
  if ((installation.teamId && installation.teamId !== input.teamId) ||
      (installation.appId && installation.appId !== input.appId)) {
    throw new Error('This installation belongs to another Slack workspace or app.');
  }
  if (installation.health === 'revoked') {
    throw new Error('This installation has ended; install the workspace again.');
  }
  const firstWrite = installation.health === 'pending';
  if (installation.teamId === input.teamId && installation.appId === input.appId &&
      installation.botUserId === input.botUserId && !firstWrite) {
    return installation;
  }
  return config.updateWorkspaceInstallation(input.teamId, {
    teamId: input.teamId,
    appId: input.appId,
    botUserId: input.botUserId,
    ...(firstWrite ? { health: 'needs_attention', healthDetail: AWAITING_EVENTS } : {}),
  }, installation.revision);
}

/**
 * The record for an installation provisioned before hosts wrote it, from the
 * installation's own bot bundle, which must be a bot grant for `expected`'s
 * app and team and name its bot user. The bot user is returned for the host's
 * registry. The record's createdAt is the backfill time, so Core's own check
 * for lifecycle events older than the installation starts there; the host's
 * check uses its registry's time.
 */
export async function backfillHostedWorkspaceInstallation(
  env: PlatformEnv,
  expected: { teamId: string; appId: string },
  dependencies: {
    config?: HostedInstallationConfig;
    credentials?: SlackCredentialResolutionDependencies;
  } = {},
): Promise<{ installation: WorkspaceInstallation; botUserId: string }> {
  requireHostedScope(env);
  const active = await readActiveSlackCredentialMetadata(
    HOSTED_SLACK_INSTALLATION_ID,
    env,
    dependencies.credentials ?? getSlackCredentialResolutionDependencies(env),
  );
  if (!active || active.purpose !== 'connected_credentials' || active.appId !== expected.appId ||
      active.teamId !== expected.teamId || !active.botUserId) {
    throw new Error('This installation has no bot credentials for the expected Slack app and workspace.');
  }
  const installation = await syncHostedWorkspaceInstallation(env, {
    teamId: expected.teamId,
    appId: expected.appId,
    botUserId: active.botUserId,
  }, dependencies.config ?? getConfigStore(env));
  return { installation, botUserId: active.botUserId };
}

/**
 * The first signed delivery routed to a hosted installation that still waits
 * for events marks it healthy, once; later deliveries read it healthy and
 * write nothing. Losing the race to another writer is fine: health only
 * reports, so this never fails a delivery.
 */
export async function recordFirstHostedSlackDelivery(
  config: Pick<ConfigStore, 'updateWorkspaceInstallation'>,
  installation: WorkspaceInstallation,
): Promise<void> {
  const waiting = installation.health === 'pending' ||
    (installation.health === 'needs_attention' && installation.healthDetail === AWAITING_EVENTS);
  if (!waiting) return;
  try {
    await config.updateWorkspaceInstallation(
      installation.workspaceId,
      { health: 'healthy', healthDetail: null },
      installation.revision,
    );
  } catch {
    // Another delivery or a concurrent write changed the record first; the
    // next delivery reads it again.
  }
}

function requireHostedScope(env: PlatformEnv): void {
  if (!requireInstallationScope(env)) {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Only an installation of a deployment serving many has a hosted Slack installation.',
    );
  }
}
