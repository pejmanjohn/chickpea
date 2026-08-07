import type { AuthPrincipal } from './types.ts';

export interface MutationProvenanceOptions {
  canonicalOrigin: string;
  maxBodyBytes: number;
  requireJson?: boolean;
}

export type MutationProvenanceResult =
  | { ok: true }
  | { ok: false; code: 'cross_origin_denied' | 'content_type_denied' | 'body_too_large' };

export function validateMutationProvenance(
  request: Request,
  principal: AuthPrincipal,
  options: MutationProvenanceOptions,
): MutationProvenanceResult {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return { ok: true };
  if (principal.machine) {
    return principal.authenticatorKind === 'personal_token'
      ? { ok: true }
      : { ok: false, code: 'cross_origin_denied' };
  }
  const expected = canonicalOrigin(options.canonicalOrigin);
  const origin = request.headers.get('origin');
  if (!origin || canonicalOrigin(origin) !== expected) {
    return { ok: false, code: 'cross_origin_denied' };
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site') {
    return { ok: false, code: 'cross_origin_denied' };
  }
  if (options.requireJson !== false) {
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') return { ok: false, code: 'content_type_denied' };
  }
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > options.maxBodyBytes) {
    return { ok: false, code: 'body_too_large' };
  }
  return { ok: true };
}

function canonicalOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}
