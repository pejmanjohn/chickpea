/**
 * Slack identity retention for installations of a deployment serving many.
 *
 * `sweepSlackIdentityRetention` expires sign-in, recovery and invitation
 * records, deletes expired browser sessions and Slack OAuth and OIDC
 * attempts, and scrubs bot credential candidates parked longer than a day.
 * The hosted Slack lifecycle parks a candidate during each install, so under
 * installation tenancy it runs once a day for every installation, at a minute
 * spread by the installation's ID, from Core's scheduled duties that the host
 * runs per installation. Standalone has never run it and still does not.
 */
import { createHash } from 'node:crypto';

import { deploymentTenancy, requireInstallationScope } from '../config/installation-scope.ts';
import { getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore, SlackCredentialRetentionResult } from './types.ts';

/** A parked bot credential candidate older than this is scrubbed. */
export const HOSTED_CREDENTIAL_CANDIDATE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const MINUTES_PER_DAY = 24 * 60;

/** The minute of the UTC day an installation's retention sweep runs. */
export function identityRetentionMinute(installationId: string): number {
  return createHash('sha256').update(installationId).digest().readUInt32BE(0) % MINUTES_PER_DAY;
}

/**
 * Sweep one installation's Slack identity retention now. Under installation
 * tenancy only; a host may also call it from an operator job.
 */
export async function sweepInstallationIdentityRetention(
  env: PlatformEnv,
  at: number,
  identity: IdentityStore = getIdentityStore(env),
): Promise<SlackCredentialRetentionResult> {
  if (!requireInstallationScope(env)) {
    throw new Error('Hosted identity retention runs for one installation of a deployment serving many.');
  }
  return identity.sweepSlackIdentityRetention(at, HOSTED_CREDENTIAL_CANDIDATE_MAX_AGE_MS);
}

/** The scheduled duty: nothing on standalone; once a day per installation, at its minute. */
export async function runHostedIdentityRetentionDuty(
  scheduledTime: number,
  env: Record<string, unknown>,
  identity?: IdentityStore,
): Promise<void> {
  if (deploymentTenancy(env) !== 'installation') return;
  const scope = requireInstallationScope(env)!;
  if (Math.floor(scheduledTime / 60_000) % MINUTES_PER_DAY !== identityRetentionMinute(scope.installationId)) return;
  await sweepInstallationIdentityRetention(env as PlatformEnv, scheduledTime, identity);
}
