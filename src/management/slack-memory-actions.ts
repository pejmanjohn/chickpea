import * as v from 'valibot';

import { opaqueId } from '../work/admission.ts';
import { memoryUpdateAcknowledgementText, memoryUpdateSummarySchema } from '../memory/acknowledgement.ts';
import { appliedMemoryReceipt, type SlackMemoryUpdate } from '../slack/memory-update-terminal.ts';
import type { SlackManagementSignal } from './slack-tools.ts';
import type { WorkspaceManagementToolArguments, WorkspaceManagementToolResult } from './tool-adapter.ts';

export const SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION =
  'Remember or forget durable facts for this Agent across fresh conversations. First call inspect_memory, then supply its exact expectedRevision and the complete replacement body, preserving unrelated facts and their wording. Use an empty body only when explicitly asked to forget all saved facts. Supply summary as one short first-person confirmation describing only the change requested in this turn, for example: "I updated my memory to use human-friendly dates and times going forward." Do not quote unrelated saved facts or anything being forgotten. After a successful save, the host uses this summary instead of your final reply when safe; forgetting receives a content-free confirmation. This tool applies a standalone memory request through the management service; it is not a sandbox file write. Do not use it for a compound request that also changes instructions, skills, access, identity, model, or schedules: put all changes together in the existing Agent-authoring proposal instead. Report saved only when the returned outcome is applied; report confirmation_required, denial, or conflict accurately.';

export const slackUpdateAgentMemoryInputSchema = v.strictObject({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  body: v.pipe(v.string(), v.maxLength(65_536)),
  // Presentation must not reject a valid memory mutation. Validate it separately.
  summary: v.optional(v.string()),
});

/** Capture the confirmation at the write, so delivery/reattachment cannot rebase it. */
export async function executeSlackMemoryUpdate(input: {
  signal: Pick<SlackManagementSignal, 'agentId' | 'turnJobId'>;
  /** Trusted frozen runtime plan epoch: injected memory revision plus one. */
  memoryEpoch: number;
  data: v.InferOutput<typeof slackUpdateAgentMemoryInputSchema>;
  inspect(): Promise<WorkspaceManagementToolResult>;
  apply(args: WorkspaceManagementToolArguments['apply_workspace_changes']): Promise<WorkspaceManagementToolResult>;
}): Promise<{ result: WorkspaceManagementToolResult; receipt?: SlackMemoryUpdate }> {
  const { signal, data } = input;
  const summary = v.safeParse(memoryUpdateSummarySchema, data.summary);
  let before: { agentId: string; revision: number; body: string } | undefined;
  // The model still saw the injected snapshot even if it inspected fresher memory.
  // Never release its prose after an intervening write/forget by another turn.
  if (summary.success && data.body.trim() && data.expectedRevision + 1 === input.memoryEpoch) {
    try {
      const inspected = await input.inspect();
      const parsed = v.safeParse(v.object({ agentId: v.string(), revision: v.number(), body: v.string() }),
        inspected.ok ? inspected.result : undefined);
      if (parsed.success && parsed.output.agentId === signal.agentId &&
          parsed.output.revision === data.expectedRevision) before = parsed.output;
    } catch {
      // Missing presentation context falls back without changing write authority.
    }
  }
  const result = await input.apply(slackMemoryUpdateArguments(signal, data));
  const receipt = result.ok ? appliedMemoryReceipt(result.result, signal.agentId) : undefined;
  if (!receipt || receipt.revision !== data.expectedRevision + 1) return { result };
  const text = !data.body.trim() ? 'I cleared my saved memory.'
    : before ? memoryUpdateAcknowledgementText(before, {
      agentId: signal.agentId, revision: receipt.revision, body: data.body,
    }, summary.success ? summary.output : undefined) : 'I updated my memory.';
  return { result, receipt: { ...receipt, summary: text } };
}

/** Reduce the model-facing contract without changing management authority. */
export function slackMemoryUpdateArguments(
  signal: Pick<SlackManagementSignal, 'agentId' | 'turnJobId'>,
  input: v.InferOutput<typeof slackUpdateAgentMemoryInputSchema>,
): WorkspaceManagementToolArguments['apply_workspace_changes'] {
  const data = v.parse(slackUpdateAgentMemoryInputSchema, input);
  return {
    idempotencyKey: opaqueId('memory', `${signal.turnJobId}:${data.expectedRevision}`),
    operations: [{
      itemId: 'memory',
      kind: 'update_agent_memory',
      agentId: signal.agentId,
      expectedRevision: data.expectedRevision,
      body: data.body,
    }],
  };
}
