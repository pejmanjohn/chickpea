import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  AGENT_AUTHORING_GUIDE,
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_URI,
  AGENT_AUTHORING_GUIDE_VERSION,
  AGENT_AUTHORING_PACKAGE,
  AGENT_AUTHORING_ROUTER_INSTRUCTION,
  AGENT_AUTHORING_SKILL_NAME,
  AGENT_SKILL_CREATION_GUIDE,
} from '../src/management/agent-authoring/index.ts';

test('canonical Agent-authoring package is versioned, complete, and digest-bound', async () => {
  assert.equal(AGENT_AUTHORING_SKILL_NAME, 'agent-authoring');
  assert.match(AGENT_AUTHORING_GUIDE_VERSION, /^1\./);
  assert.equal(AGENT_AUTHORING_GUIDE_URI, 'chickpea://guide/agent-authoring/v1');
  assert.ok(AGENT_AUTHORING_PACKAGE.skill.description.length > 80);
  assert.ok(AGENT_AUTHORING_GUIDE.length > 4_000);
  assert.ok(AGENT_SKILL_CREATION_GUIDE.length > 2_000);
  assert.ok(AGENT_AUTHORING_ROUTER_INSTRUCTION.length < AGENT_AUTHORING_GUIDE.length / 8);
  assert.equal(
    AGENT_AUTHORING_GUIDE_DIGEST,
    createHash('sha256')
      .update(`${AGENT_AUTHORING_GUIDE}\n---skill-creation---\n${AGENT_SKILL_CREATION_GUIDE}`)
      .digest('hex'),
  );
  assert.deepEqual(Object.keys(AGENT_AUTHORING_PACKAGE.skill.files ?? {}), [
    'skill-creation.md',
  ]);

  const [guideSource, skillCreationSource] = await Promise.all([
    readFile(new URL('../src/management/agent-authoring/guide.md', import.meta.url), 'utf8'),
    readFile(new URL('../src/management/agent-authoring/skill-creation.md', import.meta.url), 'utf8'),
  ]);
  assert.equal(guideSource.trimEnd(), AGENT_AUTHORING_GUIDE);
  assert.equal(skillCreationSource.trimEnd(), AGENT_SKILL_CREATION_GUIDE);
});

test('router covers all authoring postures while leaving detailed judgment lazy', () => {
  for (const phrase of [
    'create an Agent',
    'edit an Agent',
    'explore',
    'capability',
    'create or revise a skill',
  ]) assert.match(AGENT_AUTHORING_ROUTER_INSTRUCTION, new RegExp(phrase, 'i'));
  assert.doesNotMatch(AGENT_AUTHORING_ROUTER_INSTRUCTION, /chief of staff|Sentry|bug-to-PR/i);
});

test('guide encodes posture, placement, blueprint, inspection, and proportional approval', () => {
  for (const phrase of [
    '`commit`', '`explore`', '`capability_question`', '`clarify`',
    'instructions', 'skills', 'memory', 'connections', 'repositories', 'schedules',
    'Slack presence', 'Channel reach', 'editing authority',
    'inspect_workspace', 'propose_workspace_changes', 'confirm_workspace_change',
    'no Agent record', 'one highest-value next step',
  ]) assert.match(AGENT_AUTHORING_GUIDE, new RegExp(phrase, 'i'));
});

test('guide handles the three product examples without premature mutation', () => {
  assert.match(AGENT_AUTHORING_GUIDE, /chief.of.staff[\s\S]*explore/i);
  assert.match(AGENT_AUTHORING_GUIDE, /bug[\s\S]*pull request[\s\S]*skill/i);
  assert.match(AGENT_AUTHORING_GUIDE, /Sentry[\s\S]*timezone[\s\S]*empty-result/i);
  assert.match(AGENT_AUTHORING_GUIDE, /explore[\s\S]*must not mutate/i);
});

test('skill-creation reference targets inline Chickpea skills and evaluation boundaries', () => {
  for (const phrase of [
    'activation examples', 'false positive', 'false negative', 'name', 'description',
    'instructions', 'enabled', 'inline skill', 'research', 'proposal',
  ]) assert.match(AGENT_SKILL_CREATION_GUIDE, new RegExp(phrase, 'i'));
  assert.match(AGENT_SKILL_CREATION_GUIDE, /Do not create a skill merely because/i);
});

test('interactive Slack Agent mounts authoring while routine execution does not', async () => {
  const [slackSource, routineSource] = await Promise.all([
    readFile(new URL('../src/agents/slack-thread.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/agents/routine-execution.ts', import.meta.url), 'utf8'),
  ]);
  const chickpeaSlackBody = slackSource.slice(
    slackSource.indexOf('export function ChickpeaSlack'),
    slackSource.indexOf('/** Compose the declarations shared by Slack'),
  );
  assert.match(chickpeaSlackBody, /useAgentAuthoring\(\)/);
  assert.doesNotMatch(routineSource, /useAgentAuthoring/);
  assert.doesNotMatch(slackSource.slice(slackSource.indexOf('export function useRuntimePlanAgent')),
    /useAgentAuthoring/);
});
