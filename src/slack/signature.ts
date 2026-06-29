import { createHmac, timingSafeEqual } from 'node:crypto';

const maxSlackTimestampSkewSeconds = 60 * 5;

export interface SlackSignatureInput {
  signingSecret: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  nowSeconds?: number;
}

export function verifySlackSignature(input: SlackSignatureInput): boolean {
  if (!input.signingSecret || !input.timestamp || !input.signature) {
    return false;
  }

  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > maxSlackTimestampSkewSeconds) {
    return false;
  }

  const expected = `v0=${createHmac('sha256', input.signingSecret)
    .update(`v0:${input.timestamp}:${input.body}`)
    .digest('hex')}`;

  const actualBuffer = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
