import { createHmac } from 'node:crypto';

import type {
  FakeProviderConfig,
  FakeSlackBackend,
  FakeSlackBehaviorConfig,
} from './fake-slack.ts';
import type { ConfigSeed } from '../../src/config/store.ts';

/** Signing secret shared by every lane's `postEvent` signer and the lane app. */
export const PARITY_SIGNING_SECRET = 'test-signing-secret';

export interface ScenarioLaneConfig {
  /** `null` boots the lane WITHOUT a bot user id; omit to default to `U_BOT`. */
  botUserId?: string | null;
  slack?: FakeSlackBehaviorConfig;
  provider?: FakeProviderConfig;
  configSeed?: ConfigSeed;
  env?: Record<string, string | undefined>;
}

export interface PostEventResult {
  status: number;
  body: unknown;
}

export interface LaneInstance {
  postEvent(payload: unknown, opts?: { tamper?: boolean }): Promise<PostEventResult>;
  backend: FakeSlackBackend;
  /** Poll the wire log until it is idle (no new entries for ~150ms, cap ~5s). */
  quiesce(): Promise<void>;
  stop(): Promise<void>;
}

export interface Lane {
  name: string;
  start(config: ScenarioLaneConfig): Promise<LaneInstance>;
}

/**
 * Sign a JSON event body with the Slack v0 HMAC scheme and return a Request.
 * `tamper: true` corrupts the signature header after signing.
 */
export function signSlackRequest(body: unknown, opts: { tamper?: boolean } = {}): Request {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', PARITY_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');
  const signature = opts.tamper ? corruptHex(digest) : digest;

  return new Request('http://localhost/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': `v0=${signature}`,
    },
    body: rawBody,
  });
}

/** Flip the last hex character so the signature stays same-length but invalid. */
function corruptHex(hex: string): string {
  const last = hex.at(-1);
  const replacement = last === '0' ? '1' : '0';
  return `${hex.slice(0, -1)}${replacement}`;
}
