import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { organization } from 'better-auth/plugins';

import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import type { PasswordPrimitive } from './password.ts';

export const BETTER_AUTH_BASE_PATH = '/api/auth';
export const SESSION_IDLE_SECONDS = 4 * 60 * 60;
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1_000;
export const SESSION_REFRESH_SECONDS = 60 * 60;

export interface CreateBetterAuthInput {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  secret: string;
  password: PasswordPrimitive;
  allowSignUp?: boolean;
}

export function createBetterAuth(input: CreateBetterAuthInput) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  return betterAuth(createOptions({ ...input, baseURL }));
}

function createOptions(input: CreateBetterAuthInput & { baseURL: string }): BetterAuthOptions {
  const secureCookies = new URL(input.baseURL).protocol === 'https:';
  return {
    appName: 'Chickpea',
    baseURL: input.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    secret: input.secret,
    trustedOrigins: [input.baseURL],
    database: input.backend.database,
    emailAndPassword: {
      disableSignUp: !(input.allowSignUp ?? false),
      enabled: true,
      minPasswordLength: 15,
      // Chickpea enforces 128 Unicode code points and 512 UTF-8 bytes before
      // trusted credential writes. This ceiling keeps Better Auth from
      // rejecting a valid 128-code-point non-BMP password by UTF-16 length.
      maxPasswordLength: 512,
      password: input.password,
    },
    session: {
      additionalFields: {
        absoluteExpiresAt: {
          defaultValue: () => new Date(Date.now() + SESSION_ABSOLUTE_MS),
          input: false,
          required: true,
          returned: true,
          type: 'date',
        },
      },
      cookieCache: { enabled: false },
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },
    databaseHooks: {
      session: {
        update: {
          async before(data: Record<string, unknown>, context: unknown) {
            if (!(data.expiresAt instanceof Date)) return;
            const session = (context as {
              context?: { session?: { session?: { token?: string } } };
            } | null)?.context?.session?.session;
            if (!session?.token) return;
            const absolute = await input.backend.absoluteExpiryForToken(session.token);
            if (absolute && data.expiresAt > absolute) {
              return { data: { ...data, expiresAt: absolute } };
            }
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/get-session') return;
        const session = ctx.context.session?.session as
          | { token: string; absoluteExpiresAt?: Date | string | number }
          | undefined;
        if (!session?.token) return;
        const fromSession = session.absoluteExpiresAt instanceof Date
          ? session.absoluteExpiresAt
          : null;
        const absolute = fromSession ?? await input.backend.absoluteExpiryForToken(session.token);
        if (absolute && absolute.getTime() <= Date.now()) {
          await ctx.context.internalAdapter.deleteSession(session.token);
          return ctx.json(null);
        }
      }),
    },
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: 'uuid' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
      useSecureCookies: secureCookies,
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        cancelPendingInvitationsOnReInvite: true,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        async sendInvitationEmail() {},
      }),
    ],
    telemetry: { enabled: false },
  };
}

export function requireSupportedOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    return url.origin;
  } catch {
    throw new Error('A canonical HTTPS origin is required for Better Auth.');
  }
}
