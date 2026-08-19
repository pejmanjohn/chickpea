import assert from 'node:assert/strict';
import test from 'node:test';

import { defineSkill } from '@flue/runtime';

import {
  SUGGESTED_SKILL_CATEGORIES,
  SUGGESTED_SKILLS,
} from '../src/config/suggested-skills.ts';

test('suggested skill catalog has the approved size, featured set, and category counts', () => {
  assert.equal(SUGGESTED_SKILLS.length, 20);
  assert.deepEqual(
    SUGGESTED_SKILLS.filter((skill) => skill.featured).map((skill) => skill.id),
    [
      'paid-ads',
      'ad-creative',
      'performance-report',
      'copywriting',
      'internal-comms',
      'customer-research',
      'meeting-notes-and-actions',
      'unslop',
    ],
  );

  const expectedCounts = new Map([
    ['featured', 8],
    ['marketing', 7],
    ['writing', 5],
    ['research', 6],
    ['operations', 5],
    ['engineering', 4],
  ]);
  assert.deepEqual(
    SUGGESTED_SKILL_CATEGORIES.map((category) => {
      const categoryId = category.id;
      return [
        categoryId,
        categoryId === 'featured'
          ? SUGGESTED_SKILLS.filter((skill) => skill.featured).length
          : SUGGESTED_SKILLS.filter((skill) => skill.categories.includes(categoryId)).length,
      ];
    }),
    [...expectedCounts],
  );
});

test('suggested skills are unique, runtime-valid, attributed, and self-contained', () => {
  assert.equal(new Set(SUGGESTED_SKILLS.map((skill) => skill.id)).size, SUGGESTED_SKILLS.length);
  assert.equal(new Set(SUGGESTED_SKILLS.map((skill) => skill.name)).size, SUGGESTED_SKILLS.length);

  for (const skill of SUGGESTED_SKILLS) {
    assert.doesNotThrow(
      () => defineSkill({
        name: skill.name,
        description: skill.runtimeDescription,
        instructions: skill.instructions,
      }),
      skill.id,
    );
    assert.match(skill.sourceUrl, /^https:\/\/github\.com\//, skill.id);
    assert.ok(skill.instructions.length >= 300, `${skill.id} should be useful as a standalone snapshot`);
    assert.doesNotMatch(
      skill.instructions,
      /(?:CONNECTORS\.md|(?:references|scripts|assets)\/|Skill tool|sub-?agent|\.agents\/)/i,
      `${skill.id} should not depend on files or orchestration that Chickpea does not install`,
    );
  }
});

test('Grill me keeps the requested slash-command display name with a valid runtime name', () => {
  const grillMe = SUGGESTED_SKILLS.find((skill) => skill.id === 'grill-me');
  assert.ok(grillMe);
  assert.equal(grillMe.displaySlug, '/grill-me');
  assert.equal(grillMe.name, 'grill-me');
  assert.equal(grillMe.source, 'Matt Pocock');
  assert.equal(
    grillMe.sourceUrl,
    'https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md',
  );
  assert.match(grillMe.instructions, /^# Grill me$/m);
  assert.match(grillMe.instructions, /Do not execute the plan during the interview\./);
});
