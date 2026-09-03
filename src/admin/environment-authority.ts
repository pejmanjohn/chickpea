import { createHash, timingSafeEqual } from 'node:crypto';
import type { PlatformEnv } from '../config/state-backend.ts';
import { cloudflareWorkerVersionId } from '../config/cloudflare-version.ts';
import { decodeRecoverySecret } from '../auth/recovery-secret.ts';
import { SETUP_CAPABILITY_DIGEST_BINDING } from '../auth/setup-capability.mjs';
import { loadWorkerCredentialKeyring } from '../slack/credential-keyring.ts';
import type { GatewayDeploymentClient } from '../slack/gateway/client.ts';
import type { GatewaySessionStatusSnapshot } from '../slack/gateway/session-runner.ts';

export const ENVIRONMENT_AUTHORITY_PATH = '/internal/environment/authority';
const READ_TOKEN = 'CHICKPEA_ENV_AUTHORITY_READ_TOKEN';
const SOURCE_BINDINGS = {
  auth: 'CHICKPEA_AUTH_SECRET',
  cookie: 'CHICKPEA_AUTH_SECRET',
  signing: 'slack.gateway.deploymentIdentity.v1.deploymentId',
  recovery: 'CHICKPEA_RECOVERY_TOKEN',
  setup: 'CHICKPEA_SETUP_CAPABILITY_DIGEST',
  encryption: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID+CHICKPEA_CREDENTIAL_KEY_<ID>',
};

/** Dedicated host-side setup attestation, not an Admin or end-user test API. */
export async function environmentAuthorityResponse(input: {
  authorization: string | undefined;
  env: PlatformEnv;
  gateway: () => Pick<GatewayDeploymentClient, 'installationAuthority' | 'call'>;
  session: () => Promise<GatewaySessionStatusSnapshot>;
  now?: () => number;
}): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  const token = input.env[READ_TOKEN];
  const supplied = input.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const target = input.env.CHICKPEA_ENV_TARGET;
  if (!['amber', 'cobalt'].includes(String(target))
    || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
    || !supplied || !timingSafeEqual(Buffer.from(token), Buffer.from(supplied))) {
    return new Response('{}', { status: 404, headers });
  }
  try {
    const version = cloudflareWorkerVersionId(input.env);
    if (!version) throw new Error('missing version');
    const gateway = input.gateway();
    const installation = await gateway.installationAuthority();
    if (installation.health === 'revoked') throw new Error('revoked');
    const auth = await gateway.call('auth.test', {});
    const binding = installation.binding;
    if (auth.ok !== true || auth.team_id !== binding.workspaceId || auth.user_id !== binding.botUserId
      || (auth.app_id !== undefined && auth.app_id !== binding.appId)) throw new Error('Slack identity mismatch');
    const session = await input.session();
    if (!session.healthy || session.versionId !== version) throw new Error('stale session');
    const authKey = decodeRecoverySecret(requiredString(input.env.CHICKPEA_AUTH_SECRET));
    const recoveryKey = decodeRecoverySecret(requiredString(input.env.CHICKPEA_RECOVERY_TOKEN));
    const keyring = loadWorkerCredentialKeyring(input.env);
    const encryptionKey = decodeRecoverySecret(requiredString(keyring.keys[keyring.currentKeyId]));
    const setupDigest = decodeRecoverySecret(requiredString(input.env[SETUP_CAPABILITY_DIGEST_BINDING]));
    return Response.json({
      schemaVersion: 'chickpea-environment-runtime-authority/v2',
      target, observedAt: new Date((input.now ?? Date.now)()).toISOString(),
      secretFingerprints: {
        schemaVersion: 'chickpea-environment-runtime-secret-fingerprints/v2',
        sourceBindings: SOURCE_BINDINGS,
        fingerprints: {
          auth: fingerprint(authKey), cookie: fingerprint(authKey),
          signing: fingerprint(binding.deploymentId), recovery: fingerprint(recoveryKey),
          setup: fingerprint(setupDigest), encryption: fingerprint(encryptionKey),
        },
      },
      slack: {
        teamId: binding.workspaceId, appId: binding.appId,
        botUserId: binding.botUserId, replySenderId: binding.botUserId,
        scopes: [...installation.grantedScopes].sort(),
      },
      transportAuthority: {
        healthy: session.healthy, phase: session.phase, detail: null,
        generation: session.generation, versionId: session.versionId,
      },
    }, { headers });
  } catch {
    // Neither remote diagnostics nor environment/credential values leave this boundary.
    return new Response('{"error":"environment_authority_unavailable"}', { status: 503, headers });
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('missing binding');
  return value;
}

function fingerprint(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
