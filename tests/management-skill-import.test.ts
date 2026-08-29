import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParsedSkillSource, SkillResolution } from '../src/config/skill-import.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import { executeHostSlackManagementApproval } from '../src/management/slack-approval.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

function resolution(
  source: ParsedSkillSource,
  skills: SkillResolution['skills'],
): SkillResolution {
  return {
    owner: source.owner,
    repo: source.repo,
    ref: source.ref ?? 'main',
    source: { visibility: 'public', access: 'anonymous' },
    skills,
    total: skills.length,
    capped: false,
    skipped: 0,
  };
}

test('Slack can freeze one exact GitHub skill into the normal approval proposal', async () => {
  let resolvedSource: ParsedSkillSource | undefined;
  const f = await createManagementAdapterFixture('slack-skill-import', {
    resolveSkillImport: async (source) => {
      resolvedSource = source;
      return resolution(source, [{
        name: 'unslop',
        description: 'Remove AI writing tells from prose.',
        instructions: 'Rewrite the draft plainly and preserve its meaning.',
        hasScripts: false,
        path: 'pstack/skills/unslop',
        sourceUrl: 'https://github.com/cursor/plugins/tree/main/pstack/skills/unslop',
      }]);
    },
  });
  const agent = await f.config.createAgent({
    id: 'agent_sprout',
    name: 'Sprout',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Help with focused product work.',
    enabled: true,
    skills: [{
      name: 'existing-skill',
      description: 'Keep this skill.',
      instructions: 'Keep working as before.',
      enabled: true,
    }],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const signal = {
    agentId: agent.id,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_SKILL_IMPORT',
    threadTs: '100.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_SKILL_IMPORT',
    messageTs: '100.2',
    turnJobId: 'turn_SKILL_IMPORT',
  };
  try {
    const proposed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'propose_skill_import',
      args: {
        source: 'https://github.com/cursor/plugins/tree/main/pstack/skills/unslop',
        idempotencyKey: 'import-unslop',
        guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
      },
    });
    assert.equal(proposed.ok, true);
    assert.deepEqual(resolvedSource, {
      owner: 'cursor',
      repo: 'plugins',
      ref: 'main',
      skillPath: 'pstack/skills/unslop',
    });
    const result = (proposed as { ok: true; result: {
      proposalId: string;
      status: string;
      presentation: { slack: string };
      import: { name: string; replacedExisting: boolean };
    } }).result;
    assert.equal(result.status, 'pending');
    assert.equal(result.import.name, 'unslop');
    assert.equal(result.import.replacedExisting, false);
    assert.equal('preview' in result, false);
    assert.match(result.presentation.slack, /unslop/i);
    assert.match(result.presentation.slack, /Reply `approve`/);
    assert.deepEqual((await f.config.getAgent(agent.id)).skills.map(({ name }) => name), [
      'existing-skill',
    ]);

    const approval = await executeHostSlackManagementApproval({
      turn: {
        workspaceId: signal.workspaceId,
        channelId: signal.channelId,
        channelType: 'im',
        eventId: 'Ev_SKILL_IMPORT_APPROVE',
        text: 'approve',
        userId: signal.slackUserId,
        messageTs: '100.3',
        threadTs: signal.threadTs,
        source: 'dm_message',
        contextMode: 'thread',
      },
      assignment: {
        workspaceId: signal.workspaceId,
        channelId: signal.channelId,
        agentId: agent.id,
        runtimeContract: 'chickpea-v1',
        agent,
      },
      turnJobId: 'turn_SKILL_IMPORT_APPROVE',
      proposalId: result.proposalId,
      dependencies: {
        identity: f.identity,
        config: f.config,
        management: f.management,
        service: f.service,
      },
    });
    assert.deepEqual(approval, {
      kind: 'message',
      text: 'Installed skill `unslop` on Sprout. It’s active from the next message.',
    });
    const updated = await f.config.getAgent(agent.id);
    assert.deepEqual(updated.skills.map(({ name }) => name), ['existing-skill', 'unslop']);
    assert.equal(updated.skills[1]?.enabled, true);
    assert.equal(updated.skills[1]?.instructions, 'Rewrite the draft plainly and preserve its meaning.');
  } finally {
    f.close();
  }
});

test('skill import requires selection for a multi-skill source and rejects packaged scripts', async () => {
  let resolutionCalls = 0;
  const resolvedSources: ParsedSkillSource[] = [];
  const f = await createManagementAdapterFixture('slack-skill-selection', {
    resolveSkillImport: async (source) => {
      resolutionCalls += 1;
      resolvedSources.push(source);
      return resolution(source, source.repo === 'scripted' ? [{
          name: 'scripted-skill',
          description: 'Requires a packaged script.',
          instructions: 'Run the packaged script.',
          hasScripts: true,
          path: 'skills/scripted-skill',
          sourceUrl: 'https://github.com/acme/scripted/tree/main/skills/scripted-skill',
        }]
      : [
          {
            name: 'alpha',
            description: 'Alpha skill.',
            instructions: 'Do alpha work.',
            hasScripts: false,
            path: 'skills/alpha',
            sourceUrl: 'https://github.com/acme/skills/tree/main/skills/alpha',
          },
          {
            name: 'beta',
            description: 'Beta skill.',
            instructions: 'Do beta work.',
            hasScripts: false,
            path: 'skills/Writing_Helper',
            sourceUrl: 'https://github.com/acme/skills/tree/main/skills/Writing_Helper',
          },
        ]);
    },
  });
  const agent = await f.config.createAgent({
    id: 'agent_importer',
    name: 'Importer',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Import reviewed skills.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const signal = {
    agentId: agent.id,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_SKILL_SELECTION',
    threadTs: '200.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_SKILL_SELECTION',
    messageTs: '200.2',
    turnJobId: 'turn_SKILL_SELECTION',
  };
  try {
    const selection = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'propose_skill_import',
      args: {
        source: 'acme/skills',
        idempotencyKey: 'choose-skill',
        guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
      },
    });
    assert.equal(selection.ok, true);
    const selectionResult = (selection as { ok: true; result: {
      status: string;
      candidates: Array<{ name: string }>;
    } }).result;
    assert.equal(selectionResult.status, 'selection_required');
    assert.deepEqual(selectionResult.candidates.map(({ name }) => name), ['alpha', 'beta']);
    assert.deepEqual((await f.config.getAgent(agent.id)).skills, []);

    const selected = await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, eventId: 'Ev_SKILL_SELECTED', turnJobId: 'turn_SKILL_SELECTED' },
      identity: f.identity,
      service: f.service,
      name: 'propose_skill_import',
      args: {
        source: 'acme/skills',
        skillName: 'beta',
        idempotencyKey: 'choose-beta',
        guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
      },
    });
    assert.equal(selected.ok, true);
    const selectedResult = (selected as { ok: true; result: {
      status: string;
      import: { name: string };
    } }).result;
    assert.equal(selectedResult.status, 'pending');
    assert.equal(selectedResult.import.name, 'beta');
    assert.deepEqual(resolvedSources.at(-1), { owner: 'acme', repo: 'skills' });
    assert.deepEqual((await f.config.getAgent(agent.id)).skills, []);

    const scripted = await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, eventId: 'Ev_SCRIPTED', turnJobId: 'turn_SCRIPTED' },
      identity: f.identity,
      service: f.service,
      name: 'propose_skill_import',
      args: {
        source: 'acme/scripted',
        idempotencyKey: 'scripted-skill',
        guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
      },
    });
    assert.deepEqual(scripted, {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Skill scripted-skill includes executable scripts, which Chickpea Agent skills do not package. No proposal was created.',
      },
    });
    assert.deepEqual((await f.config.getAgent(agent.id)).skills, []);

    const callsBeforeInvalidSource = resolutionCalls;
    const invalidSource = await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, eventId: 'Ev_INVALID_SOURCE', turnJobId: 'turn_INVALID_SOURCE' },
      identity: f.identity,
      service: f.service,
      name: 'propose_skill_import',
      args: {
        source: 'acme.foo/repo',
        idempotencyKey: 'invalid-source',
        guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
      },
    });
    assert.deepEqual(invalidSource, {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Use a valid GitHub owner/repository source.',
      },
    });
    assert.equal(resolutionCalls, callsBeforeInvalidSource);
  } finally {
    f.close();
  }
});
