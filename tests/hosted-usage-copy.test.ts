import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as creditsAsk from '../src/slack/credits-ask.ts';
import { usageAlertMessage, type UsageAlert } from '../src/slack/usage-alerts.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
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

function alertStrings(alert: UsageAlert): string[] {
  const message = usageAlertMessage(alert);
  const labels = message.blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements as Array<{ text: { text: string } }>)
    .map((button) => button.text.text);
  return [message.text, ...labels];
}

test('no customer string about plan usage names an internal of how usage is metered', () => {
  const askStrings = Object.entries(creditsAsk)
    .filter(([name, value]) => /_(TEXT|LABEL)$/.test(name) && typeof value === 'string')
    .map(([, value]) => value as string);
  assert.ok(askStrings.length >= 4, 'every exported Ask an admin text and label is covered');
  const strings = [
    CREDITS_EXHAUSTED_TEXT,
    ...askStrings,
    creditsAsk.creditsAskOwnerDmText('UMEMBER1', 'CCHANNEL1'),
    creditsAsk.creditsAskOwnerDmText('UMEMBER1', 'DDIRECT1'),
    ...ALERTS.flatMap(alertStrings),
  ];
  for (const text of strings) assert.doesNotMatch(text, HIDDEN_WORDS);
});

test('the out-of-usage reply, the Owner hint and the Owner DM speak of usage', () => {
  for (const text of [
    CREDITS_EXHAUSTED_TEXT,
    creditsAsk.CREDITS_OWNER_HINT_TEXT,
    creditsAsk.creditsAskOwnerDmText('UMEMBER1', 'CCHANNEL1'),
  ]) {
    assert.match(text, /\busage\b/, text);
  }
});
