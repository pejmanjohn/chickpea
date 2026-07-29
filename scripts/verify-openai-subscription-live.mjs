#!/usr/bin/env node
/**
 * Explicit live authorization check against an already-running Chickpea Node
 * or Cloudflare target. It never runs implicitly, never sends a model prompt,
 * and keeps the browser attempt capability in process memory only.
 *
 * The direct originator/Responses compatibility gate is intentionally separate:
 *   npm run verify:openai-subscription-protocol -- --live
 */

import assert from 'node:assert/strict';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(value, next);
    index += 1;
  } else {
    args.set(value, true);
  }
}

if (args.has('--help')) {
  console.log('Usage: npm run verify:openai-subscription:live -- --live --target <node|cloudflare> --base-url <url>');
  console.log('Requires TAG_ADMIN_TOKEN. This validates authorization only; it does not send model traffic or disconnect the account.');
  process.exit(0);
}

assert.equal(
  args.has('--live'),
  true,
  'refusing external authorization without the explicit --live flag',
);
const target = args.get('--target');
assert.ok(target === 'node' || target === 'cloudflare', '--target must be node or cloudflare');
const baseUrl = new URL(String(args.get('--base-url') ?? ''));
assert.equal(baseUrl.username || baseUrl.password, '', 'base URL must not contain credentials');
if (target === 'cloudflare') assert.equal(baseUrl.protocol, 'https:', 'Cloudflare target must use HTTPS');
else assert.ok(baseUrl.protocol === 'http:' || baseUrl.protocol === 'https:', 'Node target must use HTTP(S)');
const adminToken = process.env.TAG_ADMIN_TOKEN;
assert.ok(adminToken, 'TAG_ADMIN_TOKEN is required and is never printed');

const headers = {
  authorization: `Bearer ${adminToken}`,
  'content-type': 'application/json',
};
const endpoint = (path) => new URL(path, baseUrl).href;
const request = async (path, init = {}) => {
  const response = await fetch(endpoint(path), {
    redirect: 'error',
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new Error(`live authorization check failed (${code})`);
  }
  return body;
};

const before = await request('/admin/api/providers/openai/subscription');
assert.equal(before.capability?.enabled, true, 'Subscription preview is disabled on this target');
if (before.status?.state === 'connected') {
  console.log(`[openai-subscription] ${target} target already connected (${before.status.accountFingerprint ?? 'safe identity unavailable'}).`);
  console.log('[openai-subscription] Authorization gate passed; run the separate Slack/routine acceptance checklist without exposing credentials.');
  process.exit(0);
}

const started = await request('/admin/api/providers/openai/subscription/start', {
  method: 'POST',
  body: '{}',
});
assert.equal(started.state, 'authorizing');
assert.equal(typeof started.attemptCapability, 'string');
console.log(`[openai-subscription] Open ${started.verificationUri}`);
console.log(`[openai-subscription] Enter code: ${started.userCode}`);
console.log(`[openai-subscription] Waiting on the ${target} target; the browser capability remains memory-only.`);

let nextPollAt = Number(started.nextPollAt ?? Date.now());
while (Date.now() < Number(started.expiresAt)) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(nextPollAt - Date.now(), 1_000)));
  const result = await request('/admin/api/providers/openai/subscription/poll', {
    method: 'POST',
    body: JSON.stringify({ attemptCapability: started.attemptCapability }),
  });
  if (result.state === 'pending') {
    nextPollAt = Number(result.nextPollAt ?? (Date.now() + 5_000));
    continue;
  }
  assert.equal(result.state, 'connected', `unexpected terminal state ${String(result.state)}`);
  console.log(`[openai-subscription] ${target} authorization verified (${result.accountFingerprint ?? 'safe identity unavailable'}).`);
  console.log('[openai-subscription] This did not send a model request. Complete the Slack, routine, no-fallback, and refresh gates in the runbook.');
  process.exit(0);
}
throw new Error('authorization expired before approval');
