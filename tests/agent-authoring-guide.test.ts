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
  assert.match(AGENT_AUTHORING_PACKAGE.skill.description, /Explore, create, onboard, or edit/i);
  assert.match(AGENT_AUTHORING_PACKAGE.skill.description, /Required before answering/i);
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
    'scheduled work',
    'without asking for separate permission',
    'inspect_workspace',
    'do not answer from general knowledge or defer inspection',
    'before calling any configuration mutation tool',
    'remember or edit Agent memory',
    'compound request as one Agent-authoring request',
  ]) assert.match(AGENT_AUTHORING_ROUTER_INSTRUCTION, new RegExp(phrase, 'i'));
  assert.doesNotMatch(AGENT_AUTHORING_ROUTER_INSTRUCTION, /chief of staff|Sentry|bug-to-PR/i);
});

test('guide encodes posture, placement, blueprint, inspection, and proportional approval', () => {
  for (const phrase of [
    '`commit`', '`explore`', '`capability_question`', '`clarify`',
    'instructions', 'skills', 'memory', 'connections', 'repositories', 'schedules',
    'All natural-language requests to create, edit, inspect, run, clone, pause, resume, disable, reassign, or delete scheduled work are Agent authoring',
    'Check this again in 5 minutes and tell me anything new',
    'does not need to say schedule',
    '`post_on_change` because “anything new” supplies the empty-result behavior',
    '`apply_workspace_changes` immediately without a proposal or approval round trip',
    'Slack presence', 'Channel reach', 'editing authority',
    'inspect_workspace', 'propose_workspace_changes', 'confirm_workspace_change',
    'opaque control token', 'Preserve it byte-for-byte', 'never retype',
    '`presentation.slack` value verbatim', 'before and after details that fit in Slack',
    'Confirmation applies the full frozen proposal',
    'visible plain-language final text', 'Do not end on a tool call',
    'inspection is mandatory in that turn', 'do not offer to inspect later',
    'channels\\[\\]\\.grants\\[\\]\\.revision', 'Never substitute the parent Channel revision',
    'reuse that destination', 'do not add `put_channel`', 'already-satisfied destination',
    'one-to-one Chickpea DM', 'trusted Slack origin', 'current_dm_thread',
    '`reassign_routine_agent`', 'Group DMs cannot contain scheduled work',
    'All requests to remember or edit durable Agent memory are Agent authoring',
    '`update_agent_memory`', 'exact `expectedRevision`',
    '`request_chickpea_handoff`', 'mention `@Chickpea`',
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
  assert.doesNotMatch(chickpeaSlackBody, /remember_memory|autonomousMemoryRequest/);
  assert.doesNotMatch(routineSource, /useAgentAuthoring/);
  assert.doesNotMatch(slackSource.slice(slackSource.indexOf('export function useRuntimePlanAgent')),
    /useAgentAuthoring|remember_memory|autonomousMemoryRequest/);
});

test('a frozen bash plan still rechecks live Agent execution authority', async () => {
  const slackSource = await readFile(
    new URL('../src/agents/slack-thread.ts', import.meta.url),
    'utf8',
  );
  const sandboxFactory = slackSource.slice(
    slackSource.indexOf('function createRuntimePlanSandbox'),
    slackSource.indexOf('function projectRuntimePlanAgent'),
  );
  const bashBranch = sandboxFactory.slice(
    sandboxFactory.indexOf("if (plan.sandbox.mode === 'bash')"),
    sandboxFactory.indexOf("  return {\n    async createSessionEnv({ id })"),
  );
  const modelPreparation = sandboxFactory.slice(
    sandboxFactory.indexOf('async function prepareRuntimePlanModel'),
  );
  assert.match(bashBranch, /await prepareRuntimePlanModel\(plan, env\)/);
  assert.match(modelPreparation, /requireLiveFrozenAgent\(getConfigStore\(env\), plan\.agentId\)/);
  assert.match(modelPreparation, /revalidateModelCredentialAttribution/);
  assert.match(modelPreparation, /const resolved = await resolveRuntimeModel\(plan\.agentId, plan\.model/);
  assert.ok(
    modelPreparation.indexOf('requireLiveFrozenAgent') < modelPreparation.indexOf('resolveRuntimeModel'),
    'Agent execution authority must be checked before model credential resolution.',
  );
});

test('conversational schedules cannot enter the exact Routine command lane', async () => {
  const [runTurnSource, commandSource] = await Promise.all([
    readFile(new URL('../src/slack/run-turn.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routines/commands.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(runTurnSource, /if \(shouldHandleRoutineCommandTurn\(turn, commandAddress\)\)/);
  assert.doesNotMatch(runTurnSource, /isRoutineIntentCandidate|parseRoutineIntent/);
  assert.doesNotMatch(commandSource, /isRoutineIntentCandidate|parseRoutineIntent|saveRoutineIntent/);
  const handler = commandSource.slice(commandSource.indexOf('export async function handleRoutineSlackRequest'));
  assert.ok(handler.indexOf('if (!command) return undefined') < handler.indexOf('const activeActor'));
});

test('behavioral evaluation corpus is versioned, synthetic, and guide-bound', async () => {
  const corpus = JSON.parse(await readFile(
    new URL('../evals/agent-authoring/cases.json', import.meta.url),
    'utf8',
  )) as {
    schemaVersion: number;
    corpusVersion: string;
    guideVersion: string;
    baseline: { id: string };
    cases: Array<{
      id: string;
      prompt: string;
      expected: Record<string, unknown> & {
        assertions: string[];
        criticalAssertions: string[];
      };
    }>;
  };

  assert.equal(corpus.schemaVersion, 1);
  assert.match(corpus.corpusVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(corpus.guideVersion, AGENT_AUTHORING_GUIDE_VERSION);
  assert.equal(corpus.baseline.id, 'no-guide-v1');
  assert.ok(corpus.cases.length >= 12);
  assert.equal(new Set(corpus.cases.map(({ id }) => id)).size, corpus.cases.length);
  for (const entry of corpus.cases) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.ok(entry.prompt.length >= 20);
    for (const field of [
      'activation', 'skillCreation', 'posture', 'placements', 'requiredInspections',
      'toolClass', 'mutationAllowance', 'approvalPosture', 'assertions', 'criticalAssertions',
    ]) assert.ok(Object.hasOwn(entry.expected, field), `${entry.id} is missing ${field}`);
    for (const critical of entry.expected.criticalAssertions) {
      assert.ok(entry.expected.assertions.includes(critical));
    }
  }

  const prompts = corpus.cases.map(({ prompt }) => prompt).join('\n');
  assert.doesNotMatch(prompts, /northstar|PRIVATE_|T_PRIVATE|C_PRIVATE/i);
});

test('the deployed MCP verifier stays pinned to the canonical guide version', async () => {
  const verifierSource = await readFile(
    new URL('../scripts/verify-management-mcp.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(verifierSource.includes(
    `const AGENT_AUTHORING_GUIDE_VERSION = '${AGENT_AUTHORING_GUIDE_VERSION}';`,
  ));
});
