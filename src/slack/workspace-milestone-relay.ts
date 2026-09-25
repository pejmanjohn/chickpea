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
  /**
   * True when the last observed chunk was this submission's milestone start:
   * the coordinator is waiting on the coding worker and the stream will be
   * quiet until the step settles.
   */
  isIdleCandidate(): boolean;
}

/**
 * The `workspace_task` checklist records of one submission, in stream order.
 * A re-attached read replays the whole conversation from its start, so only
 * records inside this submission's response count. The checklist follows the
 * response's first delegated task; later tasks in the same response keep
 * their progress in the coordinator's reply. Records are applied one at a
 * time and a failure is logged, never thrown: the answer does not wait on
 * the checklist.
 */
export function createWorkspaceMilestoneRelay(
  submissionId: string,
  apply: WorkspaceMilestoneSink,
): WorkspaceMilestoneRelay {
  const messageIds = new Set<string>();
  const seen = new Set<string>();
  let pinnedToolCallId: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let awaitingWorker = false;

  const accept = (record: WorkspaceMilestoneRecord | undefined) => {
    if (!record) return;
    pinnedToolCallId ??= record.toolCallId;
    if (record.toolCallId !== pinnedToolCallId) return;
    const key = `${record.milestone}:${record.state}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain = chain.then(() => apply(record)).catch((error: unknown) => {
      console.warn(
        `[chickpea] workspace checklist update skipped: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    });
  };

  return {
    onEvent(chunk) {
      awaitingWorker = false;
      const record = chunk as unknown as Record<string, unknown>;
      if (record.type === 'message-started') {
        if (record.submissionId === submissionId && typeof record.messageId === 'string') {
          messageIds.add(record.messageId);
        }
        return;
      }
      if (record.type !== 'data-part' || record.name !== WORKSPACE_MILESTONE_DATA_NAME) return;
      if (typeof record.messageId !== 'string' || !messageIds.has(record.messageId)) return;
      const milestone = parseWorkspaceMilestone(record.data);
      awaitingWorker = milestone?.state === 'started';
      accept(milestone);
    },
    replay(values) {
      if (!Array.isArray(values)) return;
      for (const value of values) accept(parseWorkspaceMilestone(value));
    },
    drain: () => chain,
    isIdleCandidate: () => awaitingWorker,
  };
}
