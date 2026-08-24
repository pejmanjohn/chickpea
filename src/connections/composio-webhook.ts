const MAX_WEBHOOK_AGE_SECONDS = 300;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:@-]{1,256}$/;
const TOOLKIT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TYPE_PATTERN = /^[a-z0-9._-]{1,128}$/;

export type VerifiedComposioWebhook =
  | { kind: 'expired_account'; accountRef: string; toolkit: string }
  | { kind: 'ignored'; type: string };

export async function verifyComposioWebhook(input: {
  rawBody: string;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  secret: string;
  now?: () => number;
}): Promise<VerifiedComposioWebhook> {
  if (!input.rawBody || input.rawBody.length > 256 * 1024 ||
      !IDENTIFIER_PATTERN.test(input.webhookId) || !input.secret || input.secret.length > 1_024) {
    throw new Error('Composio webhook is invalid');
  }
  const timestamp = Number(input.webhookTimestamp);
  const nowSeconds = (input.now ?? Date.now)() / 1_000;
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_WEBHOOK_AGE_SECONDS) {
    throw new Error('Composio webhook timestamp is invalid');
  }
  const signatures = input.webhookSignature.split(' ').flatMap((entry) => {
    const [version, value] = entry.split(',', 2);
    return version === 'v1' && value ? [value] : [];
  });
  const expected = await hmacSha256Base64(
    input.secret,
    `${input.webhookId}.${input.webhookTimestamp}.${input.rawBody}`,
  );
  if (!signatures.some((candidate) => constantTimeEqual(candidate, expected))) {
    throw new Error('Composio webhook signature is invalid');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw new Error('Composio webhook payload is invalid');
  }
  // `webhook-id` identifies the signed delivery envelope. The V3 payload's
  // `id` identifies the event and is allowed to differ; the HMAC already binds
  // both the delivery identifier and the exact body.
  if (!isRecord(parsed) || typeof parsed.id !== 'string' ||
      !IDENTIFIER_PATTERN.test(parsed.id) || typeof parsed.type !== 'string' ||
      !EVENT_TYPE_PATTERN.test(parsed.type)) {
    throw new Error('Composio webhook payload is invalid');
  }
  if (parsed.type !== 'composio.connected_account.expired') {
    return { kind: 'ignored', type: parsed.type };
  }
  // Expiry is deliberately the only admitted event because its transition is
  // idempotent. Any future event with non-idempotent effects must add durable
  // webhook-id consumption before it is handled here.
  if (!isRecord(parsed.data) ||
      typeof parsed.data.id !== 'string' || !IDENTIFIER_PATTERN.test(parsed.data.id) ||
      !isRecord(parsed.data.toolkit) || typeof parsed.data.toolkit.slug !== 'string' ||
      !TOOLKIT_PATTERN.test(parsed.data.toolkit.slug)) {
    throw new Error('Composio webhook payload is invalid');
  }
  return {
    kind: 'expired_account',
    accountRef: parsed.data.id,
    toolkit: parsed.data.toolkit.slug.toLowerCase(),
  };
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  ));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
