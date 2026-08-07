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
import { deriveBetterAuthSecret } from './recovery-secret.ts';

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
  passwordShardKey?: string | undefined;
}

export async function resolveBetterAuthEnvironment(
  input: ResolveBetterAuthEnvironmentInput,
): Promise<BetterAuthEnvironment | undefined> {
  if (input.control.authMode !== 'password_active' ||
      !input.control.canonicalAdminOrigin ||
      !input.control.betterAuthOrganizationId) return undefined;
  const recoveryToken = input.recoveryToken ?? recoverySecret(input.platformEnv);
  if (!recoveryToken) return undefined;
  const secret = await deriveBetterAuthSecret(recoveryToken);

  if (isCloudflareTarget()) {
    const cloudflareEnv = cloudflareAuthEnv(input.platformEnv);
    if (!cloudflareEnv) return undefined;
    return {
      backend: new D1BetterAuthBackend(cloudflareEnv.AUTH_DB),
      baseURL: input.control.canonicalAdminOrigin,
      password: cloudflarePasswordPrimitive(
        cloudflareEnv,
        input.passwordShardKey ?? input.control.installationId,
      ),
      secret,
      recoveryToken,
      cloudflareEnv,
    };
  }

  return {
    backend: getNodeBetterAuthBackend(),
    baseURL: input.control.canonicalAdminOrigin,
    password: nativePasswordPrimitive(),
    recoveryToken,
    secret,
  };
}

export function recoverySecret(env: PlatformEnv | undefined): string | undefined {
  const bound = env?.CHICKPEA_RECOVERY_TOKEN;
  if (typeof bound === 'string' && bound) return bound;
  const local = process.env.CHICKPEA_RECOVERY_TOKEN;
  return local || undefined;
}

function cloudflareAuthEnv(env: PlatformEnv | undefined): CloudflareBetterAuthEnv | undefined {
  if (!env || typeof env.CHICKPEA_RECOVERY_TOKEN !== 'string') return undefined;
  const authDb = env.AUTH_DB as { prepare?: unknown } | undefined;
  const authGuard = env.AUTH_GUARD as { getByName?: unknown } | undefined;
  if (typeof authDb?.prepare !== 'function' || typeof authGuard?.getByName !== 'function') {
    return undefined;
  }
  return env as unknown as CloudflareBetterAuthEnv;
}
