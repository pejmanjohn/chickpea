import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { OUT_OF_USAGE_CAUSE_KINDS, type PlatformFundingRefusal } from '../src/config/platform-funding.ts';
import * as creditsAsk from '../src/slack/credits-ask.ts';
import * as refusalReply from '../src/slack/funding-refusal-reply.ts';
import { dailyLimitNoticeMessage, usageAlertMessage, type UsageAlert } from '../src/slack/usage-alerts.ts';
import { CREDITS_EXHAUSTED_TEXT, dailyLimitText } from '../src/slack/web-client-presenter.ts';
import type { UsageMicros } from '../src/usage/usage-display.ts';

const HIDDEN_WORDS = /\b(credits?|steps|multiplier|cache|prefix|working reply|refunds?|markup)\b/i;

const base: UsageAlert = {
  threshold: 75,
  usedMicros: 180_000_000 as UsageMicros,
  includedMicros: 240_000_000 as UsageMicros,
  periodEnd: new Date(Date.UTC(2026, 10, 7)),
  onPacePercent: 80,
  runOutAt: null,
  nextPlan: null,
  planPageUrl: 'https://admin.chickpea.example/admin/plan',
};

const ALERTS: UsageAlert[] = [
  base,
  { ...base, runOutAt: new Date(Date.UTC(2026, 10, 2)) },
  { ...base, threshold: 90 },
  { ...base, threshold: 90, runOutAt: new Date(Date.UTC(2026, 10, 2)) },
  { ...base, threshold: 90, nextPlan: { key: 'plan_200', priceCents: 20_000 } },
  { ...base, threshold: 100 },
];

const REFUSALS: PlatformFundingRefusal[] = [
  { kind: 'credits_exhausted' },
  ...OUT_OF_USAGE_CAUSE_KINDS.map((kind) => ({
    kind: 'credits_exhausted', cause: { kind, limitCents: 5_000, plansFromCents: 2_500, bonusPercent: 20 },
  }) as PlatformFundingRefusal),
  ...(['workspace', 'fleet'] as const).map((scope) => ({ kind: 'daily_limit', scope, resumesAt: Date.UTC(2026, 10, 5) }) as const),
];

/** Every string a refusal shows: the thread reply, the Owners line, the Owner's private reply and its buttons, and the DM. */
async function refusalStrings(refusal: PlatformFundingRefusal): Promise<string[]> {
  const reply = await refusalReply.fundingRefusalReply({
    env: scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_copy' }),
    identity: {
      resolveSlackIdentity: async () => ({ membership: { role: 'owner', status: 'active' } }) as never,
      listMemberships: async () => [],
      listExternalIdentities: async () => [],
      getUser: async () => undefined,
    },
    workspaceId: 'TCOPY1', userId: 'UOWNER1', refusal, publicUrl: 'https://admin.chickpea.example',
  });
  assert.ok(reply?.ownerNote);
  const labels = (blocks: ReadonlyArray<Record<string, unknown>>) => blocks
    .flatMap((block) => block.type === 'actions' ? block.elements as Array<{ text: { text: string } }> : [])
    .map((button) => button.text.text);
  return [
    creditsAsk.fundingRefusalText(refusal),
    ...labels(reply.components.blocks),
    reply.ownerNote.text,
    ...labels(reply.ownerNote.blocks),
    refusalReply.creditsAskOwnerDmText('UMEMBER1', 'CCHANNEL1', refusal),
    refusalReply.creditsAskOwnerDmText('UMEMBER1', 'DDIRECT1', refusal),
  ];
}

function alertStrings(alert: UsageAlert): string[] {
  const message = usageAlertMessage(alert);
  const labels = message.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements as Array<{ text: { text: string } }>)
    .map((button) => button.text.text);
  return [message.text, ...labels];
}

test('no customer string about plan usage names an internal of how usage is metered', async () => {
  const askStrings = [...Object.entries(creditsAsk), ...Object.entries(refusalReply)]
    .filter(([name, value]) => /_(TEXT|LABEL)$/.test(name) && typeof value === 'string')
    .map(([, value]) => value as string);
  assert.ok(askStrings.length >= 3, 'every exported Ask an Owner text and label is covered');
  const strings = [
    CREDITS_EXHAUSTED_TEXT,
    ...askStrings,
    ...(await Promise.all(REFUSALS.map(refusalStrings))).flat(),
    ...ALERTS.flatMap(alertStrings),
    ...(['workspace', 'fleet'] as const).flatMap((scope) => {
      const limit = { scope, resumesAt: Date.UTC(2026, 10, 5) };
      return [
        dailyLimitText(limit),
        dailyLimitText(limit, 'utc'),
        dailyLimitNoticeMessage({ ...limit, resumesAt: new Date(limit.resumesAt), planPageUrl: base.planPageUrl }).text,
      ];
    }),
  ];
  for (const text of strings) assert.doesNotMatch(text, HIDDEN_WORDS);
});

test('the out-of-usage reply, the Owner\'s private reply and the Owner DM speak of usage', async () => {
  for (const text of [
    CREDITS_EXHAUSTED_TEXT,
    ...(await refusalStrings({ kind: 'credits_exhausted' })).filter((text) => text.split(' ').length > 3),
  ]) {
    assert.match(text, /\busage\b/, text);
  }
});
