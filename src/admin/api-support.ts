import { createHash } from 'node:crypto';

import type { Context } from 'hono';

import { requestPrincipal } from '../auth/service.ts';

/**
 * Request hygiene shared by the /admin/api sub-apps: JSON body reads, the
 * invalid-request shape, idempotency-key validation, the cross-origin mutation
 * guard, and admin identity derivation.
 */

export async function readJson(c: Context, maxBytes?: number): Promise<unknown> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    return undefined;
  }
  try {
    if (maxBytes === undefined) return await c.req.json();
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).byteLength > maxBytes) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function invalidRequest(c: Context): Response {
  return c.json({ error: 'invalid_request' }, 400);
}

export function readIdempotencyKey(c: Context): string | undefined {
  const key = c.req.header('idempotency-key')?.trim();
  return key && key.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key) ? key : undefined;
}

/**
 * `principalAware: true` honours an authenticated principal first: machine
 * principals must present a personal token, and a mismatched Origin is rejected
 * before an Authorization header can vouch for the request. The default keeps
 * the older header-only posture (Authorization wins outright).
 */
export function safeMutationRequest(
  c: Context,
  { principalAware }: { principalAware?: boolean } = {},
): boolean {
  if (principalAware) {
    const principal = requestPrincipal(c.req.raw);
    if (principal?.machine) return principal.authenticatorKind === 'personal_token';
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) return false;
    if (c.req.header('authorization')) return true;
    return Boolean(origin);
  }
  if (c.req.header('authorization')) return true;
  const origin = c.req.header('origin');
  return Boolean(origin && origin === new URL(c.req.url).origin);
}

export function sessionFingerprint(c: Context): string {
  const credential = c.req.header('authorization') ?? c.req.header('cookie') ?? '';
  return sha256(`admin-session\0${credential}`);
}

export function adminActor(c: Context): string {
  return `admin_${sessionFingerprint(c).slice(0, 20)}`;
}

export function adminCredential(c: Context): {
  id: string;
  origin: string;
} {
  const principal = requestPrincipal(c.req.raw);
  if (principal) {
    return {
      id: principal.credentialId,
      origin: principal.authenticatorKind,
    };
  }
  const host = new URL(c.req.url).hostname;
  return {
    id: adminActor(c),
    origin: host === 'localhost' || host === '127.0.0.1' ? 'local_admin' : 'admin_session',
  };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
