import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParsedSkillSource, SkillResolution } from '../src/config/skill-import.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import { formatChangeSetProposal, formatSkillImportProposal } from '../src/management/change-set-presentation.ts';
import { MARKDOWN_PRESENTATION_DIALECT } from '../src/management/markdown-presentation.ts';
import { invokeSlackWorkspaceManagementTool, type SlackManagementSignal } from '../src/management/slack-tools.ts';
import type { ManagementChangeSetPreview } from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

/** The line 4.x's Markdown dialect closed a proposal with: it named a tool no Slack Agent has. */
const FOUR_X_LINE = 'Show these changes to the person. When they approve, call confirm_workspace_change with the ' +
  'proposalId; if they want something different, inspect again and send a new change.';
const FOUR_X_DIALECT = { ...MARKDOWN_PRESENTATION_DIALECT, approvalInstruction: FOUR_X_LINE, truncatedApprovalInstruction: FOUR_X_LINE };
/** A Slack proposal's keys before 5.0.0, less `confirmationTool`. */
const PROPOSAL_KEYS = ['digest', 'guide', 'instruction', 'presentation', 'preview', 'proposalId', 'status'];
const SOURCE_URL = 'https://github.com/acme/skills/tree/2222222222222222222222222222222222222222/skills/alpha';

function resolution(source: ParsedSkillSource): SkillResolution {
  return {
    owner: source.owner, repo: source.repo, ref: '2222222222222222222222222222222222222222',
    source: { visibility: 'public', access: 'anonymous' },
    skills: [{
      name: 'alpha', description: 'A reusable procedure.', instructions: 'Follow the procedure.', hasScripts: false,
      path: 'skills/alpha', sourceUrl: SOURCE_URL,
      inspection: { complete: true, scriptPaths: [], auxiliaryPaths: [], unknownPaths: [], warnings: [] },
    }],
    total: 1, capped: false, skipped: 0,
  };
}

/** Everything but the last line, which is the line for the person. */
const body = (markdown: string) => markdown.split('\n').slice(0, -1).join('\n');

test('a Slack proposal\'s Markdown ends with the 5.0 line, its Slack text and keys are unchanged, and it names no confirm tool', async () => {
  const f = await createManagementAdapterFixture('slack-proposal-markdown', {
    resolveSkillImport: async (source) => resolution(source),
  });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_markdown', name: 'Markdown', creatorMembershipId: f.admin.membership.id,
      editPolicy: 'creator_and_admins', lifecycle: 'active', configurationGeneration: 1,
      instructions: 'Help with work.', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const signal = (event: string, requesterText: string): SlackManagementSignal => ({
      agentId: agent.id, workspaceId: f.admin.user.slackTeamId, channelId: 'D_MARKDOWN', threadTs: '700.1',
      conversationKind: 'im', slackUserId: f.admin.binding.slackUserId, eventId: `Ev_${event}`, messageTs: `700.${event.length}`,
      turnJobId: `turn_${event}`, requesterText,
    });
    const proposals = [
      await invokeSlackWorkspaceManagementTool({
        signal: signal('change', 'Change your instructions to: answer in French.'),
        identity: f.identity, service: f.service, name: 'propose_workspace_changes',
        args: {
          idempotencyKey: 'markdown-change', guideVersion: AGENT_AUTHORING_GUIDE_VERSION, authoringReason: 'agent_edit',
          operations: [{ itemId: 'instructions', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision,
            patch: { instructions: 'Answer in French.' } }],
        },
      }),
      await invokeSlackWorkspaceManagementTool({
        signal: signal('skill', 'Propose the alpha skill from acme/skills'),
        identity: f.identity, service: f.service, name: 'propose_skill_import',
        args: { source: 'acme/skills', skillName: 'alpha', idempotencyKey: 'markdown-skill', guideVersion: AGENT_AUTHORING_GUIDE_VERSION },
      }),
    ];
    for (const [index, proposal] of proposals.entries()) {
      const kind = index === 0 ? 'change set' : 'skill import';
      assert.ok(proposal.ok, JSON.stringify(proposal));
      const result = proposal.result as {
        preview: ManagementChangeSetPreview;
        presentation: { slack: string; markdown: string };
        import?: unknown;
      };
      // A skill import's result never carried its preview; it carries what it imports.
      const keys = index === 0 ? PROPOSAL_KEYS : [...PROPOSAL_KEYS.filter((key) => key !== 'preview'), 'import'].sort();
      assert.deepEqual(Object.keys(result).sort(), keys, `${kind}: no confirmationTool`);
      assert.doesNotMatch(JSON.stringify(result), /confirm_workspace_change/, kind);
      const { markdown, slack } = result.presentation;
      assert.equal(markdown.split('\n').at(-1), 'Nothing changes until you confirm.', kind);
      const preview = result.preview ?? (await f.management.getChangeSetProposal((result as unknown as { proposalId: string }).proposalId))!.preview;
      const fourX = index === 0
        ? formatChangeSetProposal(preview as ManagementChangeSetPreview, FOUR_X_DIALECT)
        : formatSkillImportProposal(preview as ManagementChangeSetPreview, SOURCE_URL, FOUR_X_DIALECT);
      assert.equal(fourX.split('\n').at(-1), FOUR_X_LINE);
      assert.equal(body(markdown), body(fourX), `${kind}: the Markdown keeps what 4.x showed before its last line`);
      assert.doesNotMatch(slack, /confirm_workspace_change|Nothing changes until you confirm/, `${kind}: the Slack text keeps Slack's own line`);
      assert.match(slack, /approve/i, kind);
    }
    // Both previews whole, pinned: the Slack text as before, and the Markdown with only its last line moved.
    const shown = proposals.map((proposal) => (proposal as { result: { presentation: { slack: string; markdown: string } } }).result.presentation);
    const slackLine = 'Reply `approve` to apply these exact changes, or tell me what to adjust.';
    assert.deepEqual(shown, [{
      slack: ['*Proposed changes*', '*Markdown — Instructions*', '*Before*', '> Help with work.', '*After*', '> Answer in French.', '', slackLine].join('\n'),
      markdown: ['**Proposed changes**', '**Markdown — Instructions**', '**Before**', '> Help with work.', '**After**', '> Answer in French.', '',
        'Nothing changes until you confirm.'].join('\n'),
    }, {
      slack: ['*Proposed changes*', '*Source*', `> ${SOURCE_URL}`, '', '*Markdown — Skill: alpha*', '*Add*', '*Status*', '> Enabled',
        '*Description*', '> A reusable procedure.', '*Instructions*', '> Follow the procedure.', '', slackLine].join('\n'),
      markdown: ['**Proposed changes**', '**Source**', `> <${SOURCE_URL}>`, '', '**Markdown — Skill: alpha**', '**Add**', '**Status**', '> Enabled',
        '**Description**', '> A reusable procedure.', '**Instructions**', '> Follow the procedure.', '', 'Nothing changes until you confirm.'].join('\n'),
    }]);
  } finally {
    f.close();
  }
});
