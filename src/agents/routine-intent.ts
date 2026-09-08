'use agent';

import { useDataWriter, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

import { isCloudflareTarget } from '../config/runtime-target.ts';
import { SEED_CLOUDFLARE_MODEL_PIN } from '../config/seed.ts';
import { RoutineIntentSchema } from '../routines/intent-schema.ts';
import { useChickpeaResponseMetadata } from '../usage/response-metadata.ts';
import { bootstrapRuntimeProviders } from '../runtime-bootstrap.ts';

bootstrapRuntimeProviders();

export const ROUTINE_INTENT_DATA_NAME = 'routineIntent';

const RoutineIntentInitialDataSchema = v.strictObject({
  model: v.pipe(v.string(), v.minLength(3), v.maxLength(240)),
});
type RoutineIntentInitialData = v.InferOutput<typeof RoutineIntentInitialDataSchema>;

const instructions = [
  'Classify and normalize one Slack message that may create, edit, or manage scheduled Chickpea work.',
  'You have no tools and must never execute, promise, or simulate the requested task.',
  'Finish by calling submit_routine_intent exactly once. JSON in ordinary assistant text is ignored.',
  'Use action "none" for questions, examples, vague discussion, or any message that is not a clear request to create, edit, or manage scheduled work.',
  'For create/edit, taskText must be copied verbatim as one contiguous span of the current Slack message (apart from surrounding whitespace). Do not paraphrase, change identifiers, append actions, or discard a negation or negative directive. A scheduling wrapper such as "Every day," may remain outside taskText.',
  'For recurring work, set triggerKind to "schedule" and translate recurrence to a standard five-field cron expression. Never use seconds, macros, or a frequency shorter than five minutes.',
  'For one-time future work, set triggerKind to "once" and normalize scheduleExpression to an exact local YYYY-MM-DDTHH:mm value.',
  'Normalize familiar human time-zone phrases to IANA zones: PT, Pacific, PST, or PDT mean America/Los_Angeles; ET/Eastern mean America/New_York; CT/Central mean America/Chicago; MT/Mountain mean America/Denver. Otherwise use an explicit IANA time zone when supplied. If the request has no time zone, use the Default IANA time zone from the message and set timezoneWasDefaulted true.',
  'outputPolicy is "post_on_change" only when the user explicitly asks to post only when something changed; otherwise use "post".',
  'For show, pause, resume, disable, run, clone, or delete, return routineName exactly as the user wrote it and no task or schedule fields.',
  'Only return routineId when that literal ID appears in the current Slack message. Never guess or select an ID.',
  'For edit, omit taskText unless the user asked to change the task. Use routineName when the user identified the routine by name.',
  'Shape: {"action":"none"|"create"|"edit"|"show"|"pause"|"resume"|"disable"|"run"|"clone"|"delete","routineId"?:string,"routineName"?:string,"name"?:string,"description"?:string,"taskText"?:string,"triggerKind"?:"schedule"|"once","scheduleExpression"?:string,"timezone"?:string,"timezoneWasDefaulted"?:boolean,"outputPolicy"?:"post"|"post_on_change"}.',
].join('\n');

/**
 * Deployment-compatibility class for already-migrated Cloudflare Durable Objects.
 * Interactive Slack code must not initialize or dispatch it: conversational
 * scheduled work belongs to the Agent-authoring skill and management tools.
 */
export function ChickpeaRoutineIntent() {
  const { model } = useInitialData<RoutineIntentInitialData>();
  useModel(model);
  useChickpeaResponseMetadata(model);
  const writeIntentData = useDataWriter(ROUTINE_INTENT_DATA_NAME, {
    schema: RoutineIntentSchema,
  });
  useTool({
    name: 'submit_routine_intent',
    description: 'Submit the one final, normalized routine intent.',
    input: RoutineIntentSchema,
    output: v.string(),
    run: ({ data }) => {
      writeIntentData(data);
      return { output: 'Routine intent submitted.', terminate: true };
    },
  });
  return instructions;
}

// Must stay a static literal — see the note on ChickpeaRoutineExecution.
ChickpeaRoutineIntent.agentName = 'chickpea-routine-intent-v2';
ChickpeaRoutineIntent.initialData = RoutineIntentInitialDataSchema;

export function routineIntentModel(): string {
  return isCloudflareTarget()
    ? SEED_CLOUDFLARE_MODEL_PIN
    : 'anthropic/claude-haiku-4-5';
}
