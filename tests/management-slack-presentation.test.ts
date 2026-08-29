import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatSlackChangeSetProposal,
  formatSlackSkillImportProposal,
} from '../src/management/slack-presentation.ts';
import type { ManagementChangeSetPreview } from '../src/management/types.ts';

test('new Agent proposals show only the useful identity fields without before and after', () => {
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
    '*Ready to create*',
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
    'Reply `create it` to create this Agent and publish its Slack handle, or tell me what to adjust.',
  ].join('\n'));
  assert.doesNotMatch(presentation, /Before|After|Slack Presence|Editing Authority|MCP Servers/);
  assert.doesNotMatch(presentation, /private-seed|Repositories|Lifecycle|Kind/);
});

test('Channel-created Agent proposals stay one concise creation review', () => {
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

  assert.match(presentation, /^\*Ready to create\*/);
  assert.match(presentation, /\*Available in\*\n> This Channel/);
  assert.match(presentation, /Reply `create it`/);
  assert.doesNotMatch(presentation, /Proposed changes|Grant Agent Channel|channel_grant|Reply `approve`/);
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
