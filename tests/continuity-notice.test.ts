import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode } from '@slack/web-api';

import {
  CONTINUITY_NOTICE_TEXT,
  ContinuityNoticeDeliveryError,
  ensureContinuityNotice,
} from '../src/slack/continuity-notice.ts';
import type { SlackContinuityNoticeProgress } from '../src/config/state-rpc.ts';

test('continuity notice is checkpointed before posting and delivered only once', async () => {
  const events: string[] = [];
  let progress: SlackContinuityNoticeProgress | undefined;
  const input = {
    required: true,
    post: async (text: string) => {
      events.push(`post:${text}`);
      return '1800000000.000100';
    },
    record: async (notice: SlackContinuityNoticeProgress) => {
      progress = notice;
      events.push(`record:${notice.status}`);
    },
  };

  await ensureContinuityNotice(input);
  await ensureContinuityNotice({ ...input, ...(progress ? { progress } : {}) });

  assert.deepEqual(events, [
    'record:posting',
    `post:${CONTINUITY_NOTICE_TEXT}`,
    'record:delivered',
  ]);
  assert.deepEqual(progress, {
    status: 'delivered',
    messageTs: '1800000000.000100',
  });
});

test('confirmed notice failure is retryable while ambiguous posting is fenced', async () => {
  const records: SlackContinuityNoticeProgress[] = [];
  await assert.rejects(
    () => ensureContinuityNotice({
      required: true,
      post: async () => {
        throw Object.assign(new Error('Slack rejected the post'), {
          code: ErrorCode.PlatformError,
        });
      },
      record: (notice) => { records.push(notice); },
    }),
    (error: unknown) =>
      error instanceof ContinuityNoticeDeliveryError && !error.recoveryRequired,
  );
  assert.deepEqual(records.map((record) => record.status), ['posting', 'retryable']);

  let posted = false;
  await assert.rejects(
    () => ensureContinuityNotice({
      required: true,
      progress: { status: 'posting' },
      post: async () => {
        posted = true;
        return 'should-not-post';
      },
      record: () => {},
    }),
    (error: unknown) =>
      error instanceof ContinuityNoticeDeliveryError && error.recoveryRequired,
  );
  assert.equal(posted, false);
});
