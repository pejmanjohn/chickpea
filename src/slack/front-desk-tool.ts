import * as v from 'valibot';

import type { RuntimePlanFrontDeskV1 } from '../agents/runtime-plan.ts';
import {
  FRONT_DESK_MAX_NOTE_CHARS,
  FRONT_DESK_MAX_TARGETS,
  FRONT_DESK_SELF_HANDLE,
  FRONT_DESK_TOOL_NAME,
  resolveFrontDeskTargets,
  sanitizeFrontDeskNote,
  type FrontDeskHandoff,
} from './front-desk.ts';

export const FrontDeskHandoffSchema = v.strictObject({
  agentIds: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    v.minLength(1),
    v.maxLength(FRONT_DESK_MAX_TARGETS),
  ),
  note: v.pipe(v.string(), v.maxLength(FRONT_DESK_MAX_NOTE_CHARS)),
});

/**
 * Constant text, so the tool's definition is the same on every turn that
 * mounts it and its shared-prefix segment stays cacheable.
 */
export const FRONT_DESK_TOOL_DESCRIPTION = [
  'Hand the person\'s current request to one of their other Agents, listed in "Agents this person may use" ' +
    'in the current message.',
  'The host posts your note as your reply and the Agent you name answers the request in this thread, ' +
    'with the person\'s own message and files. Your reply ends with this call.',
  'Rules:',
  '1. One listed Agent clearly fits, by a website login host, a connection, a skill, or its purpose: hand off to it.',
  '2. Several fit: if one of them is the most recent Agent in this DM and the message does not say otherwise, ' +
    'hand off to it. Otherwise name all of them, and "chickpea" too if you also fit, so the person picks with a button.',
  '3. The request is about this workspace (creating or changing Agents, connecting something to an Agent, ' +
    'settings, or a question about Chickpea itself): do not call this tool; answer yourself.',
  '4. No listed Agent fits: do not call this tool; answer yourself, accurately.',
  '5. Never say this workspace lacks a login, connection, or skill that a listed Agent has. ' +
    'If no listed Agent has it, say which listed Agent an Admin could add it to.',
  'An Agent with its own Slack app is not in the list. If the person names one, tell them to message it directly.',
].join('\n');

// Looser than the host's caps on purpose: a call past them still reaches the
// tool, which refuses too many Agents in its own words and trims a long note.
const FrontDeskToolInput = v.strictObject({
  agents: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(200))),
    v.maxLength(16),
    v.description(
      `1 to ${FRONT_DESK_MAX_TARGETS} Agents from the list, by @handle without the @ (or by name when the list shows no handle). ` +
      `"${FRONT_DESK_SELF_HANDLE}" names you, and only beside at least one other Agent.`,
    ),
  ),
  note: v.pipe(
    v.string(),
    v.maxLength(2_000),
    v.description(
      `One plain sentence for the person saying why, at most ${FRONT_DESK_MAX_NOTE_CHARS} characters. No mentions or links.`,
    ),
  ),
});

/**
 * `hand_off_to_agent`, bound to this turn's frozen list. Every name is
 * checked against that list, and a refusal is a tool error that never names
 * an Agent outside it. One call per turn; a successful one ends the run.
 */
export function createFrontDeskTool(input: {
  plan: RuntimePlanFrontDeskV1;
  write: (handoff: FrontDeskHandoff) => void;
}) {
  let handedOff = false;
  return {
    name: FRONT_DESK_TOOL_NAME,
    description: FRONT_DESK_TOOL_DESCRIPTION,
    input: FrontDeskToolInput,
    output: v.string(),
    run: ({ data }: { data: v.InferOutput<typeof FrontDeskToolInput> }) => {
      if (handedOff) throw new Error('This request is already handed off. End your reply now.');
      const targets = resolveFrontDeskTargets(data.agents, input.plan);
      if (!targets.ok) throw new Error(targets.error);
      handedOff = true;
      input.write({ agentIds: targets.agentIds, note: sanitizeFrontDeskNote(data.note) });
      return { output: 'Handed off.', terminate: true };
    },
  };
}

/** The tool's record in a reply, or undefined when the reply holds none that parses. */
export function parseFrontDeskHandoff(value: unknown): FrontDeskHandoff | undefined {
  const records = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const parsed = v.safeParse(FrontDeskHandoffSchema, records[0]);
  return parsed.success ? parsed.output : undefined;
}
