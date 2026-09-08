import * as v from 'valibot';

import { opaqueId } from '../work/admission.ts';
import type { SlackManagementSignal } from './slack-tools.ts';
import type { WorkspaceManagementToolArguments } from './tool-adapter.ts';

export const SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION =
  'Remember or forget durable facts for this Agent across fresh conversations. First call inspect_memory, then supply its exact expectedRevision and the complete replacement body, preserving unrelated facts. Use an empty body only when explicitly asked to forget all saved facts. This tool applies a standalone memory request through the management service; it is not a sandbox file write. Do not use it for a compound request that also changes instructions, skills, access, identity, model, or schedules: put all changes together in the existing Agent-authoring proposal instead. Report saved only when the returned outcome is applied; report confirmation_required, denial, or conflict accurately.';

export const slackUpdateAgentMemoryInputSchema = v.strictObject({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  body: v.pipe(v.string(), v.maxLength(65_536)),
});

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
