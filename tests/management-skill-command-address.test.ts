import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import type { ParsedSkillSource } from '../src/config/skill-import.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import type { WorkspaceManagementToolArguments } from '../src/management/tool-adapter.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const BOT_USER_ID = 'UCHICKPEA1';
const SPROUT_GROUP_ID = 'SSPROUT1';
const OTHER_GROUP_ID = 'SOTHER1';
const PERSON_USER_ID = 'UPERSON1';
const UPSTREAM_SOURCE =
  'https://github.com/acme/skills/tree/2222222222222222222222222222222222222222/skills/unslop';

const ADDRESSED_HERE = [
  { label: 'no mention', prefix: '' },
  { label: "the Agent's handle", prefix: `<!subteam^${SPROUT_GROUP_ID}> ` },
  { label: "the Agent's labelled handle", prefix: `<!subteam^${SPROUT_GROUP_ID}|@sprout> ` },
  { label: "Chickpea's mention", prefix: `<@${BOT_USER_ID}> ` },
] as const;

const ADDRESSED_ELSEWHERE = [
  { label: "another Agent's handle", prefix: `<!subteam^${OTHER_GROUP_ID}> ` },
  { label: "a person's mention", prefix: `<@${PERSON_USER_ID}> ` },
] as const;

async function skillCommandFixture(suffix: string, runtimeContract: 'legacy' | 'chickpea-v1' = 'chickpea-v1') {
  const f = await createManagementAdapterFixture(suffix, {
    resolveSkillImport: async (source: ParsedSkillSource) => ({
      owner: source.owner,
      repo: source.repo,
      ref: '2222222222222222222222222222222222222222',
      source: { visibility: 'public', access: 'anonymous' },
      skills: [{
        name: 'unslop',
        description: 'New upstream description.',
        instructions: 'Use the new upstream procedure.',
        hasScripts: false,
        inspection: { complete: true, scriptPaths: [], auxiliaryPaths: [], unknownPaths: [], warnings: [] },
        path: 'skills/unslop',
        sourceUrl: UPSTREAM_SOURCE,
      }],
      total: 1,
      capped: false,
      skipped: 0,
    }),
  });
  const withHandle = async (id: string, name: string, userGroupId: string) => {
    const created = await f.config.createAgent({
      id,
      name,
      creatorMembershipId: f.admin.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: `Test ${name} skill commands.`,
      enabled: true,
      skills: [{
        name: 'unslop',
        description: 'Rewrite plainly.',
        instructions: 'Preserve this local procedure.',
        enabled: true,
      }, {
        name: 'keep-me',
        description: 'Keep this skill.',
        instructions: 'Remain installed.',
        enabled: true,
      }],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    return await f.config.updateAgent(created.id, {
      slackPresence: {
        ...created.slackPresence!,
        kind: 'user_group',
        desiredState: 'active',
        health: 'healthy',
        userGroupId,
      },
    }, created.revision);
  };
  const sprout = await withHandle('agent_skill_command_sprout', 'Sprout', SPROUT_GROUP_ID);
  await withHandle('agent_skill_command_other', 'Other', OTHER_GROUP_ID);
  // A legacy installation needs an active Agent before it exists.
  await f.config.ensureWorkspaceInstallation({
    workspaceId: f.admin.user.slackTeamId,
    transportMode: 'direct',
    teamId: f.admin.user.slackTeamId,
    appId: 'ACHICKPEA1',
    botUserId: BOT_USER_ID,
    runtimeContract,
  });
  let sequence = 0;
  const send = <TName extends 'manage_agent_skill' | 'undo_workspace_change' | 'import_skill'>(
    agentId: string,
    requesterText: string,
    name: TName,
    args: Omit<WorkspaceManagementToolArguments[TName], 'idempotencyKey'>,
  ) => {
    sequence += 1;
    const signal: SlackManagementSignal = {
      agentId,
      workspaceId: f.admin.user.slackTeamId,
      channelId: 'C_SKILL_COMMANDS',
      threadTs: '700.1',
      conversationKind: 'channel',
      slackUserId: f.admin.binding.slackUserId,
      eventId: `Ev_SKILL_COMMAND_${sequence}`,
      messageTs: `700.${sequence + 1}`,
      turnJobId: `turn_SKILL_COMMAND_${sequence}`,
      requesterText,
    };
    return invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name,
      args: {
        ...args,
        idempotencyKey: `skill-command-${sequence}`,
      } as WorkspaceManagementToolArguments[TName],
    });
  };
  const skills = async () =>
    (await f.config.getAgent(sprout.id)).skills.map(({ name, enabled, instructions }) =>
      ({ name, enabled, instructions }));
  return { f, sprout, send, skills };
}

const ORIGINAL_SKILLS = [
  { name: 'unslop', enabled: true, instructions: 'Preserve this local procedure.' },
  { name: 'keep-me', enabled: true, instructions: 'Remain installed.' },
];

test('a skill command addressed to the routed Agent or Chickpea changes the skill', async () => {
  const { f, sprout, send, skills } = await skillCommandFixture('skill-command-addressed');
  try {
    for (const { label, prefix } of ADDRESSED_HERE) {
      const disabled = await send(sprout.id, `${prefix}disable the unslop skill`,
        'manage_agent_skill', { action: 'disable', skillName: 'unslop' });
      assert.equal(disabled.ok, true, `disable after ${label}`);
      assert.equal((await skills())[0]!.enabled, false, `disable after ${label}`);

      const enabled = await send(sprout.id, `${prefix}enable the unslop skill`,
        'manage_agent_skill', { action: 'enable', skillName: 'unslop' });
      assert.equal(enabled.ok, true, `enable after ${label}`);
      assert.equal((await skills())[0]!.enabled, true, `enable after ${label}`);

      const removed = await send(sprout.id, `${prefix}remove the unslop skill`,
        'manage_agent_skill', { action: 'remove', skillName: 'unslop' });
      assert.equal(removed.ok, true, `remove after ${label}`);
      assert.deepEqual((await skills()).map(({ name }) => name), ['keep-me'], `remove after ${label}`);

      const operationId = (removed as { ok: true; result: { operationId: string } }).result.operationId;
      const undone = await send(sprout.id, `${prefix}undo`,
        'undo_workspace_change', { operationId });
      assert.equal(undone.ok, true, `undo after ${label}`);
      assert.equal((undone as { ok: true; result: { status: string } }).result.status, 'completed',
        `undo after ${label}`);
      assert.deepEqual(await skills(), ORIGINAL_SKILLS, `undo after ${label}`);

      const replaced = await send(sprout.id, `${prefix}replace unslop from <${UPSTREAM_SOURCE}|unslop>`,
        'import_skill', {
          source: UPSTREAM_SOURCE,
          replaceExisting: true,
          guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
        });
      assert.equal(replaced.ok, true, `replace after ${label}`);
      assert.equal((await skills())[0]!.instructions, 'Use the new upstream procedure.',
        `replace after ${label}`);
      const current = await f.config.getAgent(sprout.id);
      await f.config.updateAgent(sprout.id, {
        skills: current.skills.map((skill) => skill.name === 'unslop'
          ? { name: 'unslop', description: 'Rewrite plainly.', instructions: 'Preserve this local procedure.', enabled: true }
          : skill),
      }, current.revision);
    }

    const fromChickpea = await send(CHICKPEA_AGENT_ID,
      `<@${BOT_USER_ID}> remove the unslop skill from Sprout`,
      'manage_agent_skill', { agentId: sprout.id, action: 'remove', skillName: 'unslop' });
    assert.equal(fromChickpea.ok, true, 'Chickpea route with its own mention');
    assert.deepEqual((await skills()).map(({ name }) => name), ['keep-me']);
  } finally {
    f.close();
  }
});

test('a skill command addressed to another Agent or a person changes nothing', async () => {
  const { f, sprout, send, skills } = await skillCommandFixture('skill-command-elsewhere');
  try {
    const removed = await send(sprout.id, 'remove the unslop skill',
      'manage_agent_skill', { action: 'remove', skillName: 'unslop' });
    assert.equal(removed.ok, true);
    const operationId = (removed as { ok: true; result: { operationId: string } }).result.operationId;
    const removedSkills = await skills();
    assert.deepEqual(removedSkills.map(({ name }) => name), ['keep-me']);

    for (const { label, prefix } of ADDRESSED_ELSEWHERE) {
      const undo = await send(sprout.id, `${prefix}undo`, 'undo_workspace_change', { operationId });
      assert.equal(undo.ok, true, `undo after ${label}`);
      assert.equal((undo as { ok: true; result: { status: string } }).result.status,
        'confirmation_required', `undo after ${label}`);
      assert.deepEqual(await skills(), removedSkills, `undo after ${label}`);

      for (const action of ['disable', 'remove'] as const) {
        const refused = await send(sprout.id, `${prefix}${action} the keep-me skill`,
          'manage_agent_skill', { action, skillName: 'keep-me' });
        assert.equal(refused.ok, false, `${action} after ${label}`);
        assert.match((refused as { ok: false; error: { message: string } }).error.message,
          new RegExp(`must explicitly ${action} the keep-me skill`), `${action} after ${label}`);
        assert.deepEqual(await skills(), removedSkills, `${action} after ${label}`);
      }

      const fromChickpea = await send(CHICKPEA_AGENT_ID, `${prefix}remove the keep-me skill from Sprout`,
        'manage_agent_skill', { agentId: sprout.id, action: 'remove', skillName: 'keep-me' });
      assert.equal(fromChickpea.ok, false, `Chickpea route after ${label}`);
      assert.deepEqual(await skills(), removedSkills, `Chickpea route after ${label}`);
    }

    const current = await f.config.getAgent(sprout.id);
    await f.config.updateAgent(sprout.id, {
      skills: current.skills.map((skill) => ({ ...skill, enabled: false })),
    }, current.revision);
    for (const { label, prefix } of ADDRESSED_ELSEWHERE) {
      const refused = await send(sprout.id, `${prefix}enable the keep-me skill`,
        'manage_agent_skill', { action: 'enable', skillName: 'keep-me' });
      assert.equal(refused.ok, false, `enable after ${label}`);
      assert.equal((await skills())[0]!.enabled, false, `enable after ${label}`);
    }
  } finally {
    f.close();
  }
});

test('replace and undo count only in a message addressed to this Agent', async () => {
  const { f, sprout, send, skills } = await skillCommandFixture('skill-command-replace-undo-elsewhere');
  try {
    const removed = await send(sprout.id, 'remove the unslop skill',
      'manage_agent_skill', { action: 'remove', skillName: 'unslop' });
    assert.equal(removed.ok, true);
    const operationId = (removed as { ok: true; result: { operationId: string } }).result.operationId;
    const removedSkills = await skills();

    for (const words of [
      `<@${PERSON_USER_ID}>, undo`,
      `<!subteam^${OTHER_GROUP_ID}>, undo`,
      `thanks <@${PERSON_USER_ID}>, undo`,
    ]) {
      const undo = await send(sprout.id, words, 'undo_workspace_change', { operationId });
      assert.equal(undo.ok, true, words);
      assert.equal((undo as { ok: true; result: { status: string } }).result.status,
        'confirmation_required', words);
      assert.deepEqual(await skills(), removedSkills, words);
    }
    const undone = await send(sprout.id, 'undo', 'undo_workspace_change', { operationId });
    assert.equal((undone as { ok: true; result: { status: string } }).result.status, 'completed');
    assert.deepEqual(await skills(), ORIGINAL_SKILLS);

    const replace = (words: string) => send(sprout.id, words, 'import_skill', {
      source: UPSTREAM_SOURCE,
      replaceExisting: true,
      guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    });
    const command = `replace unslop from <${UPSTREAM_SOURCE}|unslop>`;
    for (const words of [
      `<!subteam^${OTHER_GROUP_ID}> ${command}`,
      `<@${PERSON_USER_ID}> ${command}`,
      `fyi <@${PERSON_USER_ID}> ${command}`,
    ]) {
      const refused = await replace(words);
      assert.equal(refused.ok, false, words);
      assert.match((refused as { ok: false; error: { message: string } }).error.message,
        /Replacement needs a new requester message/, words);
      assert.deepEqual(await skills(), ORIGINAL_SKILLS, words);
    }
    assert.equal((await replace(command)).ok, true);
    assert.equal((await skills())[0]!.instructions, 'Use the new upstream procedure.');
  } finally {
    f.close();
  }
});

test('an installation on the legacy runtime reads the same address', async () => {
  const { f, sprout, send, skills } = await skillCommandFixture('skill-command-legacy', 'legacy');
  try {
    for (const { label, prefix } of ADDRESSED_HERE) {
      const removed = await send(sprout.id, `${prefix}remove the unslop skill`,
        'manage_agent_skill', { action: 'remove', skillName: 'unslop' });
      assert.equal(removed.ok, true, `remove after ${label}`);
      const operationId = (removed as { ok: true; result: { operationId: string } }).result.operationId;
      const undone = await send(sprout.id, `${prefix}undo`, 'undo_workspace_change', { operationId });
      assert.equal((undone as { ok: true; result: { status: string } }).result.status, 'completed',
        `undo after ${label}`);
      assert.deepEqual(await skills(), ORIGINAL_SKILLS, `undo after ${label}`);
    }
  } finally {
    f.close();
  }
});

test('from Chickpea, a skill command must name the Agent it changes', async () => {
  const { f, sprout, send, skills } = await skillCommandFixture('skill-command-chickpea-target');
  try {
    const unnamed = await send(CHICKPEA_AGENT_ID, `<@${BOT_USER_ID}> remove the unslop skill`,
      'manage_agent_skill', { agentId: sprout.id, action: 'remove', skillName: 'unslop' });
    assert.equal(unnamed.ok, false);
    assert.deepEqual(await skills(), ORIGINAL_SKILLS);
  } finally {
    f.close();
  }
});
