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

test('destructive proposals name the target and action without fake before and after values', () => {
  const presentation = formatSlackChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'delete',
      operationKind: 'delete_agent',
      target: 'agent:agent_paid_marketing',
    }],
    missingSetup: [],
  });

  assert.match(presentation, /\*agent:agent_paid_marketing — Delete Agent\*/);
  assert.doesNotMatch(presentation, /\*Before\*|\*After\*|\(not set\)/);
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
  'proposalId; if they want changes, propose again.';

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

test('Markdown destructive proposals name the target and action', () => {
  const markdown = formatMarkdownChangeSetProposal({
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'delete',
      operationKind: 'delete_agent',
      target: 'agent:agent_paid_marketing',
    }],
    missingSetup: [],
  });

  assert.equal(markdown, [
    '**Proposed changes**',
    '**agent:agent_paid_marketing — Delete Agent**',
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
