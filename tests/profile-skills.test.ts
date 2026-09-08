import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveProfileSkills } from '../src/config/profile-skills.ts';
import type { SkillConfig } from '../src/config/types.ts';

function skill(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    name: 'incident-scribe',
    description: 'Build a structured incident timeline from a thread.',
    instructions: '# Incident Scribe\n\nDo the thing.',
    enabled: true,
    ...overrides,
  };
}

test('resolveProfileSkills returns [] for empty/undefined', () => {
  assert.deepEqual(resolveProfileSkills(undefined), []);
  assert.deepEqual(resolveProfileSkills([]), []);
});

test('resolveProfileSkills materializes enabled skills as SkillReferences', () => {
  const refs = resolveProfileSkills([
    skill({ name: 'incident-scribe' }),
    skill({ name: 'standup-summarizer' }),
  ]);
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((r) => r.name),
    ['incident-scribe', 'standup-summarizer'],
  );
});

test('resolveProfileSkills excludes disabled skills', () => {
  const refs = resolveProfileSkills([
    skill({ name: 'incident-scribe', enabled: true }),
    skill({ name: 'standup-summarizer', enabled: false }),
  ]);
  assert.deepEqual(
    refs.map((r) => r.name),
    ['incident-scribe'],
  );
});

test('resolveProfileSkills dedupes by name (last-writer-wins) so a dup can never kill the turn', () => {
  const refs = resolveProfileSkills([
    skill({ name: 'incident-scribe', description: 'first' }),
    skill({ name: 'incident-scribe', description: 'second' }),
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.name, 'incident-scribe');
  assert.equal(refs[0]?.description, 'second');
});

test('resolveProfileSkills skips an invalid row instead of throwing', () => {
  const refs = resolveProfileSkills([
    skill({ name: 'valid-skill' }),
    // Invalid name — defineSkill throws SkillDefinitionValidationError, which
    // must be swallowed per-row so the good skill still loads.
    skill({ name: 'Invalid Name!' }),
  ]);
  assert.deepEqual(
    refs.map((r) => r.name),
    ['valid-skill'],
  );
});

test('resolveProfileSkills skips names reserved by product-owned skills', () => {
  const refs = resolveProfileSkills([
    skill({ name: 'agent-authoring' }),
    skill({ name: 'incident-scribe' }),
  ], { reservedNames: ['agent-authoring'] });
  assert.deepEqual(refs.map((ref) => ref.name), ['incident-scribe']);
});
