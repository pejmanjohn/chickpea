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

/** Validate mutation provenance after the outer Admin authentication gate. */
export function safeMutationRequest(c: Context): boolean {
  const principal = requestPrincipal(c.req.raw);
  if (principal?.machine) return principal.authenticatorKind === 'personal_token';
  // A human principal can only be attached by the outer Admin gate after it
  // validates the canonical browser origin and mutation provenance. Mounted
  // sub-apps may see the internal workerd URL here, so comparing Origin to
  // c.req.url a second time would reject an already-validated request.
  if (principal) return true;
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return false;
  if (c.req.header('authorization')) return true;
  return Boolean(origin);
}

function sessionFingerprint(c: Context): string {
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
