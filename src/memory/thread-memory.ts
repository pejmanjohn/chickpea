import { createHash } from 'node:crypto';

import { useAgentFinish, useAgentStart, usePersistentState } from '@flue/runtime';

import type { SlackThreadContinuation } from '../slack/turn-job-types.ts';
import { promptMemoryText } from '../slack/web-client-context.ts';
import { forgetThreadCompaction, threadCompacted } from './thread-compaction.ts';

/**
 * The Agent's memory rides in a thread's prompts, not its system prompt. One
 * memory serves every thread of an Agent: in the system prompt, each change
 * rewrote every active thread's cache after the tools, and the provider
 * dropped each thread's earlier thinking blocks. The host puts the block in
 * the turn's prompt on the thread's first turn and on the first turn after
 * the memory changed (`promptMemory`). The thread's Agent object adds it to
 * the system prompt only while its context lacks it
 * (`useThreadMemoryInstruction`): after a compaction, after a change to a
 * memory too large to repeat, and in a thread whose earlier turns kept it in
 * the system prompt.
 *
 * A line removed from memory stays readable in a thread that already read
 * it, until the thread compacts.
 */

/**
 * A memory block over this size enters a thread's prompt only on its first
 * turn; a later change rides in the system prompt instead. Memory can be 64
 * KiB, and each repeat stays in the thread for good, so a large memory that
 * changes often would add up to about 20,000 tokens a turn. Sending only the
 * entries that changed would need the body the thread last read, and memory
 * keeps only its current body.
 */
export const PROMPT_MEMORY_BLOCK_BYTES = 16 * 1024;

/** Persistent state: the memory block this thread's context holds. */
export const THREAD_MEMORY_STATE_NAME = 'chickpeaThreadMemory';

export interface ThreadMemory {
  /** The block a prompt of this thread carried, as a digest. */
  digest: string;
  /** A compaction ran since, and its summary may have dropped the block. */
  compacted?: true;
}

/** Where this turn's memory reaches the model, as the host decides it. */
export type PromptMemory =
  /** In this turn's prompt; `replacesEarlier` when the thread may hold an earlier block. */
  | { placement: 'prompt'; replacesEarlier: boolean }
  /** Not in the prompt: the thread holds it, or its Agent object adds it to the system prompt. */
  | { placement: 'held' | 'instructions' }
  /** The memory is empty now, and the thread may hold an earlier block. */
  | { placement: 'cleared' }
  | { placement: 'none' };

/**
 * Where a frozen-plan turn's memory goes. `previous` is the thread
 * transcript's previous turn (getThreadContinuation), undefined on its first
 * turn; its plan names the memory that turn read.
 */
export function promptMemory(input: {
  block: string | undefined;
  memoryEpoch: number;
  previous: SlackThreadContinuation | undefined;
}): PromptMemory {
  const { block, previous } = input;
  const changed = previous !== undefined && previous.runtimePlan?.memoryEpoch !== input.memoryEpoch;
  if (block === undefined) return changed ? { placement: 'cleared' } : { placement: 'none' };
  if (previous === undefined) return { placement: 'prompt', replacesEarlier: false };
  if (!changed) return { placement: 'held' };
  return new TextEncoder().encode(block).byteLength <= PROMPT_MEMORY_BLOCK_BYTES
    ? { placement: 'prompt', replacesEarlier: true }
    : { placement: 'instructions' };
}

/**
 * The memory instruction this render adds: the turn's block, unless the
 * thread's context holds it. `deliveryBody` is the Slack message this
 * render answers, when the render has one; `block` is the turn's staged
 * memory.
 *
 * A prompt that carries the block records it. A compaction drops that
 * record: at the end of the response it ran in, and at once for a render in
 * the same process. Until a later prompt carries the block again, every
 * render adds it, so the system prompt stays the same across the thread's
 * turns.
 */
export function useThreadMemoryInstruction(
  instanceId: string,
  block: string | undefined,
  deliveryBody: string | undefined,
): string | undefined {
  const [held, setHeld] = usePersistentState<ThreadMemory | null>(THREAD_MEMORY_STATE_NAME, null);
  // Declared on every render: Flue re-renders at a would-stop point only for
  // a render that declared a finish hook, and the compaction runs before it.
  useAgentFinish(() => {
    if (!threadCompacted(instanceId)) return;
    setHeld((current) => current && { ...current, compacted: true });
    forgetThreadCompaction(instanceId);
  });
  if (block === undefined) return undefined;
  const digest = digestOf(block);
  const compacted = held?.compacted === true || threadCompacted(instanceId);
  if (deliveryBody?.includes(promptMemoryText(block)) === true) {
    if (held?.digest !== digest || compacted) {
      useAgentStart(() => {
        setHeld({ digest });
        forgetThreadCompaction(instanceId);
      });
    }
    return undefined;
  }
  return held?.digest === digest && !compacted ? undefined : promptMemoryText(block);
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
