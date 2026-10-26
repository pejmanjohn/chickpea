import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatMarkdownChangeSetProposal,
  formatMarkdownSkillImportProposal,
} from '../src/management/markdown-presentation.ts';
import {
  formatSlackChangeSetProposal,
  formatSlackSkillImportProposal,
} from '../src/management/slack-presentation.ts';
import type { ManagementChangeSetPreview } from '../src/management/types.ts';

test('legacy Agent creation previews show useful identity fields without obsolete create-it copy', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        id: 'agent_paid_marketing',
        revision: 1,
        name: 'Paid Marketing',
        description: 'Helps with Google Ads budgets and copy.',
        instructions: 'Review spend, flag budget risks, and improve ad copy.',
        enabled: true,
        kind: 'user',
        lifecycle: 'active',
        editPolicy: 'creator_and_admins',
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
          desiredState: 'unpublished',
          health: 'unpublished',
          avatar: { kind: 'generated', revision: 1, seed: 'private-seed' },
        },
      },
    }],
    missingSetup: [],
  });

  assert.equal(presentation, [
    '*Proposed changes*',
    '*New Agent*',
    '*Name*',
    '> Paid Marketing',
    '',
    '*Slack Handle*',
    '> @paid-marketing',
    '',
    '*Description*',
    '> Helps with Google Ads budgets and copy.',
    '',
    '*Instructions*',
    '> Review spend, flag budget risks, and improve ad copy.',
    '',
    'Reply `approve` to apply these exact changes, or tell me what to adjust.',
  ].join('\n'));
  assert.doesNotMatch(presentation, /Before|After|Slack Presence|Editing Authority|MCP Servers/);
  assert.doesNotMatch(presentation, /private-seed|Repositories|Lifecycle|Kind/);
});

test('legacy Channel creation previews keep trusted reach concise', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '2 reviewed workspace changes',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        name: 'Paid Marketing',
        description: 'Helps with Google Ads budgets and copy.',
        instructions: 'Review spend and improve ad copy.',
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
        },
      },
    }, {
      itemId: 'create_origin_channel_grant',
      operationKind: 'grant_agent_channel',
      target: 'channel_grant:T123:C123:agent_paid_marketing',
      after: {
        workspaceId: 'T123',
        channelId: 'C123',
        agentId: 'agent_paid_marketing',
        revision: 1,
        status: 'active',
      },
    }],
    missingSetup: [],
  });

  assert.match(presentation, /^\*Proposed changes\*/);
  assert.match(presentation, /\*Available in\*\n> This Channel/);
  assert.match(presentation, /Reply `approve`/);
  assert.doesNotMatch(presentation, /Ready to create|Grant Agent Channel|channel_grant|Reply `create it`/);
});

test('Agent edits compare meaningful fields and project Slack presence to its handle', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'update',
      operationKind: 'update_agent',
      target: 'agent:agent_paid_marketing',
      before: {
        name: 'Paid Marketing',
        description: 'Helps with Google Ads.',
        instructions: 'Review spend.',
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
          desiredState: 'active',
          health: 'healthy',
        },
      },
      after: {
        name: 'Paid Marketing',
        description: 'Helps with Google Ads budgets and copy.',
        instructions: 'Review spend.',
        repositories: [],
        slackPresence: {
          requestedHandle: 'Performance Marketing',
          normalizedHandle: 'performance-marketing',
          desiredState: 'active',
          health: 'pending',
        },
      },
    }],
    missingSetup: [],
  });

  assert.match(presentation, /\*Paid Marketing — Description\*[\s\S]*\*Before\*[\s\S]*Helps with Google Ads\.[\s\S]*\*After\*[\s\S]*Helps with Google Ads budgets and copy\./);
  assert.match(presentation, /\*Paid Marketing — Slack Handle\*[\s\S]*@paid-marketing[\s\S]*@performance-marketing/);
  assert.doesNotMatch(presentation, /Slack Presence|Repositories|desiredState|health/);
});

test('skill status changes are visible in approval previews', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'disable-skill',
      operationKind: 'update_agent',
      target: 'agent:agent_writer',
      before: {
        name: 'Writer',
        skills: [{
          name: 'unslop',
          description: 'Rewrite plainly.',
          instructions: 'Remove AI tells.',
          enabled: true,
        }],
      },
      after: {
        name: 'Writer',
        skills: [{
          name: 'unslop',
          description: 'Rewrite plainly.',
          instructions: 'Remove AI tells.',
          enabled: false,
        }],
      },
    }],
    missingSetup: [],
  });

  assert.match(presentation, /\*Before\*[\s\S]*\*Status\*\n> Enabled/);
  assert.match(presentation, /\*After\*[\s\S]*\*Status\*\n> Disabled/);
});

test('blank Agent fields and internal Slack presence state do not create proposal noise', () => {
  const blankCreate = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        name: 'Paid Marketing',
        description: '',
        instructions: '   ',
        repositories: [],
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
          desiredState: 'unpublished',
          health: 'unpublished',
        },
      },
    }],
    missingSetup: [],
  });
  assert.match(blankCreate, /\*Name\*\n> Paid Marketing/);
  assert.match(blankCreate, /\*Slack Handle\*\n> @paid-marketing/);
  assert.doesNotMatch(blankCreate, /Description|Instructions|Repositories|\(not set\)/);

  const internalEdit = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'update',
      operationKind: 'update_agent',
      target: 'agent:agent_paid_marketing',
      before: {
        name: 'Paid Marketing',
        repositories: undefined,
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
          desiredState: 'active',
          health: 'healthy',
        },
      },
      after: {
        name: 'Paid Marketing',
        repositories: [],
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
          desiredState: 'active',
          health: 'pending',
        },
      },
    }],
    missingSetup: [],
  });
  assert.equal(internalEdit, [
    '*Proposed changes*',
    '*Paid Marketing — Update Agent*',
    '',
    'Reply `approve` to apply these exact changes, or tell me what to adjust.',
  ].join('\n'));
});

test('new Agent internals stay hidden even when explicitly configured', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        name: 'Paid Marketing',
        model: 'anthropic/claude-opus-5',
        editPolicy: 'all_workspace_members',
        skills: [
          { name: 'budget-review', instructions: 'private detail', enabled: true },
          { name: 'copy-review', instructions: 'private detail', enabled: true },
        ],
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
        },
      },
    }],
    missingSetup: [],
  });

  assert.doesNotMatch(
    presentation,
    /Model|Editing Authority|Skills|anthropic\/claude-opus-5|budget-review|copy-review|private detail|\"instructions\"/,
  );
});

test('a preview frozen before statements names the action, never the record or target', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'archive',
      operationKind: 'archive_agent',
      target: 'agent:agent_paid_marketing',
      before: {
        id: 'agent_paid_marketing',
        kind: 'user',
        name: 'Paid Marketing',
        lifecycle: 'active',
        slackPresence: {
          normalizedHandle: 'paid-marketing',
          avatar: { kind: 'generated', revision: 1, seed: 'private-seed' },
          userGroupId: 'S0PRIVATE',
          observedAt: 1_792_968_987_675,
        },
      },
    }],
    missingSetup: [],
  });

  assert.equal(presentation, [
    '*Proposed changes*',
    '*Paid Marketing — Archive Agent*',
    '',
    'Reply `approve` to apply these exact changes, or tell me what to adjust.',
  ].join('\n'));
});

test('Agent edits render only person-facing fields, in Admin words', () => {
  // Every internal field differs between before and after, so allowlisting
  // any one of them renders a section and fails the exact match below.
  const internalsBefore = {
    id: 'agent_paid_marketing',
    kind: 'user',
    configurationGeneration: 4,
    creatorMembershipId: 'membership_creator',
    credentialIncarnation: 'incarnation_private',
  };
  const internalsAfter = {
    id: 'agent_paid_marketing_copy',
    kind: 'system',
    configurationGeneration: 5,
    creatorMembershipId: 'membership_other',
    credentialIncarnation: 'incarnation_rotated',
  };
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'update',
      operationKind: 'update_agent',
      target: 'agent:agent_paid_marketing',
      before: {
        ...internalsBefore,
        revision: 3,
        name: 'Paid Marketing',
        enabled: true,
        lifecycle: 'active',
        editPolicy: 'creator_and_admins',
        websiteLogins: [{ loginId: 'login_private', level: 'check' }],
        slackPresence: {
          normalizedHandle: 'paid-marketing',
          avatar: { kind: 'generated', revision: 1, seed: 'private-seed' },
          userGroupId: 'S0PRIVATE',
        },
      },
      after: {
        ...internalsAfter,
        revision: 4,
        name: 'Paid Marketing',
        enabled: false,
        lifecycle: 'needs_attention',
        editPolicy: 'all_workspace_members',
        websiteLogins: [],
        slackPresence: {
          normalizedHandle: 'paid-marketing',
          avatar: { kind: 'generated', revision: 2, seed: 'other-seed' },
          userGroupId: 'S0PRIVATE',
          observedAt: 1_792_968_987_675,
        },
      },
    }],
    missingSetup: [],
  });

  assert.equal(presentation, [
    '*Proposed changes*',
    '*Paid Marketing — Who can edit*',
    '*Before*',
    '> Creator and workspace admins',
    '*After*',
    '> Any workspace member',
    '',
    '*Paid Marketing — Status*',
    '*Before*',
    '> Enabled',
    '*After*',
    '> Disabled',
    '',
    'Reply `approve` to apply these exact changes, or tell me what to adjust.',
  ].join('\n'));
});

test('new Agent identity stays visible when long instructions truncate the preview', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        name: 'Paid Marketing',
        instructions: 'x'.repeat(20_000),
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
        },
      },
    }],
    missingSetup: [],
  });

  assert.match(presentation, /\*Name\*\n> Paid Marketing/);
  assert.match(presentation, /\*Slack Handle\*\n> @paid-marketing/);
  assert.match(presentation, /Preview truncated to fit Slack/);
});

test('new non-Agent objects show their values without a fictional before state', () => {
  const preview = {
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'routine',
      operationKind: 'save_routine',
      target: 'routine:new',
      after: {
        name: 'Monday budget review',
        description: 'Review paid marketing spend.',
        schedule: '0 9 * * 1',
      },
    }],
    missingSetup: [],
  } satisfies ManagementChangeSetPreview;

  const presentation = formatSlackChangeSetProposal(preview);
  assert.match(presentation, /\*Monday budget review — Description\*\n> Review paid marketing spend\./);
  assert.match(presentation, /\*Monday budget review — Schedule\*\n> 0 9 \* \* 1/);
  assert.doesNotMatch(presentation, /\*Before\*|\*After\*|\(not set\)/);
});

test('GitHub skill proposals show the exact source and only the changed skill', () => {
  const presentation = formatSlackSkillImportProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'update',
      operationKind: 'update_agent',
      target: 'agent:agent_sprout',
      before: {
        name: 'Sprout',
        skills: [{
          name: 'existing-skill',
          description: 'Keep this skill.',
          instructions: 'Keep working as before.',
          enabled: true,
        }],
      },
      after: {
        name: 'Sprout',
        skills: [{
          name: 'existing-skill',
          description: 'Keep this skill.',
          instructions: 'Keep working as before.',
          enabled: true,
        }, {
          name: 'unslop',
          description: 'Remove AI writing tells from prose.',
          instructions: 'Rewrite the draft plainly and preserve its meaning.',
          enabled: true,
        }],
      },
    }],
    missingSetup: [],
  }, 'https://github.com/cursor/plugins/tree/main/pstack/skills/unslop');

  assert.match(presentation, /^\*Proposed changes\*\n\*Source\*/);
  assert.match(presentation, /github\.com\/cursor\/plugins\/tree\/main\/pstack\/skills\/unslop/);
  assert.match(presentation, /\*Sprout — Skill: unslop\*\n\*Add\*/);
  assert.match(presentation, /\*Description\*\n> Remove AI writing tells from prose\./);
  assert.match(presentation, /\*Instructions\*\n> Rewrite the draft plainly/);
  assert.doesNotMatch(presentation, /existing-skill|Keep this skill|"instructions"|\[\s*\{/);
  assert.match(presentation, /Reply `approve` to apply these exact changes/);
});

test('skill proposal instructions are visibly bounded while approval keeps the full value', () => {
  const longInstructions = 'Do careful work. '.repeat(1_000);
  const presentation = formatSlackSkillImportProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'update',
      operationKind: 'update_agent',
      target: 'agent:agent_sprout',
      before: { name: 'Sprout', skills: [] },
      after: {
        name: 'Sprout',
        skills: [{
          name: 'unslop',
          description: 'Remove AI writing tells.',
          instructions: longInstructions,
          enabled: true,
        }],
      },
    }],
    missingSetup: [],
  }, 'https://github.com/cursor/plugins/tree/main/pstack/skills/unslop');

  assert.ok(presentation.length < 3_000);
  assert.match(presentation, /more characters; approval applies the full skill/);
  assert.match(presentation, /Reply `approve` to apply these exact changes/);
  assert.ok(!presentation.includes(longInstructions));
});

const MARKDOWN_APPROVAL_INSTRUCTION =
  'Show these changes to the person. When they approve, call confirm_workspace_change with the ' +
  'proposalId; if they want something different, inspect again and send a new change.';

test('Markdown Agent creation previews carry the same facts in a portable dialect', () => {
  const preview = {
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        id: 'agent_paid_marketing',
        revision: 1,
        name: 'Paid Marketing',
        description: 'Helps with Google Ads budgets & ad copy <fast>.',
        instructions: 'Review spend, flag budget risks, and improve ad copy.',
        enabled: true,
        editPolicy: 'creator_and_admins',
        slackPresence: {
          requestedHandle: 'Paid Marketing',
          normalizedHandle: 'paid-marketing',
          desiredState: 'unpublished',
          health: 'unpublished',
          avatar: { kind: 'generated', revision: 1, seed: 'private-seed' },
        },
      },
    }],
    missingSetup: [],
  } satisfies ManagementChangeSetPreview;

  assert.equal(formatMarkdownChangeSetProposal(preview), [
    '**Proposed changes**',
    '**New Agent**',
    '**Name**',
    '> Paid Marketing',
    '',
    '**Slack Handle**',
    '> @paid-marketing',
    '',
    '**Description**',
    '> Helps with Google Ads budgets & ad copy <fast>.',
    '',
    '**Instructions**',
    '> Review spend, flag budget risks, and improve ad copy.',
    '',
    MARKDOWN_APPROVAL_INSTRUCTION,
  ].join('\n'));

  const markdown = formatMarkdownChangeSetProposal(preview);
  assert.doesNotMatch(markdown, /&amp;|&lt;|&gt;/);
  assert.doesNotMatch(markdown, /Reply `approve`|truncated to fit Slack|private-seed/);
  assert.match(formatSlackChangeSetProposal(preview), /budgets &amp; ad copy &lt;fast&gt;/);
});

test('Markdown Agent edits keep the before and after comparison', () => {
  const markdown = formatMarkdownChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'update',
      operationKind: 'update_agent',
      target: 'agent:agent_paid_marketing',
      before: {
        name: 'Paid Marketing',
        description: 'Helps with Google Ads.',
        slackPresence: { requestedHandle: 'Paid Marketing', normalizedHandle: 'paid-marketing' },
      },
      after: {
        name: 'Paid Marketing',
        description: 'Helps with Google Ads budgets and copy.',
        slackPresence: {
          requestedHandle: 'Performance Marketing',
          normalizedHandle: 'performance-marketing',
        },
      },
    }],
    missingSetup: [],
  });

  assert.match(markdown, /\*\*Paid Marketing — Description\*\*\n\*\*Before\*\*\n> Helps with Google Ads\.\n\*\*After\*\*\n> Helps with Google Ads budgets and copy\./);
  assert.match(markdown, /\*\*Paid Marketing — Slack Handle\*\*[\s\S]*@paid-marketing[\s\S]*@performance-marketing/);
  assert.ok(markdown.endsWith(MARKDOWN_APPROVAL_INSTRUCTION));
  assert.doesNotMatch(markdown, /(^|[^*])\*[A-Z][a-z]+\*/);
});

test('Markdown skill import proposals show the source and only the changed skill', () => {
  const markdown = formatMarkdownSkillImportProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'update',
      operationKind: 'update_agent',
      target: 'agent:agent_sprout',
      before: {
        name: 'Sprout',
        skills: [{
          name: 'existing-skill',
          description: 'Keep this skill.',
          instructions: 'Keep working as before.',
          enabled: true,
        }],
      },
      after: {
        name: 'Sprout',
        skills: [{
          name: 'existing-skill',
          description: 'Keep this skill.',
          instructions: 'Keep working as before.',
          enabled: true,
        }, {
          name: 'unslop',
          description: 'Remove AI writing tells from prose & drafts.',
          instructions: 'Rewrite the draft plainly and preserve its meaning.',
          enabled: true,
        }],
      },
    }],
    missingSetup: [],
  }, 'https://github.com/cursor/plugins/tree/main/pstack/skills/unslop');

  assert.match(markdown, /^\*\*Proposed changes\*\*\n\*\*Source\*\*\n> https:\/\/github\.com/);
  assert.match(markdown, /\*\*Sprout — Skill: unslop\*\*\n\*\*Add\*\*/);
  assert.match(markdown, /\*\*Description\*\*\n> Remove AI writing tells from prose & drafts\./);
  assert.match(markdown, /\*\*Instructions\*\*\n> Rewrite the draft plainly/);
  assert.doesNotMatch(markdown, /existing-skill|Keep this skill|&amp;/);
  assert.ok(markdown.endsWith(MARKDOWN_APPROVAL_INSTRUCTION));
});

test('connection changes name each connection and the Agent', () => {
  const markdown = formatMarkdownChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'connections',
      operationKind: 'update_agent',
      target: 'agent:agent_research',
      before: {
        name: 'Research',
        slackPresence: { normalizedHandle: 'research' },
        mcpServers: [{ id: 'mcp_wiki', displayName: 'DeepWiki', lifecycleStatus: 'ready', enabled: true }],
        apiConnections: [{ id: 'api_billing', displayName: 'Billing', enabled: true }],
        repositories: [{ id: 'repo_docs', accountLogin: 'acme', fullName: 'acme/docs', enabled: true }],
      },
      after: {
        name: 'Research',
        slackPresence: { normalizedHandle: 'research' },
        mcpServers: [],
        apiConnections: [{ id: 'api_billing', displayName: 'Billing', enabled: false }],
        repositories: [
          { id: 'repo_docs', accountLogin: 'acme', fullName: 'acme/docs', enabled: true },
          { id: 'repo_all', accountLogin: 'acme', fullName: '', allRepos: true, enabled: true },
        ],
      },
    }],
    missingSetup: [],
  });

  assert.equal(markdown, [
    '**Proposed changes**',
    'Remove **DeepWiki** from **Research** (@research).',
    '',
    'Update **Billing** on **Research** (@research).',
    '',
    'Add **All repositories for acme** to **Research** (@research).',
    '',
    MARKDOWN_APPROVAL_INSTRUCTION,
  ].join('\n'));
});

test('Channel, routine, memory and setup changes read as statements without internal records', () => {
  const research = { name: 'Research', handle: 'research' };
  const markdown = formatMarkdownChangeSetProposal({
    summary: '9 reviewed workspace changes',
    changes: [{
      itemId: 'grant',
      operationKind: 'grant_agent_channel',
      target: 'channel_grant:T123:C123:agent_research',
      after: { workspaceId: 'T123', channelId: 'C123', agentId: 'agent_research', revision: 1, status: 'active' },
      statement: { kind: 'grant_agent_channel', agent: research, channel: 'launch' },
    }, {
      itemId: 'revoke',
      operationKind: 'revoke_agent_channel',
      target: 'channel_grant:T123:C456:agent_research',
      before: { workspaceId: 'T123', channelId: 'C456', agentId: 'agent_research', revision: 2, status: 'active' },
      after: null,
      statement: { kind: 'revoke_agent_channel', agent: research },
    }, {
      itemId: 'archive-channel',
      operationKind: 'put_channel',
      target: 'channel:T123:C123',
      before: { workspaceId: 'T123', channelId: 'C123', revision: 1, label: 'launch', lifecycle: 'active' },
      after: { workspaceId: 'T123', channelId: 'C123', revision: 2, label: 'launch', lifecycle: 'archived' },
    }, {
      itemId: 'memory',
      operationKind: 'update_agent_memory',
      target: 'agent:agent_research',
      before: { agentId: 'agent_research', body: 'Prefers primary sources.', revision: 2 },
      after: { agentId: 'agent_research', body: 'Prefers primary sources and recent papers.', revision: 3 },
      statement: { kind: 'update_agent_memory', agent: research },
    }, {
      itemId: 'pause',
      operationKind: 'control_routine',
      target: 'routine:routine_triage',
      statement: { kind: 'control_routine', routine: 'Morning triage', action: 'pause' },
    }, {
      itemId: 'run',
      operationKind: 'run_routine',
      target: 'routine:routine_triage',
      statement: { kind: 'run_routine', routine: 'Morning triage' },
    }, {
      itemId: 'reassign',
      operationKind: 'reassign_routine_agent',
      target: 'routine:routine_triage',
      statement: { kind: 'reassign_routine_agent', routine: 'Morning triage', agent: research },
    }, {
      itemId: 'delete-routine',
      operationKind: 'delete_routine',
      target: 'routine:routine_triage',
      statement: { kind: 'delete_routine', routine: 'Morning triage' },
    }, {
      itemId: 'setup',
      operationKind: 'request_setup',
      target: 'agent:agent_research',
      statement: { kind: 'request_setup', setup: 'DeepWiki' },
    }],
    missingSetup: [],
  });

  assert.equal(markdown, [
    '**Proposed changes**',
    'Add **Research** (@research) to **#launch**.',
    '',
    'Remove **Research** (@research) from a Channel. It stops answering there.',
    '',
    '**#launch — Status**',
    '**Before**',
    '> Active',
    '**After**',
    '> Archived',
    '',
    '**Research — Memory**',
    '**Before**',
    '> Prefers primary sources.',
    '**After**',
    '> Prefers primary sources and recent papers.',
    '',
    'Pause **Morning triage**.',
    '',
    'Run **Morning triage** now.',
    '',
    'Run **Morning triage** with **Research** (@research) from now on.',
    '',
    'Delete **Morning triage** permanently. This stops all future runs and cannot be undone.',
    '',
    'Set up **DeepWiki**.',
    '',
    MARKDOWN_APPROVAL_INSTRUCTION,
  ].join('\n'));
});

test('a provider key removal names at most eight Agents, the Workspace default and the roles', () => {
  const markdown = formatMarkdownChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'remove-key',
      operationKind: 'remove_provider_credential',
      target: 'provider:openai',
      statement: {
        kind: 'remove_provider_credential',
        provider: 'OpenAI',
        affectedAgents: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'],
        workspaceDefaultAffected: true,
        affectedWorkspaceRoles: ['image', 'coding'],
      },
    }],
    missingSetup: [],
  });

  assert.equal(markdown, [
    '**Proposed changes**',
    'Remove the stored **OpenAI** key. The Workspace default uses OpenAI, so Chickpea stops answering too. ' +
      '**A1**, **A2**, **A3**, **A4**, **A5**, **A6**, **A7**, **A8**, and 2 more use OpenAI and stop answering until a key is available. ' +
      'The default image model uses OpenAI, so image generation stops until a key is available. ' +
      'The default coding model uses OpenAI, so coding workspaces use each Agent’s own model until a key is available.',
    '',
    MARKDOWN_APPROVAL_INSTRUCTION,
  ].join('\n'));
});

test('Slack bold shows names as stored and neutralizes Slack control sequences in them', () => {
  const preview: ManagementChangeSetPreview = {
    summary: '2 reviewed workspace changes',
    changes: [{
      itemId: 'grant',
      operationKind: 'grant_agent_channel',
      target: 'channel_grant:T123:C123:agent_rd',
      statement: {
        kind: 'grant_agent_channel',
        agent: { name: 'R&D <!channel>', handle: 'rd_ops' },
        channel: 'eng_oncall',
      },
    }, {
      itemId: 'skill',
      operationKind: 'update_agent',
      target: 'agent:agent_research',
      before: { name: 'Research', skills: [] },
      after: {
        name: 'Research',
        skills: [{
          name: 'release_notes',
          description: 'Draft release notes.',
          instructions: 'Summarize merged changes.',
          enabled: true,
        }],
      },
    }],
    missingSetup: [],
  };

  const slack = formatSlackChangeSetProposal(preview);
  assert.match(slack, /^Add \*R&amp;D &lt;!channel&gt;\* \(@rd_ops\) to \*#eng_oncall\*\.$/m);
  assert.match(slack, /^\*Research — Skill: release_notes\*\n\*Add\*$/m);
  assert.doesNotMatch(slack, /<!channel>/);
  const markdown = formatMarkdownChangeSetProposal(preview);
  assert.match(markdown, /^Add \*\*R&D <!channel>\*\* \(@rd_ops\) to \*\*#eng_oncall\*\*\.$/m);
  assert.match(markdown, /^\*\*Research — Skill: release_notes\*\*\n\*\*Add\*\*$/m);
});

test('a member change with neither role nor status falls back to its heading', () => {
  const markdown = formatMarkdownChangeSetProposal({
    summary: '2 reviewed workspace changes',
    changes: [{
      itemId: 'named',
      operationKind: 'update_member',
      target: 'membership:membership_alex',
      statement: { kind: 'update_member', member: 'Alex Rivera' },
    }, {
      itemId: 'unnamed',
      operationKind: 'update_member',
      target: 'membership:membership_unknown',
      statement: { kind: 'update_member' },
    }],
    missingSetup: [],
  });

  assert.equal(markdown, [
    '**Proposed changes**',
    '**Alex Rivera — Update Member**',
    '',
    '**Update Member**',
    '',
    MARKDOWN_APPROVAL_INSTRUCTION,
  ].join('\n'));
});

test('Markdown previews stay whole well past the Slack block limit', () => {
  const markdown = formatMarkdownChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        name: 'Paid Marketing',
        instructions: 'x'.repeat(5_000),
        slackPresence: { requestedHandle: 'Paid Marketing', normalizedHandle: 'paid-marketing' },
      },
    }],
    missingSetup: [],
  });

  assert.ok(markdown.includes('x'.repeat(5_000)));
  assert.doesNotMatch(markdown, /preview truncated|truncated to fit Slack/);
  assert.ok(markdown.endsWith(MARKDOWN_APPROVAL_INSTRUCTION));
});

test('Markdown previews cap runaway proposals with a plain truncation note', () => {
  const markdown = formatMarkdownChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'create',
      operationKind: 'create_agent',
      target: 'agent:agent_paid_marketing',
      after: {
        name: 'Paid Marketing',
        instructions: 'x'.repeat(40_000),
        slackPresence: { requestedHandle: 'Paid Marketing', normalizedHandle: 'paid-marketing' },
      },
    }],
    missingSetup: [],
  });

  assert.ok(markdown.length <= 20_000);
  assert.match(markdown, /\*\*Name\*\*\n> Paid Marketing/);
  assert.match(markdown, /… \(preview truncated; confirmation applies the full proposal\)/);
  assert.ok(markdown.endsWith(MARKDOWN_APPROVAL_INSTRUCTION));
});
