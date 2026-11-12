import type { WebClient } from '@slack/web-api';

import { canonicalSlackReplyText, escapeSlackControlCharacters } from '../slack/message-format.ts';
import { dailyLimitScopeOfText } from '../slack/web-client-presenter.ts';
import type { ShadowWorkLifecycle } from '../work/lifecycle.ts';
import {
  deliverRoutineSlackMessage,
  formatScheduledTime,
  recordRoutinePost,
  routineNotice,
  routineSlackClient,
  type RoutineDeliveryReceipt,
  type RoutineThreadRecord,
} from './delivery.ts';
import type { RoutineRuntimeAccess } from './runtime.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from './types.ts';

/**
 * The one notice for each pause of a routine that is out of usage: the
 * pause's first skipped run posts it, each later skipped run posts nothing,
 * and the next run that succeeds edits it (closeRoutinePauseNotice).
 * Undefined when the pause already has its notice.
 */
export async function deliverRoutinePauseNotice(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    workLifecycle?: ShadowWorkLifecycle;
    threadRecord?: RoutineThreadRecord;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
  },
): Promise<RoutineDeliveryReceipt | undefined> {
  const [previous] = await pauseSkips(input.store, input.run, 1);
  // Inside a pause only the run whose notice was posted, or may have been,
  // leaves the runs after it silent (`none`); a notice Slack refused posts again.
  if (previous && previous.deliveryStatus !== 'failed') return undefined;
  const at = formatRoutineTime(input.run.scheduledFor, input.routine.timezone);
  const why = PAUSE_REASONS[dailyLimitScopeOfText(input.run.publicError) ?? 'usage'];
  const text = [
    `⏸️ **${escapeSlackControlCharacters(input.routine.name)} is paused**`,
    '',
    `It didn't run at ${at} because ${why} Until then I'll skip runs without posting again.`,
  ].join('\n');
  return deliverRoutineSlackMessage(
    { ...input, changeKeyHash: null, approvedOutput: canonicalSlackReplyText(text, 'markdown') },
    routineNotice(text, input.routine, input.run, input.access),
    routineSlackClient(input.access),
  );
}


const PAUSE_REASONS = {
  usage: 'this workspace is out of usage. It runs again on schedule once usage is added.',
  workspace: "this workspace reached today's free trial limit. It runs again on schedule after the limit resets.",
  fleet: 'Chickpea has paused free trial usage for now. It runs again on schedule once trials resume.',
} as const;

/**
 * Edits the pause's notice once `run`, the next run after it, succeeds, and
 * its thread's record with it. Best effort: a later run never retries it.
 */
export async function closeRoutinePauseNotice(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    threadRecord?: RoutineThreadRecord;
  },
): Promise<void> {
  const skipped = await pauseSkips(input.store, input.run);
  const notice = skipped.findLast(({ deliveryStatus }) => deliveryStatus === 'delivered');
  if (!notice?.deliveryChannelId || !notice.deliveryMessageTs) return;
  const client = routineSlackClient(input.access);
  const runs = skipped.length === 1 ? '1 run' : `${skipped.length} runs`;
  const text = [
    `▶️ **${escapeSlackControlCharacters(input.routine.name)} is back on**`,
    '',
    `It skipped ${runs} and ran again ${formatScheduledTime(input.run.scheduledFor, input.routine.timezone)}.`,
  ].join('\n');
  const rendered = routineNotice(text, input.routine, input.run, input.access);
  await client.chat.update({
    channel: notice.deliveryChannelId,
    ts: notice.deliveryMessageTs,
    text: rendered.text,
    ...(rendered.blocks ? { blocks: rendered.blocks } : {}),
  } as unknown as Parameters<WebClient['chat']['update']>[0]);
  await recordRoutinePost(input.threadRecord, input.routine, input.access.config.agentId, {
    channelId: notice.deliveryChannelId,
    messageTs: notice.deliveryMessageTs,
    text: canonicalSlackReplyText(text, 'markdown'),
  });
}

/**
 * The failed `spend_limited` runs before `run` in its routine's current
 * pause, newest first, up to `most`. A run that succeeded, or failed for
 * another reason, ends a pause; one that never ran (skipped, cancelled) does
 * not. A short page answers the common case, a run with no pause before it.
 */
async function pauseSkips(store: RoutineStore, run: RoutineRun, most = PAUSE_SCAN_LIMIT): Promise<RoutineRun[]> {
  let skipped: RoutineRun[] = [];
  for (const limit of [10, PAUSE_SCAN_LIMIT]) {
    const runs = await store.listRuns({ routineId: run.routineId, limit });
    const index = runs.findIndex((other) => other.id === run.id);
    skipped = [];
    if (index < 0) {
      if (runs.length < limit) return [];
      continue;
    }
    for (const other of runs.slice(index + 1)) {
      if (other.status === 'failed' && other.failureClass === 'spend_limited') {
        skipped.push(other);
        if (skipped.length >= most) return skipped;
      } else if (other.status === 'succeeded' || other.status === 'no_op' || other.status === 'failed') {
        return skipped;
      }
    }
    if (runs.length < limit) return skipped;
  }
  return skipped;
}

const PAUSE_SCAN_LIMIT = 500;

function formatRoutineTime(timestamp: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toISOString();
  }
}
