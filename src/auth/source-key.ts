import { isCloudflareTarget } from '../config/runtime-target.ts';

/**
 * Returns a stable, non-secret key for unauthenticated rate-limit buckets.
 * Only Cloudflare Workers may trust cf-connecting-ip; a direct Node client can
 * set that header itself, so self-hosted requests stay in the local-origin
 * bucket unless a future trusted-proxy contract is configured explicitly.
 */
export function requestAuthSourceKey(
  request: Request,
  cloudflareTarget = isCloudflareTarget(),
): string {
  const cloudflareAddress = cloudflareTarget
    ? request.headers.get('cf-connecting-ip')?.trim()
    : undefined;
  return cloudflareAddress || `local:${new URL(request.url).host}`;
}
