import type { AuthPrincipal } from './types.ts';

export interface MutationProvenanceOptions {
  canonicalOrigin: string;
  maxBodyBytes: number;
  requireJson?: boolean;
  /**
   * Some agent-hosted browsers submit a top-level form with an opaque
   * `Origin: null`, even when the form and destination are same-origin. Keep
   * this opt-in narrow: it is intended only for signed browser forms, never
   * general JSON mutation endpoints.
   */
  allowOpaqueOriginFormNavigation?: boolean;
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
  return validateBrowserMutationProvenance(request, options);
}

/**
 * Exact-origin and declared-length precheck for unauthenticated browser forms.
 * Production routes must run actualBodyLimit before this synchronous check.
 */
export function validateBrowserMutationProvenance(
  request: Request,
  options: MutationProvenanceOptions,
): MutationProvenanceResult {
  const expected = canonicalOrigin(options.canonicalOrigin);
  const origin = request.headers.get('origin');
  const opaqueOriginNavigation = origin === 'null' &&
    options.allowOpaqueOriginFormNavigation === true &&
    canonicalOrigin(request.url) === expected &&
    request.headers.get('sec-fetch-site') === 'same-origin' &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-dest') === 'document';
  if (!expected || (!opaqueOriginNavigation && (!origin || canonicalOrigin(origin) !== expected))) {
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
