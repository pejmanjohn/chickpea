import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { BillingActor } from '../src/config/platform-billing.ts';
import type { InstallationHealth, WorkspaceInstallation } from '../src/config/types.ts';
import type { Membership, MembershipStatus, OrganizationRole, SlackIdentityBinding } from '../src/identity/types.ts';
import type { SlackInstallationExecutionResolver } from '../src/slack/installation-execution.ts';
import {
  dailyLimitNoticeMessage,
  deliverDailyLimitNotice,
  deliverOwnerBillingNotice,
  deliverUsageAlert,
  ownerBillingNoticeMessage,
  usageAlertMessage,
  type DailyLimitNotice,
  type OwnerBillingNotice,
  type UsageAlert,
} from '../src/slack/usage-alerts.ts';
import { formatCard, type UsageMicros } from '../src/usage/usage-display.ts';

const TEAM = 'TUSAGE1';
const OTHER_TEAM = 'TOTHER1';
const HOSTED_ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_usage' });
const PLAN_PAGE = 'https://admin.chickpea.example/admin/plan';
const PERIOD_END = new Date(Date.UTC(2026, 10, 7));
const RUN_OUT = new Date(Date.UTC(2026, 10, 2, 15));
const RESETS = 'Usage resets <!date^1794009600^{date_short}|Nov 7, 2026>.';
const RUNS_OUT = 'on pace to run out around <!date^1793631600^{date_short}|Nov 2, 2026>.';
const NOV_7 = '<!date^1794009600^{date_short}|Nov 7, 2026>';

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

function button(name: string, label: string, url: string, primary = false): Record<string, unknown> {
  return {
    type: 'button', action_id: `chickpea.usage.v1.${name}`,
    text: { type: 'plain_text', text: label, emoji: false }, url, ...(primary ? { style: 'primary' } : {}),
  };
}

const at = (step: string) => `${PLAN_PAGE}?step=${step}`;

const UPGRADE_BUTTONS = [
  button('upgrade', 'Upgrade', at('upgrade')),
  button('add_extra_usage', 'Add extra usage', at('add')),
];

test('the 90% alert without auto top-up asks for extra usage or an upgrade, each opening its step', async () => {
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

test('an older host\'s alert literal, with nextPlan and no auto top-up, reads today\'s copy without auto-upgrade', () => {
  const older: UsageAlert = {
    threshold: 90,
    usedMicros: 216_000_000 as UsageMicros,
    includedMicros: 240_000_000 as UsageMicros,
    periodEnd: PERIOD_END,
    onPacePercent: null,
    runOutAt: null,
    nextPlan: null,
    planPageUrl: PLAN_PAGE,
  };
  assert.equal(usageAlertMessage({ ...older, threshold: 75 }).text, `You've used 90% of your plan ($216 of $240). ${RESETS}`);
  assert.deepEqual(buttons([...usageAlertMessage({ ...older, threshold: 75 }).blocks]), []);
  for (const nextPlan of [null, { key: 'plan_200', priceCents: 20_000 }]) {
    const ninety = usageAlertMessage({ ...older, nextPlan });
    assert.equal(ninety.text, `You've used 90% of your plan ($216 of $240). ${RESETS} Add extra usage or upgrade so nothing stops.`);
    assert.deepEqual(buttons([...ninety.blocks]), UPGRADE_BUTTONS);
  }
  const hundred = usageAlertMessage({ ...older, threshold: 100 });
  assert.equal(hundred.text, "You've used all of your plan's usage. Add extra usage or upgrade to keep going.");
  assert.deepEqual(buttons([...hundred.blocks]), UPGRADE_BUTTONS);
});

const TOP_UP_ON = { enabled: true, packCents: 5_000, limitCents: 20_000, usedCents: 5_000 } as const;
const TOP_UP_OFF = { enabled: false } as const;

test('the 75% alert with auto top-up on says it adds a pack so nothing stops', () => {
  const message = usageAlertMessage(alert({ threshold: 75, autoTopUp: TOP_UP_ON }));
  assert.equal(message.text,
    `You've used 75% of your plan ($180 of $240). ${RESETS} If it runs out, auto top-up adds $50 so nothing stops.`);
  assert.deepEqual(buttons([...message.blocks]), []);
});

test('the 75% alert with auto top-up off says the Agents pause until renewal and links the plain Plan page', () => {
  const message = usageAlertMessage(alert({ threshold: 75, autoTopUp: TOP_UP_OFF }));
  assert.equal(message.text,
    `You've used 75% of your plan ($180 of $240). ${RESETS} If it runs out, your Agents pause until your plan renews ${NOV_7}.`);
  assert.deepEqual(buttons([...message.blocks]), [button('see_options', 'See options', PLAN_PAGE)]);
});

test('the 90% alert with auto top-up on names the pack and what the limit still allows', () => {
  const message = usageAlertMessage(alert({ threshold: 90, usedMicros: 216_000_000 as UsageMicros, autoTopUp: TOP_UP_ON }));
  assert.equal(message.text,
    `You've used 90% of your plan ($216 of $240). ${RESETS} When it runs out, auto top-up adds $50 of extra usage ` +
    'so nothing stops. It can add up to $150 this month.');
  assert.deepEqual(buttons([...message.blocks]), [button('change_auto_top_up', 'Change auto top-up', at('auto-top-up'))]);
});

test('the 90% alert with auto top-up at its limit says the Agents pause, and offers Raise limit first', () => {
  for (const usedCents of [20_000, 25_000]) {
    const message = usageAlertMessage(alert({ threshold: 90, usedMicros: 216_000_000 as UsageMicros, autoTopUp: { ...TOP_UP_ON, usedCents } }));
    assert.equal(message.text,
      `You've used 90% of your plan ($216 of $240). ${RESETS} When it runs out, your Agents pause until ${NOV_7}, because auto top-up ` +
      'reached its limit for this month. Raise the limit or upgrade so nothing stops.', String(usedCents));
    assert.deepEqual(buttons([...message.blocks]), [
      button('raise_limit', 'Raise limit', at('raise-limit'), true), button('upgrade', 'Upgrade plan', at('upgrade')),
    ]);
  }
});

test('the 90% alert with auto top-up off offers usage first, then an upgrade or auto top-up', () => {
  const message = usageAlertMessage(alert({ threshold: 90, usedMicros: 216_000_000 as UsageMicros, autoTopUp: TOP_UP_OFF }));
  assert.equal(message.text,
    `You've used 90% of your plan ($216 of $240). ${RESETS} When it runs out, your Agents pause until ${NOV_7}. ` +
    'Add usage, upgrade, or turn on auto top-up so nothing stops.');
  assert.deepEqual(buttons([...message.blocks]), [
    button('add_extra_usage', 'Add usage', at('add'), true),
    button('upgrade', 'Upgrade plan', at('upgrade')),
    button('turn_on_auto_top_up', 'Turn on auto top-up', at('auto-top-up')),
  ]);
});

test('a Plan page URL that does not parse drops the buttons that open a step and keeps the plain one', () => {
  const broken = 'admin/plan';
  assert.deepEqual(buttons([...usageAlertMessage(alert({ threshold: 90, planPageUrl: broken })).blocks]), []);
  assert.equal(usageAlertMessage(alert({ threshold: 90, planPageUrl: broken })).blocks.length, 1);
  assert.deepEqual(
    buttons([...usageAlertMessage(alert({ threshold: 75, autoTopUp: TOP_UP_OFF, planPageUrl: broken })).blocks]),
    [button('see_options', 'See options', broken)],
  );
});

const FULL = { threshold: 100, usedMicros: 240_000_000 as UsageMicros } as const;
const FORTY = 40_000_000 as UsageMicros;
const PLATFORM_RATES = { funding: 'platform', taskFeeMicros: 100_000 as UsageMicros, typicalTaskMicros: 400_000 as UsageMicros } as const;

test('the 100% alert on extra usage says how much is left and about how many tasks it covers, with no buttons', () => {
  const message = usageAlertMessage(alert({ ...FULL, extraUsage: { remainingMicros: FORTY, tasks: PLATFORM_RATES } }));
  assert.equal(message.text, "You've used all of your plan's usage for this month. " +
    'Your Agents are now using extra usage, with $40 left, about 80 tasks.');
  assert.deepEqual(message.blocks, [{ type: 'section', text: { type: 'mrkdwn', text: message.text } }]);
});

test('the 100% alert counts tasks exactly on an own key, and says under 10 for a little', () => {
  const ownKey = { funding: 'own_key', taskFeeMicros: 300_000 as UsageMicros, typicalTaskMicros: 400_000 as UsageMicros } as const;
  assert.match(usageAlertMessage(alert({ ...FULL, extraUsage: { remainingMicros: FORTY, tasks: ownKey } })).text,
    / with \$40 left, 133 tasks\.$/);
  assert.match(
    usageAlertMessage(alert({ ...FULL, extraUsage: { remainingMicros: 4_000_000 as UsageMicros, tasks: PLATFORM_RATES } })).text,
    / with \$4 left, under 10 tasks\.$/,
  );
});

test('the 100% alert counts extra usage\'s tasks at its own fee where the host prices it apart from the plan\'s', () => {
  const fees = { taskFeeMicros: 250_000 as UsageMicros, extraUsageTaskFeeMicros: 300_000 as UsageMicros, typicalTaskMicros: 150_000 as UsageMicros };
  assert.match(usageAlertMessage(alert({ ...FULL, extraUsage: { remainingMicros: FORTY, tasks: { funding: 'platform', ...fees } } })).text,
    / with \$40 left, about 80 tasks\.$/, 'a typical task from extra usage is 45¢, not 40¢');
  assert.match(usageAlertMessage(alert({ ...FULL, extraUsage: { remainingMicros: FORTY, tasks: { funding: 'own_key', ...fees } } })).text,
    / with \$40 left, 133 tasks\.$/);
});

test('the 100% alert on extra usage ends at the amount left when tasks cannot be counted', () => {
  const free = { funding: 'own_key', taskFeeMicros: 0 as UsageMicros, typicalTaskMicros: 400_000 as UsageMicros } as const;
  for (const extraUsage of [{ remainingMicros: FORTY }, { remainingMicros: FORTY, tasks: free }]) {
    assert.equal(usageAlertMessage(alert({ ...FULL, extraUsage })).text,
      "You've used all of your plan's usage for this month. Your Agents are now using extra usage, with $40 left.");
  }
});

test('the 100% alert with no extra usage left asks for extra usage or an upgrade', () => {
  const message = usageAlertMessage(alert({ ...FULL, extraUsage: { remainingMicros: 0 as UsageMicros, tasks: PLATFORM_RATES } }));
  assert.equal(message.text, "You've used all of your plan's usage. Add extra usage or upgrade to keep going.");
  assert.deepEqual(buttons([...message.blocks]), UPGRADE_BUTTONS);
});

const VISA = { brand: 'visa', last4: '4242' };

type WithoutPage<N> = N extends unknown ? Omit<N, 'planPageUrl'> : never;

function notice(value: WithoutPage<OwnerBillingNotice>) {
  return ownerBillingNoticeMessage({ ...value, planPageUrl: PLAN_PAGE } as OwnerBillingNotice);
}

function context(blocks: readonly Block[]): string[] {
  return blocks.filter((block) => block.type === 'context')
    .flatMap((block) => (block.elements as Array<{ text: string }>).map(({ text }) => text));
}

function sections(blocks: readonly Block[]): string[] {
  return blocks.filter((block) => block.type === 'section').map((block) => (block.text as { text: string }).text);
}

test('a card reads by its brand and last four digits, an unknown brand reads as a card, and last digits that aren\'t four digits read as no card', () => {
  const brands = ['visa', 'mastercard', 'amex', 'discover', 'diners', 'jcb', 'unionpay', 'link', 'constructor', 'VISA'];
  assert.deepEqual(brands.map((brand) => formatCard({ brand, last4: '4242' })), [
    'Visa ending 4242', 'Mastercard ending 4242', 'American Express ending 4242', 'Discover ending 4242',
    'Diners Club ending 4242', 'JCB ending 4242', 'UnionPay ending 4242', 'Card ending 4242', 'Card ending 4242', 'Visa ending 4242',
  ]);
  assert.equal(formatCard(null), null);
  for (const last4 of ['<!here>', '42', '42424']) assert.equal(formatCard({ brand: 'visa', last4 }), null, last4);
  assert.equal(sections([...ownerBillingNoticeMessage({ kind: 'top_up_declined', card: { brand: 'visa', last4: '<!here>' }, planPageUrl: PLAN_PAGE }).blocks])[0],
    "Auto top-up couldn't charge your card. The card was declined, so your Agents are paused.");
});

const ADDED = {
  kind: 'top_up_added', packCents: 5_000, usedCents: 10_000, limitCents: 20_000, validMonths: 12, card: VISA,
  receiptUrl: 'https://pay.stripe.example/receipts/r_1',
} as const;

test('a top-up under the limit names the card, how long the usage keeps, the limit used, and links the receipt', () => {
  const message = notice(ADDED);
  assert.equal(message.text, 'Auto top-up added $50 of extra usage, so your Agents keep working.');
  assert.deepEqual(sections(message.blocks), [message.text]);
  assert.deepEqual(context(message.blocks), ['Charged to Visa ending 4242, plus tax. Extra usage keeps 12 months while ' +
    "you have a plan. That's $100 of your $200 limit this month."]);
  assert.deepEqual(buttons([...message.blocks]), [button('view_receipt', 'View receipt', ADDED.receiptUrl)]);
});

test('a top-up that reaches the limit says so and offers to raise it, with no receipt unless it is https', () => {
  const message = notice({ ...ADDED, usedCents: 20_000, card: null, receiptUrl: 'http://pay.stripe.example/receipts/r_1' });
  assert.deepEqual(context(message.blocks), ['Charged to your card, plus tax. Extra usage keeps 12 months while ' +
    "you have a plan. That's your $200 limit for this month."]);
  assert.deepEqual(buttons([...message.blocks]), [button('raise_limit', 'Raise limit', at('raise-limit'))]);
});

test('a top-up that leaves no room for another pack offers to raise the limit beside the receipt', () => {
  const message = notice({ ...ADDED, usedCents: 17_500 });
  assert.match(context(message.blocks)[0] ?? '', /That's \$175 of your \$200 limit this month\.$/);
  assert.deepEqual(buttons([...message.blocks]), [
    button('view_receipt', 'View receipt', ADDED.receiptUrl),
    button('raise_limit', 'Raise limit', at('raise-limit')),
  ]);
});

test('reaching the top-up limit says the Agents are paused until renewal and compares the next plan', () => {
  const message = notice({
    kind: 'top_up_limit', limitCents: 5_000, usedCents: 5_000, resumesAt: PERIOD_END,
    plan: { priceCents: 5_000, includedMicros: 60_000_000 as UsageMicros },
    nextPlan: { priceCents: 10_000, includedMicros: 120_000_000 as UsageMicros },
  });
  assert.deepEqual(sections(message.blocks), [
    "Your workspace has used this month's usage and its $50 auto top-up, so your Agents are paused until " +
      `${NOV_7}.`,
    'Your $50 plan and $50 of top-ups covered $110 of usage this month. The $100 plan includes $120 of usage a month.',
  ]);
  assert.equal(message.text, sections(message.blocks)[0]);
  assert.deepEqual(buttons([...message.blocks]), [
    button('upgrade', 'Upgrade to $100', at('upgrade'), true),
    button('raise_limit', 'Raise limit', at('raise-limit')),
  ]);
});

test('reaching the top-up limit compares the next plan\'s lower task fee where the host gives two, and says it covers this month only when it does', () => {
  const detail = (plan: number, used: number, next: number, taskFees?: { taskFeeMicros: UsageMicros; extraUsageTaskFeeMicros?: UsageMicros }) =>
    sections(notice({
      kind: 'top_up_limit', limitCents: used * 100, usedCents: used * 100, resumesAt: PERIOD_END,
      plan: { priceCents: plan * 100, includedMicros: plan * 1_000_000 as UsageMicros },
      nextPlan: { priceCents: next * 100, includedMicros: next * 1_000_000 as UsageMicros },
      ...(taskFees ? { taskFees } : {}),
    }).blocks)[1];
  const twoFees = { taskFeeMicros: 250_000 as UsageMicros, extraUsageTaskFeeMicros: 300_000 as UsageMicros };
  assert.equal(detail(50, 50, 100, twoFees),
    'Your $50 plan and $50 of top-ups covered $100 of usage this month. The $100 plan covers that as plan usage, at 25¢ a task instead of 30¢.');
  assert.equal(detail(200, 200, 300, twoFees),
    'Your $200 plan and $200 of top-ups covered $400 of usage this month. The $300 plan includes $300 of usage a month, at 25¢ a task instead of 30¢.');
  for (const sameFee of [undefined, { taskFeeMicros: 300_000 as UsageMicros }, { taskFeeMicros: 300_000 as UsageMicros, extraUsageTaskFeeMicros: 300_000 as UsageMicros }]) {
    assert.equal(detail(50, 50, 100, sameFee),
      'Your $50 plan and $50 of top-ups covered $100 of usage this month. The $100 plan includes $100 of usage a month.');
  }
});

test('reaching the top-up limit with no renewal or next plan offers only to raise the limit', () => {
  const message = notice({ kind: 'top_up_limit', limitCents: 5_000, usedCents: 5_000, resumesAt: null });
  assert.deepEqual(sections(message.blocks),
    ["Your workspace has used this month's usage and its $50 auto top-up, so your Agents are paused."]);
  assert.deepEqual(buttons([...message.blocks]), [button('raise_limit', 'Raise limit', at('raise-limit'), true)]);
});

test('a declined top-up names the card and offers to update it or try again', () => {
  const message = notice({ kind: 'top_up_declined', card: { brand: 'amex', last4: '0005' } });
  assert.equal(message.text,
    "Auto top-up couldn't charge American Express ending 0005. The card was declined, so your Agents are paused.");
  assert.deepEqual(buttons([...message.blocks]), [
    button('update_card', 'Update card', at('card'), true),
    button('try_again', 'Try again', at('card')),
  ]);
  assert.equal(notice({ kind: 'top_up_declined' }).text,
    "Auto top-up couldn't charge your card. The card was declined, so your Agents are paused.");
});

test('a top-up the bank wants confirmed asks the Owner to confirm the payment', () => {
  const message = notice({ kind: 'top_up_unconfirmed', amountCents: 5_000 });
  assert.equal(message.text,
    'Your bank wants you to confirm a $50 auto top-up charge. Confirm it to keep your Agents working.');
  assert.deepEqual(buttons([...message.blocks]), [button('confirm_payment', 'Confirm payment', at('card'), true)]);
});

test('incomplete billing details ask the Owner to update them', () => {
  const message = notice({ kind: 'billing_details' });
  assert.equal(message.text, "Auto top-up couldn't add usage because your billing details are incomplete. " +
    'Update them to keep your Agents working.');
  assert.deepEqual(buttons([...message.blocks]), [button('update_billing_details', 'Update billing details', at('card'), true)]);
});

const BY_OWNER1: BillingActor = { membershipId: 'm_owner1', slackUserId: 'UOWNER1' };

test('an auto top-up change names the Owner who made it and what it now does', () => {
  const changed = (change: Extract<OwnerBillingNotice, { kind: 'auto_top_up_changed' }>['change'], by = BY_OWNER1) =>
    notice({ kind: 'auto_top_up_changed', by, change });
  const openPlan = [button('open_plan', 'Open Plan', PLAN_PAGE)];
  const cases: Array<[ReturnType<typeof changed>, string, unknown[]]> = [
    [changed({ kind: 'off' }),
      '<@UOWNER1> turned off auto top-up. When usage runs out, your Agents pause until your plan renews.', openPlan],
    [changed({ kind: 'on', packCents: 5_000, limitCents: 10_000 }),
      '<@UOWNER1> turned on auto top-up. When usage runs out, it adds $50 of extra usage, up to $100 a month.', openPlan],
    [changed({ kind: 'changed', packCents: 5_000, limitCents: 10_000, previous: { packCents: 5_000, limitCents: 5_000 } }),
      '<@UOWNER1> raised the auto top-up limit to $100 a month.', []],
    [changed({ kind: 'changed', packCents: 5_000, limitCents: 5_000, previous: { packCents: 5_000, limitCents: 10_000 } }),
      '<@UOWNER1> lowered the auto top-up limit to $50 a month.', []],
    [changed({ kind: 'changed', packCents: 2_500, limitCents: 10_000, previous: { packCents: 5_000, limitCents: 5_000 } }),
      '<@UOWNER1> changed auto top-up. When usage runs out, it adds $25 of extra usage, up to $100 a month.', openPlan],
    [changed({ kind: 'changed', packCents: 5_000, limitCents: 10_000 }, { membershipId: 'm_owner1', slackUserId: null }),
      'An Owner changed auto top-up. When usage runs out, it adds $50 of extra usage, up to $100 a month.', openPlan],
  ];
  for (const [message, text, expected] of cases) {
    assert.equal(message.text, text);
    assert.deepEqual(buttons([...message.blocks]), expected, text);
  }
});

test('running out says the Agents are paused until renewal and offers usage, an upgrade, or auto top-up', () => {
  const message = notice({ kind: 'out', resumesAt: PERIOD_END });
  assert.equal(message.text, `Your workspace is out of usage, so your Agents are paused until your plan renews ${NOV_7}.`);
  assert.deepEqual(buttons([...message.blocks]), [
    button('add_extra_usage', 'Add usage', at('add'), true),
    button('upgrade', 'Upgrade plan', at('upgrade')),
    button('turn_on_auto_top_up', 'Turn on auto top-up', at('auto-top-up')),
  ]);
});

test('running out as the plan ends says the Agents are paused and offers only usage', () => {
  const message = notice({ kind: 'out', resumesAt: null });
  assert.equal(message.text, 'Your workspace is out of usage, so your Agents are paused.');
  assert.deepEqual(buttons([...message.blocks]), [button('add_extra_usage', 'Add usage', at('add'), true)]);
});

const recipients = (slack: ReturnType<typeof workspace>) => slack.of('conversations.open').map(({ users }) => users).sort();

test('an Owner billing notice reaches each active Owner of the workspace and no one else', async () => {
  const slack = workspace();
  const out: OwnerBillingNotice = { kind: 'out', resumesAt: null, planPageUrl: PLAN_PAGE };
  assert.equal(await deliverOwnerBillingNotice(HOSTED_ENV, out, slack.dependencies), 'sent');
  assert.deepEqual(recipients(slack), ['UOWNER1', 'UOWNER2']);
  assert.deepEqual(slack.of('chat.postMessage').map(({ text }) => text), [
    'Your workspace is out of usage, so your Agents are paused.',
    'Your workspace is out of usage, so your Agents are paused.',
  ]);
});

test('an auto top-up change reaches the other Owners, not the one who made it', async () => {
  const change = { kind: 'off' } as const;
  const byMembership = workspace();
  assert.equal(await deliverOwnerBillingNotice(HOSTED_ENV, {
    kind: 'auto_top_up_changed', by: { membershipId: 'm_owner1', slackUserId: null }, change, planPageUrl: PLAN_PAGE,
  }, byMembership.dependencies), 'sent');
  assert.deepEqual(recipients(byMembership), ['UOWNER2']);

  const bySlackUser = workspace();
  assert.equal(await deliverOwnerBillingNotice(HOSTED_ENV, {
    kind: 'auto_top_up_changed', by: { membershipId: 'm_unbound', slackUserId: 'UOWNER2' }, change, planPageUrl: PLAN_PAGE,
  }, bySlackUser.dependencies), 'sent');
  assert.deepEqual(recipients(bySlackUser), ['UOWNER1']);
});

test('an auto top-up change by the only active Owner reaches no one', async () => {
  const slack = workspace({ memberships: MEMBERSHIPS.filter(({ id }) => id !== 'm_owner2') });
  assert.equal(await deliverOwnerBillingNotice(HOSTED_ENV, {
    kind: 'auto_top_up_changed', by: BY_OWNER1, change: { kind: 'off' }, planPageUrl: PLAN_PAGE,
  }, slack.dependencies), 'no_owner');
  assert.deepEqual(slack.of('conversations.open'), []);
});

test('standalone never sends Owner billing notices', async () => {
  const slack = workspace();
  assert.equal(await deliverOwnerBillingNotice(undefined, { kind: 'billing_details', planPageUrl: PLAN_PAGE }, slack.dependencies),
    'no_owner');
  assert.deepEqual(slack.reads, []);
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

const RESUMES = '<!date^1793836800^{date_short_pretty} at {time}|Nov 5, 2026 at 00:00 UTC>';
const NOTICE: DailyLimitNotice = { scope: 'workspace', resumesAt: new Date(Date.UTC(2026, 10, 5)), planPageUrl: PLAN_PAGE };
const CHOOSE_PLAN = [{
  type: 'button', action_id: 'chickpea.usage.v1.upgrade',
  text: { type: 'plain_text', text: 'Choose a plan', emoji: false }, url: PLAN_PAGE,
}];

test('a workspace at its daily limit tells each active Owner, and no one else, when it resumes', async () => {
  const slack = workspace();
  assert.equal(await deliverDailyLimitNotice(HOSTED_ENV, NOTICE, slack.dependencies), 'sent');

  const text = `This workspace has reached its daily trial limit, so Chickpea is paused until ${RESUMES}. ` +
    'Choose a plan to continue now.';
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements: CHOOSE_PLAN }];
  assert.deepEqual(dailyLimitNoticeMessage(NOTICE), { text, blocks });
  assert.deepEqual(slack.of('conversations.open').map(({ users }) => users).sort(), ['UOWNER1', 'UOWNER2']);
  assert.deepEqual(
    slack.of('chat.postMessage').sort((a, b) => String(a.channel).localeCompare(String(b.channel))),
    [{ channel: 'DOWNER1', text, blocks }, { channel: 'DOWNER2', text, blocks }],
  );
});

test('a workspace paused by the fleet limit is told trial usage is paused, not that it reached its own limit', () => {
  const { text, blocks } = dailyLimitNoticeMessage({ ...NOTICE, scope: 'fleet' });
  assert.equal(text, "Chickpea has paused trial usage for now, so this workspace's requests are paused until " +
    `${RESUMES}. Choose a plan to continue now.`);
  assert.deepEqual(buttons([...blocks]), CHOOSE_PLAN);
});

test('a daily-limit notice reaches no one without an active Owner, or on standalone', async () => {
  const ownerless = workspace({ memberships: MEMBERSHIPS.filter(({ role }) => role !== 'owner') });
  assert.equal(await deliverDailyLimitNotice(HOSTED_ENV, NOTICE, ownerless.dependencies), 'no_owner');
  assert.deepEqual(ownerless.of('chat.postMessage'), []);
  const standalone = workspace();
  assert.equal(await deliverDailyLimitNotice(undefined, NOTICE, standalone.dependencies), 'no_owner');
  assert.deepEqual(standalone.reads, []);
});
