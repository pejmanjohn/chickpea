import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEffectiveSlackConfig } from '../src/config/effective-config.ts';
import { seededChannelBriefs } from '../src/config/seed.ts';
import { snapshotFromEffectiveConfig } from '../src/config/snapshot-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { createLookupChannelBriefTool } from '../src/tools/flue-tools.ts';

function assignmentFixture(overrides: Partial<ResolvedAssignment> = {}): ResolvedAssignment {
  return {
    workspaceId: 'T_REAL',
    channelId: 'C0REALCHAN',
    agentId: 'agent_real',
    agent: {
      id: 'agent_real',
      name: 'Real Profile',
      description: 'Engineering release notes.',
      instructions: 'You are the real profile.',
      enabled: true,
      defaultModels: { claude: 'anthropic/test-claude', 'workers-ai': '@cf/test/model' },
      allowedTools: ['lookup_channel_brief'],
    },
    ...overrides,
  };
}

test('lookup_channel_brief composes a real-install brief from the assignment config', async () => {
  const tool = createLookupChannelBriefTool(
    assignmentFixture({
      channelLabel: 'eng-releases',
      channelPromptAddendum: 'Close every answer with a Ship checklist.',
    }),
  );
  const { brief } = await tool.run({ input: { channelId: 'C0REALCHAN' } });

  assert.match(brief, /Channel: #eng-releases\./);
  assert.match(brief, /Assigned profile: Real Profile — Engineering release notes\./);
  assert.match(brief, /Channel instructions: Close every answer with a Ship checklist\./);
});

test('lookup_channel_brief still works with a bare assignment (no label, no addendum)', async () => {
  const tool = createLookupChannelBriefTool(assignmentFixture());
  const { brief } = await tool.run({ input: { channelId: 'C0REALCHAN' } });

  assert.match(brief, /Assigned profile: Real Profile/);
  assert.doesNotMatch(brief, /Channel instructions:/);
  assert.doesNotMatch(brief, /No configured channel brief/);
});

test('lookup_channel_brief keeps the curated demo brief as the leading layer for fixtures', async () => {
  const tool = createLookupChannelBriefTool(
    assignmentFixture({ workspaceId: 'T_DEMO', channelId: 'C_EXEC', channelLabel: 'exec-briefing' }),
  );
  const { brief } = await tool.run({ input: { channelId: 'C_EXEC' } });

  const curated = seededChannelBriefs.C_EXEC;
  assert.ok(curated && curated.length > 0, 'expected a curated C_EXEC fixture brief');
  assert.ok(brief.startsWith(curated));
  assert.match(brief, /Channel: #exec-briefing\./);
});

test('curated demo briefs never leak into a real workspace with a colliding channel id', async () => {
  const tool = createLookupChannelBriefTool(
    assignmentFixture({ workspaceId: 'T_REAL', channelId: 'C_EXEC' }),
  );
  const { brief } = await tool.run({ input: { channelId: 'C_EXEC' } });

  const curated = seededChannelBriefs.C_EXEC;
  assert.ok(curated && curated.length > 0);
  assert.ok(!brief.includes(curated), 'demo fixture copy must not appear outside T_DEMO');
});

test('channelLabel survives the REAL production path: store -> effective config -> snapshot -> tool', async () => {
  // Regression for the wiring gap where the resolver passed channelLabel but
  // resolveEffectiveSlackConfig and snapshotFromEffectiveConfig dropped it, so
  // the tool never saw it outside direct-factory unit tests.
  const store = new SqliteConfigStore(':memory:', {
    agents: [
      {
        id: 'agent_labeled',
        name: 'Labeled Profile',
        description: 'Real-path label test.',
        instructions: 'Answer plainly.',
        enabled: true,
        defaultModels: { claude: 'anthropic/x', 'workers-ai': '@cf/x' },
        allowedTools: ['lookup_channel_brief'],
      },
    ],
    assignments: [
      {
        workspaceId: 'T_REAL',
        channelId: 'C0LABELCHAN',
        agentId: 'agent_labeled',
        enabled: true,
        channelLabel: 'eng-releases',
        channelPromptAddendum: 'End with a Ship checklist.',
      },
    ],
  });
  try {
    const effective = await resolveEffectiveSlackConfig(
      'T_REAL',
      'C0LABELCHAN',
      { agents: store, assignments: store },
      { SLACK_TAG_MODEL: 'local-stub/parity-stub-1' } as NodeJS.ProcessEnv,
    );
    assert.equal(effective.channelLabel, 'eng-releases');

    const snapshot = snapshotFromEffectiveConfig(effective, 1);
    assert.equal(snapshot.channelLabel, 'eng-releases');

    const tool = createLookupChannelBriefTool(snapshot);
    const { brief } = await tool.run({ input: { channelId: 'C0LABELCHAN' } });
    assert.match(brief, /Channel: #eng-releases\./);
    assert.match(brief, /Channel instructions: End with a Ship checklist\./);
  } finally {
    store.close();
  }
});

test('lookup_channel_brief denies lookups for any channel other than the assigned one', async () => {
  const tool = createLookupChannelBriefTool(assignmentFixture());
  await assert.rejects(
    async () => {
      await tool.run({ input: { channelId: 'C0OTHERCHAN' } });
    },
    /Denied: lookup_channel_brief is restricted to the assigned channel\./,
  );
});
