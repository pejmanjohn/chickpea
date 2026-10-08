import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { InstallationHealth, WorkspaceInstallation } from '../src/config/types.ts';
import type { Membership, MembershipStatus, OrganizationRole, SlackIdentityBinding } from '../src/identity/types.ts';
import type { SlackInstallationExecutionResolver } from '../src/slack/installation-execution.ts';
import { deliverUsageAlert, type UsageAlert } from '../src/slack/usage-alerts.ts';
import type { UsageMicros } from '../src/usage/usage-display.ts';

const TEAM = 'TUSAGE1';
const OTHER_TEAM = 'TOTHER1';
const HOSTED_ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_usage' });
const PLAN_PAGE = 'https://admin.chickpea.example/admin/plan';
const PERIOD_END = new Date(Date.UTC(2026, 10, 7));
const RUN_OUT = new Date(Date.UTC(2026, 10, 2, 15));
const RESETS = 'Usage resets <!date^1794009600^{date_short}|Nov 7, 2026>.';
const RUNS_OUT = 'on pace to run out around <!date^1793631600^{date_short}|Nov 2, 2026>.';

type Block = Record<string, unknown>;

function alert(patch: Partial<UsageAlert> & Pick<UsageAlert, 'threshold'>): UsageAlert {
  return {
    usedMicros: 180_000_000 as UsageMicros,
    includedMicros: 240_000_000 as UsageMicros,
    periodEnd: PERIOD_END,
    onPacePercent: null,
    runOutAt: null,
    nextPlan: null,
    planPageUrl: PLAN_PAGE,
    ...patch,
  };
}

function membership(id: string, role: OrganizationRole, status: MembershipStatus): Membership {
  return { id, organizationId: 'org_usage', userId: `user_${id}`, role, status, createdAt: 1, updatedAt: 1 };
}

function binding(slackUserId: string, membershipId: string, slackTeamId = TEAM): SlackIdentityBinding {
  return {
    id: `binding_${slackUserId}`, provider: 'slack', slackTeamId, slackUserId, userId: `user_${membershipId}`,
    organizationId: 'org_usage', membershipId, betterAuthUserId: null, betterAuthMembershipId: null,
    revision: 1, createdAt: 1, updatedAt: 1,
  };
}

function installation(workspaceId: string, health: InstallationHealth = 'healthy'): WorkspaceInstallation {
  return {
    workspaceId, revision: 1, transportMode: 'direct', runtimeContract: 'chickpea-v1',
    defaultAgentId: 'agent_usage', teamId: workspaceId, health, createdAt: 1, updatedAt: 1,
  };
}

const MEMBERSHIPS = [
  membership('m_owner1', 'owner', 'active'),
  membership('m_owner2', 'owner', 'active'),
  membership('m_suspended', 'owner', 'suspended'),
  membership('m_member', 'member', 'active'),
  membership('m_elsewhere', 'owner', 'active'),
];
const BINDINGS = [
  binding('UOWNER1', 'm_owner1'),
  binding('UOWNER2', 'm_owner2'),
  binding('USUSPENDED', 'm_suspended'),
  binding('UMEMBER1', 'm_member'),
  binding('UELSEWHERE', 'm_elsewhere', OTHER_TEAM),
];

function workspace(options: {
  memberships?: Membership[];
  installations?: WorkspaceInstallation[];
  failDms?: boolean;
  unresolvable?: string[];
} = {}) {
  const reads: string[] = [];
  const resolved: string[] = [];
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const record = (method: string) => async (input: Record<string, unknown>) => {
    calls.push({ method, input });
    if (method === 'conversations.open') {
      if (options.failDms) throw new Error('cannot_dm');
      return { ok: true, channel: { id: `D${String(input.users).slice(1)}` } };
    }
    return { ok: true, ts: '1800000099.000100' };
  };
  const client = {
    conversations: { open: record('conversations.open') },
    chat: { postMessage: record('chat.postMessage') },
  } as unknown as WebClient;
  const installationExecution: SlackInstallationExecutionResolver = async (workspaceId) => {
    resolved.push(workspaceId);
    if (options.unresolvable?.includes(workspaceId)) throw new Error('installation_unavailable');
    return { workspaceId, transportMode: 'direct', sharedAppReads: false, botUserId: 'UCHICKPEA', client };
  };
  return {
    dependencies: {
      identity: {
        listMemberships: async () => { reads.push('memberships'); return options.memberships ?? MEMBERSHIPS; },
        listExternalIdentities: async () => { reads.push('bindings'); return BINDINGS; },
      },
      config: {
        listWorkspaceInstallations: async () => {
          reads.push('installations');
          return options.installations ?? [installation(TEAM)];
        },
      },
      installationExecution,
    },
    reads,
    resolved,
    of: (method: string) => calls.filter((call) => call.method === method).map(({ input }) => input),
  };
}

function quietWarnings(t: TestContext): unknown[][] {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  return warnings;
}

async function sent(usage: UsageAlert): Promise<{ text: string; blocks: Block[] }> {
  const slack = workspace();
  assert.equal(await deliverUsageAlert(HOSTED_ENV, usage, slack.dependencies), 'sent');
  const posted = slack.of('chat.postMessage');
  assert.equal(posted.length, 2, 'one DM to each active Owner');
  assert.deepEqual(posted[1]?.blocks, posted[0]?.blocks, 'both Owners read the same message');
  return { text: String(posted[0]?.text), blocks: posted[0]?.blocks as Block[] };
}

function buttons(blocks: Block[]): Array<Record<string, unknown>> {
  return blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements as Array<Record<string, unknown>>);
}

test('the 75% alert reaches each active Owner of the workspace and no one else', async () => {
  const slack = workspace();
  const usage = alert({ threshold: 75, runOutAt: RUN_OUT });
  assert.equal(await deliverUsageAlert(HOSTED_ENV, usage, slack.dependencies), 'sent');

  assert.deepEqual(slack.of('conversations.open').map(({ users }) => users).sort(), ['UOWNER1', 'UOWNER2']);
  const text = `You've used 75% of your plan ($180 of $240), ${RUNS_OUT}`;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  assert.deepEqual(
    slack.of('chat.postMessage').sort((a, b) => String(a.channel).localeCompare(String(b.channel))),
    [{ channel: 'DOWNER1', text, blocks }, { channel: 'DOWNER2', text, blocks }],
  );
  assert.deepEqual(slack.resolved, [TEAM]);
});

test('without a run-out date the 75% alert says when usage resets', async () => {
  const message = await sent(alert({ threshold: 75 }));
  assert.equal(message.text, `You've used 75% of your plan ($180 of $240). ${RESETS}`);
  assert.deepEqual(buttons(message.blocks), []);
});

test('the alert reads the floored actual percent, not the threshold it crossed', async () => {
  const message = await sent(alert({ threshold: 75, usedMicros: 187_000_000 as UsageMicros }));
  assert.equal(message.text, `You've used 77% of your plan ($187 of $240). ${RESETS}`);
});

test('just under the whole plan the alert reads 99% and a used amount below the plan', async () => {
  const message = await sent(alert({ threshold: 90, usedMicros: 239_999_999 as UsageMicros }));
  assert.equal(message.text,
    `You've used 99% of your plan ($239.99 of $240). ${RESETS} Add extra usage or upgrade so nothing stops.`);
});

test('the 90% alert with auto-upgrade on names the next plan and offers to turn it off', async () => {
  const message = await sent(alert({
    threshold: 90,
    usedMicros: 216_000_000 as UsageMicros,
    runOutAt: RUN_OUT,
    nextPlan: { key: 'plan_200', priceCents: 20_000 },
  }));
  assert.equal(message.text,
    `You've used 90% of your plan ($216 of $240), ${RUNS_OUT} ` +
    "When it runs out we'll move you to the $200 plan so nothing stops. " +
    'You can add extra usage instead, or turn auto-upgrade off.');
  assert.deepEqual(message.blocks[0], { type: 'section', text: { type: 'mrkdwn', text: message.text } });
  assert.deepEqual(buttons(message.blocks), [
    {
      type: 'button', action_id: 'chickpea.usage.v1.add_extra_usage',
      text: { type: 'plain_text', text: 'Add extra usage', emoji: false }, url: PLAN_PAGE,
    },
    {
      type: 'button', action_id: 'chickpea.usage.v1.turn_off_auto_upgrade',
      text: { type: 'plain_text', text: 'Turn off auto-upgrade', emoji: false }, url: PLAN_PAGE,
    },
  ]);
});

const UPGRADE_BUTTONS = [
  {
    type: 'button', action_id: 'chickpea.usage.v1.upgrade',
    text: { type: 'plain_text', text: 'Upgrade', emoji: false }, url: PLAN_PAGE,
  },
  {
    type: 'button', action_id: 'chickpea.usage.v1.add_extra_usage',
    text: { type: 'plain_text', text: 'Add extra usage', emoji: false }, url: PLAN_PAGE,
  },
];

test('the 90% alert without a next plan asks for extra usage or an upgrade', async () => {
  const message = await sent(alert({ threshold: 90, usedMicros: 216_000_000 as UsageMicros }));
  assert.equal(message.text,
    `You've used 90% of your plan ($216 of $240). ${RESETS} Add extra usage or upgrade so nothing stops.`);
  assert.deepEqual(buttons(message.blocks), UPGRADE_BUTTONS);
});

test('the 100% alert says the plan\'s usage is used up and offers extra usage or an upgrade', async () => {
  const message = await sent(alert({ threshold: 100, usedMicros: 240_000_000 as UsageMicros }));
  assert.equal(message.text, "You've used all of your plan's usage. Add extra usage or upgrade to keep going.");
  assert.deepEqual(buttons(message.blocks), UPGRADE_BUTTONS);
});

test('a workspace with no active Owner is not messaged', async () => {
  const slack = workspace({ memberships: MEMBERSHIPS.filter(({ id }) => id !== 'm_owner1' && id !== 'm_owner2') });
  assert.equal(await deliverUsageAlert(HOSTED_ENV, alert({ threshold: 75 }), slack.dependencies), 'no_owner');
  assert.deepEqual(slack.of('chat.postMessage'), []);
});

test('an alert no Owner could be messaged reports no Owner', async (t) => {
  const warnings = quietWarnings(t);
  const slack = workspace({ failDms: true });
  assert.equal(await deliverUsageAlert(HOSTED_ENV, alert({ threshold: 90 }), slack.dependencies), 'no_owner');
  assert.equal(slack.of('conversations.open').length, 2);
  assert.deepEqual(slack.of('chat.postMessage'), []);
  assert.deepEqual(warnings, [['[chickpea] An Owner could not be messaged'], ['[chickpea] An Owner could not be messaged']]);
});

test('a revoked workspace installation is skipped', async () => {
  const slack = workspace({ installations: [installation(TEAM, 'revoked')] });
  assert.equal(await deliverUsageAlert(HOSTED_ENV, alert({ threshold: 100 }), slack.dependencies), 'no_owner');
  assert.deepEqual(slack.resolved, []);
  assert.deepEqual(slack.of('conversations.open'), []);
});

test('a workspace whose Slack cannot be reached does not stop the others', async (t) => {
  const warnings = quietWarnings(t);
  const slack = workspace({ installations: [installation(OTHER_TEAM), installation(TEAM)], unresolvable: [OTHER_TEAM] });
  assert.equal(await deliverUsageAlert(HOSTED_ENV, alert({ threshold: 75 }), slack.dependencies), 'sent');
  assert.deepEqual(slack.resolved, [OTHER_TEAM, TEAM]);
  assert.deepEqual(slack.of('conversations.open').map(({ users }) => users).sort(), ['UOWNER1', 'UOWNER2']);
  assert.deepEqual(warnings, [["[chickpea] A usage alert could not reach this workspace's Owners"]]);
});

test('installations that cannot be read report no Owner, so the host tries again', async (t) => {
  const warnings = quietWarnings(t);
  const slack = workspace();
  const dependencies = {
    ...slack.dependencies,
    config: { listWorkspaceInstallations: async () => { throw new Error('state_unavailable'); } },
  };
  assert.equal(await deliverUsageAlert(HOSTED_ENV, alert({ threshold: 75 }), dependencies), 'no_owner');
  assert.deepEqual(slack.of('conversations.open'), []);
  assert.deepEqual(warnings, [['[chickpea] A usage alert could not read the workspace installations']]);
});

test('standalone never sends usage alerts and reads nothing', async () => {
  for (const env of [undefined, {}, { CHICKPEA_TENANCY: 'standalone' }]) {
    const slack = workspace();
    assert.equal(await deliverUsageAlert(env, alert({ threshold: 100 }), slack.dependencies), 'no_owner');
    assert.deepEqual(slack.reads, [], JSON.stringify(env));
    assert.deepEqual(slack.resolved, [], JSON.stringify(env));
    assert.deepEqual(slack.of('conversations.open'), [], JSON.stringify(env));
  }
});
