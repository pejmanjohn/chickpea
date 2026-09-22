import * as v from 'valibot';

import { opaqueId } from '../work/admission.ts';
import {
  memoryUpdateAcknowledgementText,
  memoryUpdatePreservesContext,
  memoryUpdateSummarySchema,
} from '../memory/acknowledgement.ts';
import { appliedMemoryReceipt, type SlackMemoryUpdate } from '../slack/memory-update-terminal.ts';
import type { SlackManagementSignal } from './slack-tools.ts';
import type { WorkspaceManagementToolArguments, WorkspaceManagementToolResult } from './tool-adapter.ts';

export const SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION =
  'Remember or forget durable facts for this Agent across fresh conversations. First call inspect_memory, then supply its exact expectedRevision and the complete replacement body, preserving unrelated facts and their wording. When the requester supplies the wording of an instruction or preference to remember, copy that wording verbatim into the replacement body: do not paraphrase, compress, generalize, or change its exceptions. Concrete triggers include text following "Remember:" and a quoted note the requester explicitly asks you to remember. Store only the supplied durable note; exclude directions about the act of remembering or this turn only, such as "only remember this" or "do not create a task now". If a labeled actionable link is accompanied by its exact URL, the only permitted change to that supplied wording is to include the exact URL with the label; preserve every other word. Never substitute an opaque ID, name, or label for a supplied URL. Ordinary conversational facts that were not supplied as memory wording may still be restated concisely. Use an empty body only when explicitly asked to forget all saved facts. Supply summary as one short first-person confirmation describing only the change requested in this turn. The summary may paraphrase that change; this allowance applies only to summary, while the stored instruction or preference in body remains verbatim. Do not quote unrelated saved facts or anything being forgotten. After a successful save that only adds to the memory you were shown, or writes it back unchanged, the host delivers your final reply, so that reply must answer the rest of the request and confirm what you saved. When the host must withhold your final reply (forgetting, rewriting, a replayed tool call, or memory that changed during the turn), it delivers this summary instead; forgetting receives a content-free confirmation. This tool applies a standalone memory request through the management service; it is not a sandbox file write. Do not use it for a compound request that also changes instructions, skills, access, identity, model, or schedules: put all changes together in the existing Agent-authoring proposal instead. Report saved only when the returned outcome is applied; report confirmation_required, denial, or conflict accurately.';

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
  if (data.body.trim() && data.expectedRevision + 1 === input.memoryEpoch) {
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
  const after = { agentId: signal.agentId, revision: receipt.revision, body: data.body };
  const text = !data.body.trim() ? 'I cleared my saved memory.'
    : before ? memoryUpdateAcknowledgementText(before, after, summary.success ? summary.output : undefined)
    : 'I updated my memory.';
  // Only a write that kept the injected snapshot verbatim lets delivery keep
  // the model's answer; everything else falls back to the bounded summary.
  const preservesContext = before !== undefined && memoryUpdatePreservesContext(before, after);
  return { result, receipt: { ...receipt, summary: text, ...(preservesContext ? { preservesContext: true } : {}) } };
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
