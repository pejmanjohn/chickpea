import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_AUTHORING_GUIDE,
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_VERSION,
  AGENT_SKILL_CREATION_GUIDE,
} from '../src/management/agent-authoring/index.ts';
import {
  AGENT_AUTHORING_GUIDE_MCP,
  AGENT_AUTHORING_GUIDE_MCP_DIGEST,
  AGENT_AUTHORING_GUIDE_MCP_SUBSTITUTIONS,
  AGENT_SKILL_CREATION_GUIDE_MCP,
  AGENT_SKILL_CREATION_GUIDE_MCP_SUBSTITUTIONS,
  codingAgentAuthoringGuideResource,
} from '../src/management/agent-authoring/mcp-guide.ts';
import { workspaceManagementInstructions } from '../src/management/instructions.ts';
import {
  WORKSPACE_MANAGEMENT_TOOL_NAMES,
  workspaceManagementToolDescription,
} from '../src/management/tool-adapter.ts';

/** Wording a coding agent must never be told; it has no Slack thread, DM, or Slack preview. */
const SLACK_ONLY_WORDING = /presentation\.slack|\bDMs?\b|Slack turn|Slack Lists|Slack conversation|requester message|current command on Slack|progress UI/;

test('MCP tool descriptions carry no Slack-conversation instructions while Slack text is untouched', () => {
  for (const name of WORKSPACE_MANAGEMENT_TOOL_NAMES) {
    const slack = workspaceManagementToolDescription(name);
    const mcp = workspaceManagementToolDescription(name, 'mcp');
    assert.equal(slack, workspaceManagementToolDescription(name, 'slack'), `${name}: Slack is the default surface`);
    assert.ok(slack.length > 20 && mcp.length > 20, name);
    if (name === 'discover_slack_channels') {
      assert.equal(mcp, slack, 'Slack Channel discovery may still say Slack');
      continue;
    }
    assert.doesNotMatch(mcp, SLACK_ONLY_WORDING, `${name} (mcp): ${mcp}`);
  }

  // The Slack door still tells Chickpea to show presentation.slack and derive the DM from the origin.
  assert.match(workspaceManagementToolDescription('propose_workspace_changes'), /Show presentation\.slack verbatim/);
  assert.match(workspaceManagementToolDescription('inspect_routines'), /In a DM, omit channelId/);
  assert.match(workspaceManagementToolDescription('prepare_connector_setup'), /agentId may be omitted/);

  // The MCP door gets the coding-agent equivalents and the same mutation rules.
  const proposal = workspaceManagementToolDescription('propose_workspace_changes', 'mcp');
  assert.match(proposal, /Show presentation\.markdown to the person/);
  assert.match(proposal, /Agent creation is not valid here/i);
  assert.match(proposal, /typed Chickpea workspace configuration operation/i);
  assert.match(proposal, /Approval cannot make an unsupported operation available/i);
  assert.match(proposal, new RegExp(`"guideVersion":"${AGENT_AUTHORING_GUIDE_VERSION.replace(/\./g, '\\.')}"`));
  const apply = workspaceManagementToolDescription('apply_workspace_changes', 'mcp');
  assert.match(apply, /created immediately as a standalone create_agent operation/i);
  assert.match(apply, /links\.admin/);
  assert.match(apply, /links\.slack/);
  assert.match(workspaceManagementToolDescription('confirm_workspace_change', 'mcp'), /links\.admin and links\.slack/);
  assert.match(workspaceManagementToolDescription('prepare_connector_setup', 'mcp'), /agentId is required/);
  assert.match(workspaceManagementToolDescription('import_skill', 'mcp'), /use propose_skill_import instead/);
  assert.match(workspaceManagementToolDescription('propose_skill_import', 'mcp'), /presentation\.markdown/);
});

test('the coding-agent guide keeps the canonical version and rules and drops Slack-only mechanics', () => {
  const resource = codingAgentAuthoringGuideResource();
  assert.equal(resource.version, AGENT_AUTHORING_GUIDE_VERSION);
  assert.equal(resource.digest, AGENT_AUTHORING_GUIDE_DIGEST, 'proposals keep repeating the canonical digest');
  assert.equal(resource.variant, 'coding-agent');
  assert.equal(resource.variantDigest, AGENT_AUTHORING_GUIDE_MCP_DIGEST);
  assert.notEqual(resource.variantDigest, resource.digest);
  assert.equal(resource.guide, AGENT_AUTHORING_GUIDE_MCP);
  assert.deepEqual(resource.files, { 'skill-creation.md': AGENT_SKILL_CREATION_GUIDE_MCP });

  assert.ok(AGENT_AUTHORING_GUIDE_MCP.startsWith('> **You are reading this over the Chickpea MCP.**'));
  const body = AGENT_AUTHORING_GUIDE_MCP.slice(AGENT_AUTHORING_GUIDE_MCP.indexOf('# Chickpea Agent authoring'));
  for (const slackOnly of [
    'presentation.slack',
    'manage_scheduled_work',
    'request_chickpea_handoff',
    'connectorMentions',
    'current_dm_thread',
    'Slack Lists',
    'one-to-one DM',
    '!routines',
    'owns the single welcome',
    'ends with `View Agent`',
  ]) assert.ok(!body.includes(slackOnly), `coding-agent guide still says ${slackOnly}`);
  for (const kept of [
    '## Start with posture',
    '## Inspect before recommending',
    '## Choose the configuration primitive',
    '## Propose, review, and commit',
    '## Acting scope',
    '## Final check',
    'Never request credentials, OAuth codes, tokens, private keys, or secret-bearing URLs',
    'call `apply_workspace_changes` in that same turn with exactly one standalone base `create_agent` operation',
    'An external MCP client acts with the authenticated requester\'s permissions',
    'presentation.markdown',
    'links.admin',
    'links.slack',
    'propose_skill_import',
  ]) assert.ok(body.includes(kept), `coding-agent guide must keep ${kept}`);
  assert.ok(!AGENT_SKILL_CREATION_GUIDE_MCP.includes('presentation.slack'));
  assert.ok(AGENT_SKILL_CREATION_GUIDE_MCP.includes('propose_skill_import'));

  // Every substitution still matches the canonical text exactly once, so a guide edit cannot silently strand the variant.
  for (const [guide, substitutions] of [
    [AGENT_AUTHORING_GUIDE, AGENT_AUTHORING_GUIDE_MCP_SUBSTITUTIONS],
    [AGENT_SKILL_CREATION_GUIDE, AGENT_SKILL_CREATION_GUIDE_MCP_SUBSTITUTIONS],
  ] as const) {
    for (const [from, to] of substitutions) {
      assert.equal(guide.split(from).length, 2, `substitution must match once: ${from.slice(0, 60)}`);
      assert.notEqual(from, to);
    }
  }
});

test('server instructions point coding agents at Markdown presentation, links, and real Admin paths', () => {
  const text = workspaceManagementInstructions('https://chickpea.example.test');
  assert.match(text, /presentation\.markdown, never presentation\.slack/);
  assert.match(text, /links\.admin and links\.slack/);
  assert.ok(text.includes('https://chickpea.example.test/admin: Model providers (/admin/settings/providers)'));
  assert.ok(!text.includes('#/settings'), 'Admin routes are path-based, not hash-based');
});
