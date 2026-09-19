'use agent';

import {
  useDataWriter,
  useDelivery,
  useInitialData,
  useInstruction,
  useTool,
  type DeliveredMessage,
} from '@flue/runtime';
import * as v from 'valibot';

import {
  runtimePlanSandboxConversationKey,
  type RuntimePlanV2,
} from './runtime-plan.ts';
import { useRuntimePlanAgent } from './slack-thread.ts';
import { RoutineModelResultSchema } from '../routines/prompt.ts';
import { useChickpeaResponseMetadata } from '../usage/response-metadata.ts';

export {
  ROUTINE_RESULT_DATA_NAME,
  parseRoutineExecutionInitialData,
  type RoutineExecutionInitialData,
} from './routine-execution-data.ts';
import {
  ROUTINE_RESULT_DATA_NAME,
  parseRoutineExecutionInitialData,
  type RoutineExecutionInitialData,
} from './routine-execution-data.ts';

export function ChickpeaRoutineExecution({ id }: { id: string }) {
  const data = parseRoutineExecutionInitialData(useInitialData());
  const artifactPlan = routineArtifactPlan(data.runtimePlan, useDelivery());
  useRuntimePlanAgent(artifactPlan ?? data.runtimePlan, id, {
    artifactToolsDisabled: artifactPlan === undefined,
    sandboxConversationKey: runtimePlanSandboxConversationKey(data.runtimePlan, id),
    ...(data.connectorUsageCorrelation
      ? { connectorUsageCorrelation: data.connectorUsageCorrelation }
      : {}),
  });
  if (!artifactPlan) {
    useInstruction('This old queued occurrence has no verified file destination. Return its result as text; file delivery requires a newly scheduled occurrence.');
  }
  useChickpeaResponseMetadata(data.requestedModel);
  useInstruction(
    'Finish by calling submit_routine_result. If an internal file-delivery check continues this response, check the files and submit the complete corrected result again. Only the latest submitted result is delivered. Ordinary assistant text and JSON are not a result.',
  );
  const writeResultData = useDataWriter(ROUTINE_RESULT_DATA_NAME, {
    schema: RoutineModelResultSchema,
  });
  useTool({
    name: 'submit_routine_result',
    description: 'Submit the one final result for this routine occurrence.',
    input: RoutineModelResultSchema,
    output: v.string(),
    run: ({ data: result }) => {
      writeResultData(result);
      return { output: 'Routine result submitted.', terminate: true };
    },
  });
  return data.runtimePlan.instructions;
}

/** Recover the saved destination from the durable host signal, including old plans. */
export function routineArtifactPlan(
  plan: RuntimePlanV2,
  delivery: DeliveredMessage,
): RuntimePlanV2 | undefined {
  // V1 envelopes were plain strings and carry no authoritative destination.
  // Disable file tools for those occurrences instead of widening delivery.
  if (delivery.kind !== 'signal' || !(delivery.type === 'schedule' ||
    (delivery.type === 'slack.file_delivery_check' && delivery.attributes?.originalType === 'schedule'))) return undefined;
  const attrs = delivery.attributes;
  if (!attrs || attrs.workspaceId !== plan.conversation.workspaceId ||
    attrs.conversationId !== plan.artifactDestination.channelId ||
    attrs.ownerAgentId !== plan.agentId ||
    !['channel', 'direct_thread'].includes(attrs.destinationKind ?? '') ||
    typeof attrs.threadTs !== 'string' ||
    (attrs.threadTs !== '' && !/^\d{1,20}\.\d{1,10}$/.test(attrs.threadTs)) ||
    (attrs.destinationKind === 'direct_thread' && attrs.threadTs === '')) {
    throw new Error('Routine file destination does not match its saved schedule signal.');
  }
  return {
    ...plan,
    artifactDestination: {
      kind: 'slack_conversation',
      channelId: plan.artifactDestination.channelId,
      ...(attrs.threadTs ? { threadTs: attrs.threadTs } : {}),
    },
  };
}

// MUST stay a top-level string literal: the Flue build reads it statically to
// derive Durable Object class and binding names before any code runs, so a
// reference to a constant fails the build. `src/agents/names.ts` mirrors this
// value for runtime policy, and `tests/agent-names.test.ts` asserts the two
// never drift apart.
ChickpeaRoutineExecution.agentName = 'chickpea-routine-execution-v2';
ChickpeaRoutineExecution.initialData = v.custom<RoutineExecutionInitialData>((value) => {
  try {
    parseRoutineExecutionInitialData(value);
    return true;
  } catch {
    return false;
  }
}, 'Routine execution creation data is invalid.');
