import type { ConversationStreamChunk } from '@flue/runtime';

import {
  parseWorkspaceMilestone,
  WORKSPACE_MILESTONE_DATA_NAME,
  type WorkspaceMilestoneRecord,
} from './coding-worker-run.ts';

export type WorkspaceMilestoneSink = (record: WorkspaceMilestoneRecord) => Promise<void>;

export interface WorkspaceMilestoneRelay {
  onEvent(chunk: ConversationStreamChunk): void;
  /** Records from the settled reply's data, for any the live stream missed. */
  replay(values: unknown): void;
  /** Resolves once every accepted record was applied (or failed and was logged). */
  drain(): Promise<void>;
}

/**
 * The `workspace_task` milestone records of one submission, in stream order,
 * for the turn's working indicator. A re-attached read replays the whole
 * conversation from its start, so only records inside this submission's
 * response count, and each task's record is applied once. Records are applied
 * one at a time and a failure is logged, never thrown: the answer does not
 * wait on progress.
 */
export function createWorkspaceMilestoneRelay(
  submissionId: string,
  apply: WorkspaceMilestoneSink,
): WorkspaceMilestoneRelay {
  const messageIds = new Set<string>();
  const seen = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  const accept = (value: unknown) => {
    const record = parseWorkspaceMilestone(value);
    if (!record) return;
    const key = `${record.toolCallId}:${record.milestone}:${record.state}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain = chain.then(() => apply(record)).catch((error: unknown) => {
      console.warn(
        `[chickpea] workspace progress update skipped: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    });
  };

  return {
    onEvent(chunk) {
      const record = chunk as unknown as Record<string, unknown>;
      if (record.type === 'message-started') {
        if (record.submissionId === submissionId && typeof record.messageId === 'string') {
          messageIds.add(record.messageId);
        }
        return;
      }
      if (record.type !== 'data-part' || record.name !== WORKSPACE_MILESTONE_DATA_NAME) return;
      if (typeof record.messageId !== 'string' || !messageIds.has(record.messageId)) return;
      accept(record.data);
    },
    replay(values) {
      if (!Array.isArray(values)) return;
      for (const value of values) accept(value);
    },
    drain: () => chain,
  };
}
