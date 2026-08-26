import { defineSkill, SkillDefinitionValidationError, type Skill } from '@flue/runtime';

import type { SkillConfig } from './types.ts';

/**
 * Materialize a profile's stored skills into Flue `SkillReference`s for the
 * agent's `AgentRuntimeConfig.skills`. Two spike-proven guards are mandatory
 * (see docs/plans/2026-07-13-capabilities-and-execution-plan.md, Phase 1):
 *
 *  1. DEDUPE BY NAME before returning. Duplicate skill names are a downstream
 *     turn-killer — Flue's `assertUniqueNames` throws AFTER the agent factory
 *     returns, aborting the turn with zero provider calls, and it cannot be
 *     caught here. Last-writer-wins keeps a single entry per name.
 *  2. PER-ROW `try/catch`. An invalid name/description throws
 *     `SkillDefinitionValidationError` synchronously at the `defineSkill` call;
 *     skip that one row so a single bad skill never kills the whole turn. (The
 *     admin write path validates too; this is defense in depth against a row
 *     that reached the store by another path.)
 *
 * Only `enabled` skills are materialized.
 */
export function resolveProfileSkills(
  skills: readonly SkillConfig[] | undefined,
  options: { reservedNames?: readonly string[] } = {},
): Skill[] {
  if (!skills || skills.length === 0) {
    return [];
  }
  // Last-writer-wins dedupe by name; preserves first-seen order otherwise.
  const byName = new Map<string, SkillConfig>();
  const reservedNames = new Set(options.reservedNames ?? []);
  for (const skill of skills) {
    if (skill.enabled && !reservedNames.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }

  const refs: Skill[] = [];
  for (const skill of byName.values()) {
    try {
      refs.push(
        defineSkill({
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
        }),
      );
    } catch (err) {
      if (err instanceof SkillDefinitionValidationError) {
        // Skip the invalid row; the rest of the turn proceeds normally.
        continue;
      }
      throw err;
    }
  }
  return refs;
}
