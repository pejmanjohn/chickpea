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
import { WORKSPACE_MANAGEMENT_INSTRUCTIONS } from '../src/management/instructions.ts';
import {
  deprecatedToolDescription,
  V4_TOOL_REPLACEMENTS,
  WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES,
} from '../src/management/mcp.ts';
import { workspaceManagementToolDescription } from '../src/management/tool-adapter.ts';

/** Wording a coding agent must never be told; it has no Slack thread, DM, or Slack preview. */
const SLACK_ONLY_WORDING = /presentation\.slack|\bDMs?\b|Slack turn|Slack Lists|Slack conversation|requester message|current command on Slack|progress UI/;

test('4.x MCP descriptions are one deprecation line while Slack text is untouched', () => {
  for (const name of WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES) {
    const mcp = deprecatedToolDescription(name);
    assert.match(mcp, /^Deprecated 2026-11-09: use [a-z_, ]+(?: or [a-z_]+)?\.$|^Deprecated 2026-11-09: use one tool per change, such as create_agent or update_agent\.$/, name);
    assert.ok(V4_TOOL_REPLACEMENTS[name].every((replacement) => mcp.includes(replacement)), name);
    assert.doesNotMatch(mcp, SLACK_ONLY_WORDING, name);
  }
  assert.equal(deprecatedToolDescription('inspect_workspace'), 'Deprecated 2026-11-09: use get_workspace, list_agents or get_agent.');
  assert.equal(deprecatedToolDescription('revoke_mcp_client'), 'Deprecated 2026-11-09: use disconnect_app.');

  // The Slack door still tells Chickpea to show presentation.slack and derive the DM from the origin.
  assert.match(workspaceManagementToolDescription('propose_workspace_changes'), /Introduce presentation\.slack in a sentence or two, show it verbatim/);
  assert.match(workspaceManagementToolDescription('inspect_routines'), /In a DM, omit channelId/);
  assert.match(workspaceManagementToolDescription('prepare_connector_setup'), /agentId may be omitted/);
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

test('the instructions name no Admin link; get_workspace leaves out the Settings sections a hosted Admin hides', () => {
  assert.doesNotMatch(WORKSPACE_MANAGEMENT_INSTRUCTIONS, /\/admin|https?:/);
  const hosted = { CHICKPEA_TENANCY: 'installation' };
  const base = 'https://chickpea.example.test';
  for (const section of ['sandbox', 'browser'] as const) {
    assert.deepEqual(adminSettingsLinks(base, section), { admin: `${base}/admin/settings/${section}` }, `standalone ${section}`);
    assert.equal(adminSettingsLinks(base, section, hosted), undefined, `hosted ${section}`);
  }
  for (const section of ['providers', 'github', 'connectors'] as const) {
    assert.deepEqual(adminSettingsLinks(base, section, hosted), { admin: `${base}/admin/settings/${section}` }, `hosted ${section}`);
  }
});
