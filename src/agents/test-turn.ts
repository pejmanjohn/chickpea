'use agent';

import { useDelivery, useInitialData, useInstruction, type AgentProps } from '@flue/runtime';
import * as v from 'valibot';

import { parseRuntimePlanV2, type RuntimePlanV2 } from './runtime-plan.ts';
import { PART_SEPARATOR, slackAgentKind, slackSystemBaseParts, type SlackSystemPart } from './shared-prefix-layout.ts';
import { useRuntimePlanAgent } from './slack-thread.ts';
import { creationPlanAgentExtension } from './cloudflare-extension.ts';
import { CHICKPEA_SUBMISSION_DURABILITY } from './submission-durability.ts';
import { MAX_MEMORY_BLOCK_BYTES } from './turn-input.ts';
import type { AgentKind } from '../config/types.ts';
import { ADVISORY_MEMORY_FINAL_CHECK } from '../slack/web-client-context.ts';
import { requestTokens } from '../web/page.ts';
import { useWebTurn } from '../web/turn.ts';

const TestTurnDataSchema = v.strictObject({
  runtimePlan: v.unknown(),
  memoryBlock: v.optional(v.pipe(v.string(), v.minLength(1), v.maxBytes(MAX_MEMORY_BLOCK_BYTES))),
  requester: v.strictObject({
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    timezone: v.pipe(v.string(), v.check((zone) => localTime(zone, 0) !== undefined, 'unknown timezone')),
    askedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  /** Set by the state store alone: the message quotes earlier turns of the practice conversation. */
  quotesEarlierTurns: v.optional(v.literal(true)),
});

export type TestTurnInitialData = Omit<v.InferOutput<typeof TestTurnDataSchema>, 'runtimePlan'> & {
  runtimePlan: RuntimePlanV2;
};

export function parseTestTurnInitialData(value: unknown): TestTurnInitialData {
  const data = v.parse(TestTurnDataSchema, value);
  const runtimePlan = parseRuntimePlanV2(data.runtimePlan);
  if (runtimePlan.conversation.surface !== 'test') throw new Error('A test run needs a test run plan.');
  return { ...data, runtimePlan };
}

/** One read-only practice run of an Agent on a question, as the caller, posting nowhere. */
export function ChickpeaTestTurn({ id }: AgentProps) {
  const { runtimePlan: plan, memoryBlock, requester, quotesEarlierTurns } = parseTestTurnInitialData(useInitialData());
  useInstruction(plan.instructions);
  useRuntimePlanAgent(plan, id, {
    responseMetadataModel: plan.model,
    artifactToolsDisabled: true,
    instructionsInSystemBase: true,
    // A model wrote the ask, so none of its URLs counts as typed by a person.
    web: { turn: useWebTurn(id), request: { typed: [], tokens: requestTokens(useDelivery().body) } },
  });
  if (memoryBlock) useInstruction(`${memoryBlock}\n\n${ADVISORY_MEMORY_FINAL_CHECK}`);
  useInstruction(testTurnFraming(requester, quotesEarlierTurns === true));
  return testTurnSystemBase(slackAgentKind(plan.agentId));
}

export const TEST_TURN_OMITTED_PARTS: ReadonlySet<SlackSystemPart> =
  new Set(['fileCompletion', 'agentAuthoring', 'management', 'memberTools', 'presentTable']);

export function testTurnSystemBase(kind: AgentKind): string {
  return slackSystemBaseParts({ kind, managementMounted: true, memberToolsMounted: true })
    .flatMap(([part, text]) => TEST_TURN_OMITTED_PARTS.has(part) ? [] : [text]).join(PART_SEPARATOR);
}

/** The last instruction: what this run is, and whether the message quotes earlier turns. */
export function testTurnFraming({ name, timezone, askedAt }: TestTurnInitialData['requester'], followUp = false): string {
  return `This is a practice run, not a Slack conversation. ${name} sent this question from an app they connected to ` +
    `Chickpea, to see how you answer. Your answer goes back to them there and is not posted anywhere. It is ` +
    `${localTime(timezone, askedAt)} in their timezone, ${timezone}.\n\nAnswer as you would in a direct message from them, ` +
    'and read what you need the way you normally would. Only tools that read are available here. Nothing can send, ' +
    'post, create, change, delete or remember anything, and Slack reading, files, images, the browser and coding ' +
    'workspaces are off. If the question needs one of those, do the reading part, then say in one sentence what you ' +
    'would do and that you can do it once they ask you in Slack. Don\'t mention this practice run otherwise. ' +
    (followUp
      ? 'Earlier turns of this practice conversation are quoted in the message, each with a line naming what it read. ' +
        'What those reads returned is not included, so read again if you need it.'
      : 'There are no earlier messages.');
}

/** "Monday, 9 November 2026, 14:05"; undefined for an unknown timezone. */
function localTime(timezone: string, at: number): string | undefined {
  try {
    const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map(({ type, value }) => [type, value]));
    return `${part.weekday}, ${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute}`;
  } catch {
    return undefined;
  }
}

// Must stay a static literal — see the note on ChickpeaRoutineExecution.
ChickpeaTestTurn.agentName = 'chickpea-test-turn-v1';
export const cloudflare = creationPlanAgentExtension;
// A direct message's own durability: a practice run is bounded only as a direct message to the same Agent is.
ChickpeaTestTurn.durability = CHICKPEA_SUBMISSION_DURABILITY;
ChickpeaTestTurn.initialData = v.custom<TestTurnInitialData>((value) => {
  try {
    parseTestTurnInitialData(value);
    return true;
  } catch {
    return false;
  }
}, 'Test run creation data is invalid.');
