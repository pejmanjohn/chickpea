import type { Context } from 'hono';

import { isCloudflareTarget } from '../config/runtime-target.ts';

/**
 * The public origin a request arrived on, resolved fail-closed against header
 * spoofing (the origins built from it become public-facing URLs — Slack event
 * callbacks, avatar links, browser mutation provenance):
 *   1. SLACK_TAG_PUBLIC_URL, when set, is the operator's explicit pin and wins
 *      outright — no request header can override it.
 *   2. On the Cloudflare target the edge terminates TLS and rewrites Host, so
 *      the request URL / Host ARE the public origin; x-forwarded-* here is
 *      caller-supplied and untrusted, so it is ignored entirely.
 *   3. On Node behind a reverse proxy, honor x-forwarded-proto/host but take
 *      the LAST comma-separated hop — the value the proxy nearest this app set
 *      — not the first, which a client can forge by pre-seeding the header.
 */
export function requestOrigin(c: Context): string {
  const pinned = process.env.SLACK_TAG_PUBLIC_URL?.trim();
  if (pinned) {
    return pinned.replace(/\/+$/, '');
  }
  const url = new URL(c.req.url);
  if (isCloudflareTarget()) {
    return `${url.protocol.replace(/:$/, '')}://${c.req.header('host') || url.host}`;
  }
  const forwardedProto = lastForwardedHop(c.req.header('x-forwarded-proto'));
  const forwardedHost = lastForwardedHop(c.req.header('x-forwarded-host'));
  const proto = forwardedProto || url.protocol.replace(/:$/, '');
  const host = forwardedHost || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

// The trusted hop of an X-Forwarded-* header is the LAST value: each proxy
// appends, so the rightmost entry is the one set by the proxy closest to this
// app. Taking the first would trust a value a client can pre-populate.
function lastForwardedHop(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const hops = header
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.length ? hops[hops.length - 1] : undefined;
}
