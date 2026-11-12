import type { z } from 'zod';

import type { SkillConfig } from '../../config/types.ts';
import { fail } from './conventions.ts';
import type * as schemas from './schemas.ts';

type AgentOutput = z.infer<typeof schemas.getAgentOutput>;
type AgentInput = z.infer<typeof schemas.getAgentInput>;

/** The text block and `structuredContent` together, in characters: inside ChatGPT's 10,000 tokens a result (probe 13). */
export const AGENT_RESULT_BUDGET_CHARS = 28_000;
/**
 * The least a one-skill read returns, so reading in parts always moves on,
 * even for an Agent whose own fields already fill the budget.
 */
const LEAST_PART_CHARS = 2_000;

/** Whether the result carries skill text, which its text block then leaves to `structuredContent`. */
function hasSkillText(output: AgentOutput): boolean {
  return output.skills.some((skill) => skill.size !== undefined);
}

/**
 * get_agent's text block. Without skill text it is the JSON, as for every
 * tool. With it, the text sits once, in `structuredContent`, which is all
 * Claude Code and ChatGPT show their model (probes 13b, 14).
 */
export function agentText(output: AgentOutput): string {
  if (!hasSkillText(output)) return JSON.stringify(output);
  const shown = output.skills.filter(({ text }) => typeof text === 'string').map(({ name }) => name);
  return [
    `${output.name}: the text of ${shown.length ? shown.join(', ') : 'no skill'} is in skills[].text of the structured result. version: ${output.version}`,
    ...(output.nextStep ? [`Next: ${output.nextStep}`] : []),
  ].join('\n');
}

function resultSize(output: AgentOutput): number {
  return agentText(output).length + JSON.stringify(output).length;
}

/**
 * get_agent with includeSkillText, or skill: each skill's text in the order
 * the Agent lists them, while the result stays inside the budget. A skill
 * that does not fit has `text: null`; `skill` with `offset` reads one in parts.
 */
export function withSkillText(output: AgentOutput, skills: readonly SkillConfig[], input: AgentInput): AgentOutput {
  if (input.offset !== undefined && input.skill === undefined) {
    fail('invalid_input', 'offset goes with skill: name the skill to read from that point.');
  }
  if (input.skill !== undefined) return oneSkill(output, skills, input.skill, input.offset ?? 0);
  const left = 'Some skill text did not fit in this result.';
  let current: AgentOutput = {
    ...output,
    skills: output.skills.map((row, index) => ({ ...row, text: null, size: skills[index]!.instructions.length, truncated: true })),
    nextStep: `${left} Read one with get_agent { agentId, skill, offset: 0 }, then each nextOffset it returns.`,
  };
  skills.forEach((skill, index) => {
    const filled: AgentOutput = {
      ...current,
      skills: current.skills.map((row, at) => {
        if (at !== index) return row;
        const { truncated: _cut, ...rest } = row;
        return { ...rest, text: skill.instructions };
      }),
    };
    if (resultSize(filled) <= AGENT_RESULT_BUDGET_CHARS) current = filled;
  });
  if (current.skills.every(({ truncated }) => truncated === undefined)) {
    const { nextStep: _none, ...whole } = current;
    return whole;
  }
  return current;
}

function oneSkill(output: AgentOutput, skills: readonly SkillConfig[], name: string, from: number): AgentOutput {
  const index = skills.findIndex((skill) => skill.name === name);
  if (index < 0) {
    fail('not_found', `${output.name} has no skill named ${name}.`, { nextStep: 'Call get_agent for the names in skills.' });
  }
  const whole = skills[index]!.instructions;
  const offset = Math.min(from, whole.length);
  const shaped = (keep: number): AgentOutput => {
    const end = partEnd(whole, offset, keep);
    const more = end < whole.length;
    return {
      ...output,
      skills: output.skills.map((row, at) => at !== index ? row : {
        ...row,
        text: whole.slice(offset, end),
        size: whole.length,
        ...(more ? { truncated: true as const, nextOffset: end } : {}),
      }),
      ...(more ? { nextStep: `More of ${name} follows: call get_agent again with skill "${name}" and offset ${end}.` } : {}),
    };
  };
  const rest = whole.length - offset;
  if (resultSize(shaped(rest)) <= AGENT_RESULT_BUDGET_CHARS) return shaped(rest);
  let low = 0;
  let high = rest;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (resultSize(shaped(middle)) <= AGENT_RESULT_BUDGET_CHARS) low = middle;
    else high = middle - 1;
  }
  return shaped(Math.max(low, Math.min(LEAST_PART_CHARS, rest)));
}

/** Where a part of `keep` characters from `offset` ends, never between the two halves of one character. */
function partEnd(text: string, offset: number, keep: number): number {
  const end = Math.min(text.length, offset + keep);
  if (end > offset && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) return end - 1;
  return end;
}
