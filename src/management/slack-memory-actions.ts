import * as v from 'valibot';

import { opaqueId } from '../work/admission.ts';
import { appliedMemoryReceipt, type SlackMemoryUpdate } from '../slack/memory-update-terminal.ts';
import type { SlackManagementSignal } from './slack-tools.ts';
import type { WorkspaceManagementToolArguments, WorkspaceManagementToolResult } from './tool-adapter.ts';

export const SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION =
  'Remember or forget durable facts for this Agent across fresh conversations. First call inspect_memory, then supply its exact expectedRevision and the complete replacement body, preserving unrelated facts and their wording. When the requester supplies the wording of an instruction or preference to remember, copy that wording verbatim into the replacement body: do not paraphrase, compress, generalize, or change its exceptions. Concrete triggers include text following "Remember:" and a quoted note the requester explicitly asks you to remember. Store only the supplied durable note; exclude directions about the act of remembering or this turn only, such as "only remember this" or "do not create a task now". If a labeled actionable link is accompanied by its exact URL, the only permitted change to that supplied wording is to include the exact URL with the label; preserve every other word. Never substitute an opaque ID, name, or label for a supplied URL. Ordinary conversational facts that were not supplied as memory wording may still be restated concisely. Use an empty body only when explicitly asked to forget all saved facts. The host always delivers your final reply. After a successful save, that reply must answer the rest of the request and briefly confirm, in the first person, only the change requested in this turn. The confirmation may paraphrase that change; the stored instruction or preference in body remains verbatim. Never quote or restate anything being forgotten, and do not list, quote, or restate the rest of the saved memory unless the requester explicitly asks to see it. Relevant saved facts may still inform the rest of your answer. This tool applies a standalone memory request through the management service; it is not a sandbox file write. Do not use it for a compound request that also changes instructions, skills, access, identity, model, or schedules: put all changes together in the existing Agent-authoring proposal instead. Report saved only when the returned outcome is applied; report confirmation_required, denial, or conflict accurately.';

export const slackUpdateAgentMemoryInputSchema = v.strictObject({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  body: v.pipe(v.string(), v.maxLength(65_536)),
});

/** Apply the write and return its receipt. */
export async function executeSlackMemoryUpdate(input: {
  signal: Pick<SlackManagementSignal, 'agentId' | 'turnJobId'>;
  data: v.InferOutput<typeof slackUpdateAgentMemoryInputSchema>;
  apply(args: WorkspaceManagementToolArguments['apply_workspace_changes']): Promise<WorkspaceManagementToolResult>;
}): Promise<{ result: WorkspaceManagementToolResult; receipt?: SlackMemoryUpdate }> {
  const { signal, data } = input;
  const result = await input.apply(slackMemoryUpdateArguments(signal, data));
  const receipt = result.ok ? appliedMemoryReceipt(result.result, signal.agentId) : undefined;
  if (!receipt || receipt.revision !== data.expectedRevision + 1) return { result };
  return { result, receipt };
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
