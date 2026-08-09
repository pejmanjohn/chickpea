import {
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { AuthControl } from '../identity/types.ts';
import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import {
  cloudflarePasswordPrimitive,
  D1BetterAuthBackend,
  type CloudflareBetterAuthEnv,
} from './better-auth-cloudflare.ts';
import { getNodeBetterAuthBackend } from './better-auth-node.ts';
import { nativePasswordPrimitive, type PasswordPrimitive } from './password.ts';
import { decodeRecoverySecret, deriveBetterAuthSecret } from './recovery-secret.ts';

export interface BetterAuthEnvironment {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  password: PasswordPrimitive;
  recoveryToken: string;
  secret: string;
  cloudflareEnv?: CloudflareBetterAuthEnv;
}

interface ResolveBetterAuthEnvironmentInput {
  control: AuthControl;
  platformEnv?: PlatformEnv | undefined;
  recoveryToken?: string | undefined;
  authSecret?: string | undefined;
  passwordShardKey?: string | undefined;
}

interface ResolveBetterAuthBootstrapEnvironmentInput {
  canonicalOrigin: string;
  platformEnv?: PlatformEnv | undefined;
  recoveryToken?: string | undefined;
  authSecret?: string | undefined;
  passwordShardKey?: string | undefined;
}

export async function resolveBetterAuthEnvironment(
  input: ResolveBetterAuthEnvironmentInput,
): Promise<BetterAuthEnvironment | undefined> {
  if (input.control.authMode !== 'password_active' ||
      !input.control.canonicalAdminOrigin ||
      !input.control.betterAuthOrganizationId) return undefined;
  return resolveBetterAuthBootstrapEnvironment({
    canonicalOrigin: input.control.canonicalAdminOrigin,
    platformEnv: input.platformEnv,
    recoveryToken: input.recoveryToken,
    authSecret: input.authSecret,
    passwordShardKey: input.passwordShardKey ?? input.control.installationId,
  });
}

export async function resolveBetterAuthBootstrapEnvironment(
  input: ResolveBetterAuthBootstrapEnvironmentInput,
): Promise<BetterAuthEnvironment | undefined> {
  const recoveryToken = input.recoveryToken ?? recoverySecret(input.platformEnv);
  const stableSecret = input.authSecret ?? authSecret(input.platformEnv);
  if (!stableSecret && !recoveryToken) return undefined;
  const secret = stableSecret ?? await deriveBetterAuthSecret(recoveryToken!);

  if (isCloudflareTarget()) {
    const cloudflareEnv = cloudflareAuthEnv(input.platformEnv);
    if (!cloudflareEnv) return undefined;
    return {
      backend: new D1BetterAuthBackend(cloudflareEnv.AUTH_DB),
      baseURL: input.canonicalOrigin,
      password: cloudflarePasswordPrimitive(
        cloudflareEnv,
        input.passwordShardKey ?? 'owner-setup',
      ),
      secret,
      // Setup/recovery are split from signing in U2. Until then, keep the
      // internal authority available as the existing non-browser limiter
      // pepper on fresh installs; public recovery remains disabled unless the
      // separate CHICKPEA_RECOVERY_TOKEN binding exists.
      recoveryToken: recoveryToken ?? secret,
      cloudflareEnv,
    };
  }

  return {
    backend: getNodeBetterAuthBackend(),
    baseURL: input.canonicalOrigin,
    password: nativePasswordPrimitive(),
    recoveryToken: recoveryToken ?? secret,
    secret,
  };
}

export function recoverySecret(env: PlatformEnv | undefined): string | undefined {
  const bound = env?.CHICKPEA_RECOVERY_TOKEN;
  if (typeof bound === 'string' && bound) return bound;
  const local = process.env.CHICKPEA_RECOVERY_TOKEN;
  return local || undefined;
}

export function authSecret(env: PlatformEnv | undefined): string | undefined {
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
  const authGuard = env.AUTH_GUARD as { getByName?: unknown } | undefined;
  if (typeof authDb?.prepare !== 'function' || typeof authGuard?.getByName !== 'function') {
    return undefined;
  }
  return env as unknown as CloudflareBetterAuthEnv;
}
