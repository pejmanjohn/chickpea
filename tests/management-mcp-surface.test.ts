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
import { adminSettingsLinks } from '../src/management/admin-links.ts';
import { workspaceManagementInstructions } from '../src/management/instructions.ts';
import { WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES } from '../src/management/mcp.ts';
import { workspaceManagementToolDescription } from '../src/management/tool-adapter.ts';

/** Wording a coding agent must never be told; it has no Slack thread, DM, or Slack preview. */
const SLACK_ONLY_WORDING = /presentation\.slack|\bDMs?\b|Slack turn|Slack Lists|Slack conversation|requester message|current command on Slack|progress UI/;

test('MCP tool descriptions carry no Slack-conversation instructions while Slack text is untouched', () => {
  for (const name of WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES) {
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
  assert.match(workspaceManagementToolDescription('propose_workspace_changes'), /Introduce presentation\.slack in a sentence or two, show it verbatim/);
  assert.match(workspaceManagementToolDescription('inspect_routines'), /In a DM, omit channelId/);
  assert.match(workspaceManagementToolDescription('prepare_connector_setup'), /agentId may be omitted/);

  // The MCP door acts with Admin authority and asks only before a destructive change.
  for (const name of WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES) {
    assert.doesNotMatch(workspaceManagementToolDescription(name, 'mcp'), /propose_/, `${name} (mcp)`);
  }
  const apply = workspaceManagementToolDescription('apply_workspace_changes', 'mcp');
  assert.match(apply, /Admin authority/);
  assert.match(apply, /standalone create_agent operation/i);
  assert.match(apply, /confirmation_required with presentation\.markdown/);
  assert.match(apply, /links\.admin/);
  assert.match(apply, /links\.slack/);
  const confirm = workspaceManagementToolDescription('confirm_workspace_change', 'mcp');
  assert.match(confirm, /"Are you sure\?" step/);
  assert.match(confirm, /links\.admin and links\.slack/);
  const connector = workspaceManagementToolDescription('prepare_connector_setup', 'mcp');
  assert.match(connector, /agentId is required/);
  assert.doesNotMatch(connector, /24 hours|anyone holding/, 'MCP returns an Admin page, not a bearer setup link');
  assert.match(workspaceManagementToolDescription('import_skill', 'mcp'), /installs immediately/);
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
    'pasted the key',
    'typed its URLs',
    'Approve click',
  ]) assert.ok(!body.includes(slackOnly), `coding-agent guide still says ${slackOnly}`);
  for (const kept of [
    '## Start with posture',
    '## Inspect before recommending',
    '## Choose the configuration primitive',
    '## Apply, confirm, and commit',
    '## Acting scope',
    '## Final check',
    'Never request credentials, OAuth codes, tokens, private keys, or secret-bearing URLs',
    'If the person gave you the key, troubleshoot with it until a setup works, then save it with `save_connection_key`.',
    'When the docs put the API on another host than the person named, tell them which host the key will go to before you add the connection.',
    'call `apply_workspace_changes` in that same turn with exactly one standalone base `create_agent` operation',
    'An external MCP client acts with the signed-in person\'s Admin authority',
    'presentation.markdown',
    'links.admin',
    'links.slack',
    'import_skill',
    'confirm_workspace_change',
  ]) assert.ok(body.includes(kept), `coding-agent guide must keep ${kept}`);
  assert.ok(!body.includes('propose_'), 'the coding-agent guide names no propose tool');
  assert.ok(!AGENT_SKILL_CREATION_GUIDE_MCP.includes('presentation.slack'));
  assert.ok(!AGENT_SKILL_CREATION_GUIDE_MCP.includes('propose_'));
  assert.ok(AGENT_SKILL_CREATION_GUIDE_MCP.includes('import_skill'));

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

test('hosted instructions and links leave out the Settings sections its Admin hides; standalone keeps them', () => {
  const hosted = { CHICKPEA_TENANCY: 'installation' };
  const base = 'https://chickpea.example.test';
  const standalone = workspaceManagementInstructions(base);
  const hostedText = workspaceManagementInstructions(base, hosted);
  assert.ok(standalone.includes(`${base}/admin: Model providers (/admin/settings/providers), GitHub (/admin/settings/github), Coding sandbox (/admin/settings/sandbox), Browser (/admin/settings/browser), Connectors (/admin/settings/connectors).`));
  assert.doesNotMatch(standalone, /Outbound|outbound/, 'Outbound access is retired in both modes');
  assert.ok(hostedText.includes(`${base}/admin: Model providers (/admin/settings/providers), GitHub (/admin/settings/github), Connectors (/admin/settings/connectors).`));
  assert.doesNotMatch(hostedText, /sandbox|Browser|Outbound|outbound/);
  assert.equal(
    hostedText,
    standalone.replace(', Coding sandbox (/admin/settings/sandbox), Browser (/admin/settings/browser)', ''),
    'only those sections are removed',
  );

  for (const section of ['sandbox', 'browser'] as const) {
    assert.deepEqual(adminSettingsLinks(base, section), { admin: `${base}/admin/settings/${section}` }, `standalone ${section}`);
    assert.equal(adminSettingsLinks(base, section, hosted), undefined, `hosted ${section}`);
  }
  for (const section of ['providers', 'github', 'connectors'] as const) {
    assert.deepEqual(adminSettingsLinks(base, section, hosted), { admin: `${base}/admin/settings/${section}` }, `hosted ${section}`);
  }
});
