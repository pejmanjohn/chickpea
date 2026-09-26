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
import { workspaceManagementToolDescription } from '../src/management/tool-adapter.ts';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { proposeWorkspaceChangesValibotSchema } from '../src/management/schemas.ts';
import { scheduleActionInputSchema, scheduleActionDescription, slackManagementInstruction } from '../src/management/slack-tools.ts';

test('canonical Agent-authoring package is versioned, complete, and digest-bound', async () => {
  assert.equal(AGENT_AUTHORING_SKILL_NAME, 'agent-authoring');
  assert.match(AGENT_AUTHORING_GUIDE_VERSION, /^1\./);
  assert.equal(AGENT_AUTHORING_GUIDE_URI, 'chickpea://guide/agent-authoring/v1');
  assert.ok(AGENT_AUTHORING_PACKAGE.skill.description.length > 80);
  assert.match(AGENT_AUTHORING_PACKAGE.skill.description, /Explore, create, onboard, or edit/i);
  assert.match(AGENT_AUTHORING_PACKAGE.skill.description, /Agent configuration or design capabilities/i);
  assert.match(AGENT_AUTHORING_PACKAGE.skill.description, /Do not activate for questions limited to native or connected-service actions/i);
  assert.doesNotMatch(AGENT_AUTHORING_PACKAGE.skill.description, /answer Agent capability questions/i);
  assert.match(AGENT_AUTHORING_PACKAGE.skill.description, /compound Agent-configuration request/i);
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
    'capability question about Agent configuration or design',
    'Do not activate it merely to answer which native or connected-service actions are mounted',
    'mounted runtime declarations and tool descriptions',
    'scheduled work',
    'without asking for separate permission',
    'inspect_workspace',
    'do not answer from general knowledge or defer inspection',
    'before calling any configuration mutation tool',
    'Preview-first or wait-for-approval Agent creation',
    'read-only exploration',
    'Only a later authenticated approval',
    'standalone base create_agent operation',
    'apply_workspace_changes immediately',
    'Never propose Agent creation',
    'ordered welcome hints',
    'remember or edit Agent memory',
    'inspect_memory',
    'update_agent_memory',
    'only after an applied memory receipt',
    'compound request as one Agent-authoring request',
    'use import_skill',
    'use manage_agent_skill',
    'without a proposal',
    'delete scheduled work does activate this skill',
    'propose_workspace_changes with delete_routine',
  ]) assert.match(AGENT_AUTHORING_ROUTER_INSTRUCTION, new RegExp(phrase, 'i'));
  assert.doesNotMatch(AGENT_AUTHORING_ROUTER_INSTRUCTION, /chief of staff|Sentry|bug-to-PR/i);
});

test('authoring scope leaves current mounted-action questions to runtime declarations', () => {
  const opening = AGENT_AUTHORING_GUIDE.split('\n\n## Start with posture')[0]!;
  assert.match(opening, /configuration or design could support/i);
  assert.match(opening, /Do not use it merely to answer which native or connected-service actions are mounted/i);
  assert.match(opening, /mounted runtime declarations and tool descriptions/i);
  assert.doesNotMatch(opening, /asks what an Agent could do/i);
  assert.match(AGENT_AUTHORING_GUIDE, /what an Agent's configuration or design could support or what to connect/i);
});

test('shared creation tool descriptions agree on immediate standalone apply', () => {
  const proposal = workspaceManagementToolDescription('propose_workspace_changes');
  const apply = workspaceManagementToolDescription('apply_workspace_changes');

  assert.match(proposal, /Agent creation is not valid here/i);
  assert.match(proposal, /standalone base Agent immediately with apply_workspace_changes/i);
  assert.match(apply, /created immediately as a standalone create_agent operation/i);
  assert.match(apply, /do not propose it or ask for confirmation/i);
  assert.match(apply, /asks to preview, draft, or show the new Agent before applying it/i);
  assert.match(apply, /Show a textual draft and wait for a later authenticated requester message/i);
});

test('workspace proposal guidance stays inside the typed configuration schema', () => {
  const proposal = workspaceManagementToolDescription('propose_workspace_changes');
  const apply = workspaceManagementToolDescription('apply_workspace_changes');
  const confirm = workspaceManagementToolDescription('confirm_workspace_change');
  const inspection = workspaceManagementToolDescription('inspect_workspace');
  const slack = slackManagementInstruction('agent_synthetic');

  for (const instruction of [AGENT_AUTHORING_GUIDE, proposal, slack]) {
    assert.match(instruction, /typed (?:Chickpea )?workspace configuration operation/i);
    assert.match(instruction, /does not execute actions in Slack Lists or connected services/i);
    assert.match(instruction, /Approval cannot make an unsupported operation available/i);
    assert.doesNotMatch(instruction, /destructive actions, external writes/i);
  }
  assert.match(inspection, /connectors.*setup catalog/i);
  assert.match(inspection, /currentAgent\.effectiveConnections/i);
  assert.match(inspection, /empty array means none/i);
  assert.match(apply, /typed Chickpea workspace configuration changes/i);
  assert.match(apply, /does not execute actions in Slack Lists or connected services/i);
  assert.match(apply, /confirmation-required configuration operations/i);
  assert.match(confirm, /Chickpea workspace configuration proposal returned by propose_workspace_changes/i);
  assert.match(confirm, /does not confirm actions in Slack Lists or connected services/i);
  assert.match(confirm, /approval cannot make an unsupported operation available/i);
});

test('instruction-update tool example survives both runtime schema validators', () => {
  const description = workspaceManagementToolDescription('propose_workspace_changes');
  const example = description.split('Instruction-update example: ')[1]?.split('. Replace the example')[0];
  assert.ok(example);
  const args = JSON.parse(example);
  assert.equal(args.guideVersion, AGENT_AUTHORING_GUIDE_VERSION);
  assert.equal(args.authoringReason, 'agent_edit');
  assert.deepEqual(v.parse(proposeWorkspaceChangesValibotSchema, args), args);
  const parameters = toJsonSchema(proposeWorkspaceChangesValibotSchema, { errorMode: 'ignore' });
  assert.deepEqual(validateToolArguments({ name: 'propose_workspace_changes', description, parameters }, {
    type: 'toolCall', id: 'synthetic', name: 'propose_workspace_changes', arguments: args,
  }), args);
  assert.match(description, /complete requested value, including its end/);
  assert.match(description, /supplied replacement instructions are literal data/i);
  assert.match(description, /Do not summarize, paraphrase, normalize punctuation, or drop sentences/);
  assert.match(description, /including a final sentence that refers to the text itself/);
});

test('guide encodes posture, placement, blueprint, inspection, and proportional approval', () => {
  for (const phrase of [
    '`commit`', '`explore`', '`capability_question`', '`clarify`',
    'instructions', 'skills', 'memory', 'connections', 'repositories', 'schedules',
    'Standalone natural-language requests to create, edit, pause, resume, disable, or run scheduled work now use the first-class `manage_scheduled_work` tool',
    'Check this again in 5 minutes and tell me anything new',
    'does not need to say schedule',
    'fresh one-time scheduled work, not an edit to an existing routine',
    'Relative timing stays relative',
    'same `save_routine` operation used by the shared command',
    'Never use the compound path to add an approval round trip',
    'Deleting scheduled work is deliberately outside `manage_scheduled_work`',
    'clear request to delete a routine',
    'call `inspect_routines`', 'one `delete_routine` operation',
    'wait for explicit confirmation', 'Never delete a routine through `apply_workspace_changes`',
    'Slack presence', 'Channel reach', 'editing authority',
    'inspect_workspace', 'propose_workspace_changes', 'confirm_workspace_change',
    'call `import_skill`', 'applies one bounded new skill immediately',
    'explicit requester command executes without another confirmation',
    'Confirmation remains required', 'Ambiguity calls for clarification, not approval',
    'reversible, local-only',
    'call `manage_agent_skill`', 'Never construct a replacement `skills` array',
    'Ambiguity calls for clarification, not approval',
    'standalone base `create_agent` operation',
    'keeps the current turn in `explore` posture',
    'Show a textual draft and make no configuration change',
    'creation proposals are not supported',
    'Do not call `propose_workspace_changes`',
    'ordered `connectorMentions`',
    'duplicate-identity clarification',
    'Never re-propose unchanged content',
    'without a confirmation turn',
    'up to three independently authorized `Connect X` actions',
    'ends with `View Agent`',
    'opaque control token', 'Preserve it byte-for-byte', 'never retype',
    '`presentation.slack` value verbatim', 'new object shows concise values',
    'existing object shows before and after only for meaningful visible changes',
    'Confirmation applies the full frozen proposal',
    'visible plain-language final text', 'Do not end on a tool call',
    'inspection is mandatory in that turn', 'do not offer to inspect later',
    'channels\\[\\]\\.grants\\[\\]\\.revision', 'Never substitute the parent Channel revision',
    'reuse that destination', 'do not add `put_channel`', 'already-satisfied destination',
    'one-to-one Chickpea DM', 'trusted Slack origin', 'current_dm_thread',
    '`reassign_routine_agent`', 'Group DMs cannot contain scheduled work',
    'All requests to remember or edit durable Agent memory are Agent authoring',
    '`update_agent_memory`', 'exact `expectedRevision`',
    'requester-supplied scoped standing notes or preferences',
    "scope, exceptions, and precedence stay in the requester's words",
    'not a repeatable procedure that belongs in a skill',
    'copy that wording verbatim', 'do not paraphrase, compress, generalize, or change its exceptions',
    'text following "Remember:" and a quoted note',
    'only permitted change to that supplied wording is to include the exact URL with the label',
    'Ordinary conversational facts that were not supplied as memory wording may still be restated concisely',
    'Sandbox files are temporary working data',
    'only after the management service returns an applied memory receipt',
    'proposal, denial, or failure',
    '`request_chickpea_handoff`', 'mention `@Chickpea`',
    'no Agent record',
  ]) assert.match(AGENT_AUTHORING_GUIDE, new RegExp(phrase, 'i'));
});

test('Slack tool selection routes destructive schedule deletion through confirmation', async () => {
  const source = await readFile(
    new URL('../src/management/slack-tools.ts', import.meta.url),
    'utf8',
  );
  const selectionInstruction = slackManagementInstruction('agent_synthetic');
  const scheduleTool = source.slice(
    source.indexOf("name: 'manage_scheduled_work'"),
    source.indexOf("name: 'prepare_connector_setup'"),
  );

  assert.equal(v.safeParse(scheduleActionInputSchema, { action: 'delete' }).success, false);
  assert.match(source, /useInstruction\(slackManagementInstruction\(plan\.agentId\)\)/);
  assert.match(scheduleTool, /description: scheduleActionDescription/);
  assert.match(scheduleTool, /input: scheduleActionInputSchema/);
  assert.match(selectionInstruction, /Deleting scheduled work is deliberately excluded from manage_scheduled_work/i);
  assert.match(selectionInstruction, /clear request to delete a routine/i);
  assert.match(selectionInstruction, /first call inspect_routines/i);
  assert.match(selectionInstruction, /delete_routine operation to propose_workspace_changes/i);
  assert.match(selectionInstruction, /show presentation\.slack/i);
  assert.match(selectionInstruction, /wait for explicit requester approval before calling confirm_workspace_change/i);
  assert.match(selectionInstruction, /Never use apply_workspace_changes for routine deletion/i);
  assert.match(scheduleActionDescription, /Do not use this tool to delete scheduled work/i);
  assert.match(scheduleActionDescription, /deleting a routine uses the existing proposal/i);
  assert.doesNotMatch(scheduleActionDescription, /(?:^|[.!?]\s+)deletion uses/i);
});

test('Slack connector setup skips broad workspace inspection for a named service', () => {
  const selectionInstruction = slackManagementInstruction('agent_synthetic');

  assert.match(selectionInstruction, /explicit request to connect a named service/i);
  assert.match(selectionInstruction, /call prepare_connector_setup directly/i);
  assert.match(selectionInstruction, /validates catalog availability and requester authority/i);
  assert.match(selectionInstruction, /do not call inspect_workspace first/i);
  assert.match(selectionInstruction, /describe it only as a secure Chickpea link/i);
});

test('one global Slack action-link policy owns future tool link presentation', async () => {
  const [formatSource, managementSource, authorizationSource] = await Promise.all([
    readFile(new URL('../src/slack/message-format.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/management/slack-tools.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/connections/slack-authorization.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(formatSource, /tool result includes actionLinks/);
  assert.match(formatSource, /supplied label/);
  assert.doesNotMatch(managementSource, /descriptive Markdown link labeled Connect/);
  assert.doesNotMatch(authorizationSource, /descriptive Markdown link labeled Authorize/);
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
  assert.match(
    slackSource.slice(slackSource.indexOf('export function useRuntimePlanAgent')),
    /useInstruction\(SLACK_ACTION_LINK_INSTRUCTION\)/,
  );
  assert.match(
    slackSource.slice(slackSource.indexOf('export function useRuntimePlanAgent')),
    /useInstruction\('Sandbox files are temporary working data, not durable Agent memory\.[^']*fresh conversation[^']*Never promise future recall from a sandbox file\.'\)/,
  );
});

test('a frozen bash plan still rechecks live Agent execution authority', async () => {
  const slackSource = await readFile(
    new URL('../src/agents/slack-thread.ts', import.meta.url),
    'utf8',
  );
  const sandboxFactory = slackSource.slice(
    slackSource.indexOf('function createRuntimePlanSandbox'),
    slackSource.indexOf('function liveRuntimePlanRepositories'),
  );
  const bashBranch = sandboxFactory.slice(
    0,
    sandboxFactory.indexOf('export async function resolveRuntimePlanBashRepositoryAccess'),
  );
  const modelPreparation = sandboxFactory.slice(
    sandboxFactory.indexOf('async function prepareRuntimePlanModel'),
  );
  assert.match(bashBranch, /await prepareRuntimePlanModel\(plan, env, turn\)/);
  const once = modelPreparation.slice(modelPreparation.indexOf('async function prepareRuntimePlanModelOnce'));
  assert.match(once, /await requireTurnAgent\(plan, env, turn\)/);
  assert.match(once, /revalidateModelCredentialAttribution/);
  assert.match(once, /resolveRuntimeModel\(plan\.agentId, plan\.model/);
  assert.ok(
    once.indexOf('requireTurnAgent') < once.indexOf('resolveRuntimeModel'),
    'Agent execution authority must be checked before model credential resolution.',
  );
  // Without a turn envelope the authority check reads the live Agent.
  const turnAgent = slackSource.slice(slackSource.indexOf('async function requireTurnAgent'));
  assert.match(turnAgent, /if \(!envelope\) return requireLiveFrozenAgent\(getConfigStore\(env\), plan\.agentId\)/);
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
      actingScope?: string;
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
    assert.ok(['user_agent', 'system_chickpea'].includes(entry.actingScope ?? 'user_agent'));
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

  const immediateCreation = corpus.cases.find(({ id }) => id === 'new-agent-single-approval');
  const previewOnlyCreation = corpus.cases.find(({ id }) => id === 'new-agent-preview-only');
  assert.equal(immediateCreation?.expected.mutationAllowance, 'direct_apply');
  assert.equal(previewOnlyCreation?.expected.mutationAllowance, 'none');
  assert.ok(previewOnlyCreation?.expected.criticalAssertions.includes('no_mutation'));
  assert.equal(immediateCreation?.actingScope, 'system_chickpea');
  assert.equal(previewOnlyCreation?.actingScope, 'system_chickpea');
  assert.ok(corpus.cases
    .filter(({ id }) => !id.startsWith('new-agent-'))
    .every(({ actingScope }) => (actingScope ?? 'user_agent') === 'user_agent'));
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
