'use agent';

import {
  useDataWriter,
  useInitialData,
  useInstruction,
  useTool,
} from '@flue/runtime';
import * as v from 'valibot';

import {
  parseRuntimePlanV2,
  runtimePlanSandboxConversationKey,
  type RuntimePlanV2,
} from './runtime-plan.ts';
import { useRuntimePlanAgent } from './slack-thread.ts';
import { RoutineModelResultSchema } from '../routines/prompt.ts';
import { useChickpeaResponseMetadata } from '../usage/response-metadata.ts';

export const ROUTINE_RESULT_DATA_NAME = 'routineResult';

export interface RoutineExecutionInitialData {
  runtimePlan: RuntimePlanV2;
  requestedModel: string;
}

export function parseRoutineExecutionInitialData(value: unknown): RoutineExecutionInitialData {
  const parsed = v.safeParse(v.strictObject({
    runtimePlan: v.unknown(),
    requestedModel: v.pipe(v.string(), v.minLength(3), v.maxLength(240)),
  }), value);
  if (!parsed.success) throw new Error('Routine execution creation data is invalid.');
  return {
    runtimePlan: parseRuntimePlanV2(parsed.output.runtimePlan),
    requestedModel: parsed.output.requestedModel,
  };
}

export function ChickpeaRoutineExecution({ id }: { id: string }) {
  const data = parseRoutineExecutionInitialData(useInitialData());
  useRuntimePlanAgent(data.runtimePlan, id, {
    sandboxConversationKey: runtimePlanSandboxConversationKey(data.runtimePlan, id),
  });
  useChickpeaResponseMetadata(data.requestedModel);
  useInstruction(
    'Finish by calling submit_routine_result exactly once. Ordinary assistant text and JSON are not a result.',
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

ChickpeaRoutineExecution.agentName = 'chickpea-routine-execution-v2';
ChickpeaRoutineExecution.initialData = v.custom<RoutineExecutionInitialData>((value) => {
  try {
    parseRoutineExecutionInitialData(value);
    return true;
  } catch {
    return false;
  }
}, 'Routine execution creation data is invalid.');
