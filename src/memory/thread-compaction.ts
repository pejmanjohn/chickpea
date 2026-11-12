import type { FlueInstrumentation } from '@flue/runtime';

import { CHICKPEA_SLACK_AGENT_NAME } from '../agents/names.ts';

const MAX_COMPACTED_INSTANCES = 512;

/** Instances that compacted in this process, until their response records it (thread-memory.ts). */
const compactedInstances = new Set<string>();

/** A Slack thread that compacted carries its Agent memory in its instructions until a prompt carries it again. */
export const threadCompactionInstrumentation: FlueInstrumentation = {
  key: Symbol.for('chickpea.thread-memory-compaction'),
  interceptor: async (_operation, _context, next) => next(),
  observe(event, context) {
    if (context.agentName === CHICKPEA_SLACK_AGENT_NAME) noteThreadCompaction(event);
  },
  dispose() {},
};

function noteThreadCompaction(event: { type: string; instanceId?: string | undefined; isError?: unknown }): void {
  if (event.type !== 'compaction' || event.isError !== false || typeof event.instanceId !== 'string') return;
  compactedInstances.add(event.instanceId);
  if (compactedInstances.size > MAX_COMPACTED_INSTANCES) {
    const oldest = compactedInstances.values().next();
    if (!oldest.done) compactedInstances.delete(oldest.value);
  }
}

export function threadCompacted(instanceId: string): boolean {
  return compactedInstances.has(instanceId);
}

export function forgetThreadCompaction(instanceId: string): void {
  compactedInstances.delete(instanceId);
}
