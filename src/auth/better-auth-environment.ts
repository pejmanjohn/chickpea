import { deploymentTenancy } from '../config/installation-scope.ts';
import {
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { AuthControl } from '../identity/types.ts';
import type { BetterAuthAccessRevoker, BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import {
  D1BetterAuthBackend,
  type CloudflareBetterAuthEnv,
} from './better-auth-cloudflare.ts';
import { getNodeBetterAuthBackend } from './better-auth-node.ts';
import { decodeRecoverySecret } from './recovery-secret.ts';

export interface BetterAuthEnvironment {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  secret: string;
  cloudflareEnv?: CloudflareBetterAuthEnv;
}

interface ResolveBetterAuthEnvironmentInput {
  control: AuthControl;
  platformEnv?: PlatformEnv | undefined;
  /** Operational recovery is independent and never signs Better Auth sessions. */
  recoveryToken?: string | undefined;
  authSecret?: string | undefined;
}

interface ResolveBetterAuthBootstrapEnvironmentInput {
  canonicalOrigin: string;
  platformEnv?: PlatformEnv | undefined;
  /** Accepted for call-site symmetry; never used as Better Auth key material. */
  recoveryToken?: string | undefined;
  authSecret?: string | undefined;
}

const HOST_BACKEND = Symbol('chickpea.better-auth-backend');

/**
 * An env whose Better Auth database is `backend`, for a host that opens one
 * per request (PostgreSQL through Hyperdrive) and closes it once the request's
 * work has settled. The backend rides in a frozen copy under a module-private
 * symbol, like an installation scope, so only the host holding it can attach
 * it; the input is never changed. A deployment serving many installations
 * reads Better Auth only from here, never from a deployment-wide database.
 */
export function withBetterAuthBackend<E extends PlatformEnv>(
  env: E,
  backend: BetterAuthDatabaseBackend,
): E {
  const current = hostBetterAuthBackend(env);
  if (current === backend) return env;
  if (current) throw new Error('The env already carries another Better Auth backend.');
  return Object.freeze({ ...env, [HOST_BACKEND]: backend });
}

/** The backend a host attached to `env` with withBetterAuthBackend, if any. */
export function hostBetterAuthBackend(env: PlatformEnv | undefined): BetterAuthDatabaseBackend | undefined {
  return (env as { [HOST_BACKEND]?: BetterAuthDatabaseBackend } | undefined)?.[HOST_BACKEND];
}

/** A Better Auth backend opened for one piece of work, closed once it settles. */
export type ClosableBetterAuthBackend = BetterAuthDatabaseBackend & { close(): Promise<void> };

let backgroundBackend: ((env: PlatformEnv) => ClosableBetterAuthBackend | undefined) | undefined;

/**
 * The composition seam for work no request carries, such as a Durable Object
 * alarm draining Slack deliveries or a Slack event finished after its
 * acknowledgement. A host serving many installations installs it once, at
 * module scope, so every isolate (Worker or Durable Object) can open its
 * Better Auth database (PostgreSQL through Hyperdrive) for such work; the
 * opener returns undefined where it cannot. Requests keep their own backend
 * (withBetterAuthBackend), whose lifetime the host already manages.
 */
export function configureBetterAuthBackendFactory(
  open: ((env: PlatformEnv) => ClosableBetterAuthBackend | undefined) | undefined,
): void {
  backgroundBackend = open;
}

/**
 * The backend that ends a person's sessions and MCP grants when a background
 * event (a Slack deactivation) removes their access. Where Better Auth is not
 * active there is none and the change applies without it. A deployment
 * serving many installations whose request carries no backend refuses
 * instead, so the membership is never suspended while its sessions and
 * grants survive.
 */
export async function resolveBetterAuthAccessRevoker(input: {
  control: AuthControl | undefined;
  platformEnv?: PlatformEnv | undefined;
}): Promise<BetterAuthDatabaseBackend | undefined> {
  if (!input.control) return undefined;
  const environment = await resolveBetterAuthEnvironment({ control: input.control, platformEnv: input.platformEnv });
  if (!environment && betterAuthActive(input.control) && deploymentTenancy(input.platformEnv) === 'installation') {
    throw new Error('No Better Auth backend serves this request, so access cannot be revoked; nothing was changed.');
  }
  return environment?.backend;
}

/**
 * Runs `use` with the backend that ends a person's sessions and MCP grants
 * (resolveBetterAuthAccessRevoker). Under installation tenancy, work that
 * no request's backend serves gets one from the host's factory
 * (configureBetterAuthBackendFactory), opened for `use` and closed once it
 * settles; without either it is refused as before. Standalone is unchanged.
 */
export async function withBetterAuthAccessRevoker<T>(
  input: { control: AuthControl | undefined; platformEnv?: PlatformEnv | undefined },
  use: (revoker: BetterAuthAccessRevoker | undefined) => Promise<T>,
): Promise<T> {
  const { control, platformEnv } = input;
  if (!platformEnv || !control || !betterAuthActive(control) ||
      deploymentTenancy(platformEnv) !== 'installation' || hostBetterAuthBackend(platformEnv)) {
    return use(await resolveBetterAuthAccessRevoker(input));
  }
  const opened = backgroundBackend?.(platformEnv);
  if (!opened) return use(await resolveBetterAuthAccessRevoker(input));
  try {
    return await use(await resolveBetterAuthAccessRevoker({
      control,
      platformEnv: withBetterAuthBackend(platformEnv, opened),
    }));
  } finally {
    await opened.close().catch((error: unknown) => {
      console.error('[chickpea] Closing a Better Auth backend failed:',
        error instanceof Error ? error.message : String(error));
    });
  }
}

/** Whether this installation signs people in through Better Auth now. */
function betterAuthActive(
  control: AuthControl,
): control is AuthControl & { canonicalAdminOrigin: string; betterAuthOrganizationId: string } {
  return control.authMode === 'slack_active' && control.healthGate === 'normal' &&
    Boolean(control.canonicalAdminOrigin) && Boolean(control.betterAuthOrganizationId);
}

export async function resolveBetterAuthEnvironment(
  input: ResolveBetterAuthEnvironmentInput,
): Promise<BetterAuthEnvironment | undefined> {
  if (!betterAuthActive(input.control)) return undefined;
  return resolveBetterAuthBootstrapEnvironment({
    canonicalOrigin: input.control.canonicalAdminOrigin,
    platformEnv: input.platformEnv,
    authSecret: input.authSecret,
  });
}

export async function resolveBetterAuthBootstrapEnvironment(
  input: ResolveBetterAuthBootstrapEnvironmentInput,
): Promise<BetterAuthEnvironment | undefined> {
  const stableSecret = input.authSecret ?? authSecret(input.platformEnv);
  if (!stableSecret) return undefined;

  const hostBackend = hostBetterAuthBackend(input.platformEnv);
  if (hostBackend) {
    return { backend: hostBackend, baseURL: input.canonicalOrigin, secret: stableSecret };
  }
  // Each request's host supplies the database; nothing deployment-wide stands in.
  if (deploymentTenancy(input.platformEnv) === 'installation') return undefined;

  if (isCloudflareTarget()) {
    const cloudflareEnv = cloudflareAuthEnv(input.platformEnv);
    if (!cloudflareEnv) return undefined;
    return {
      backend: new D1BetterAuthBackend(cloudflareEnv.AUTH_DB),
      baseURL: input.canonicalOrigin,
      secret: stableSecret,
      cloudflareEnv,
    };
  }

  return {
    backend: getNodeBetterAuthBackend(),
    baseURL: input.canonicalOrigin,
    secret: stableSecret,
  };
}

function authSecret(env: PlatformEnv | undefined): string | undefined {
  const bound = env?.CHICKPEA_AUTH_SECRET;
  if (typeof bound === 'string' && bound) return validStableAuthSecret(bound);
  const local = process.env.CHICKPEA_AUTH_SECRET;
  return local ? validStableAuthSecret(local) : undefined;
}

function validStableAuthSecret(value: string): string {
  try {
    decodeRecoverySecret(value);
  } catch {
    throw new Error('CHICKPEA_AUTH_SECRET must encode exactly 32 random bytes.');
  }
  return value;
}

function cloudflareAuthEnv(env: PlatformEnv | undefined): CloudflareBetterAuthEnv | undefined {
  if (!env) return undefined;
  const authDb = env.AUTH_DB as { prepare?: unknown } | undefined;
  if (typeof authDb?.prepare !== 'function') {
    return undefined;
  }
  return env as unknown as CloudflareBetterAuthEnv;
}
