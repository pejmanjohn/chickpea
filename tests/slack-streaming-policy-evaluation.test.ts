import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  evaluateSlackStreamingPolicy,
  parseSlackStreamingPolicyFixtureSet,
  type SlackStreamingPolicyTrial,
} from '../src/slack/streaming-policy-evaluation.ts';

const fixtures = parseSlackStreamingPolicyFixtureSet(JSON.parse(readFileSync(
  new URL('../fixtures/slack-streaming-policy.json', import.meta.url),
  'utf8',
)));

test('streaming policy fixtures cover positive, negative, and ambiguous boundaries', () => {
  assert.equal(fixtures.fixtures.length, 18);
  assert.deepEqual(
    Object.fromEntries(['clear_positive', 'clear_negative', 'ambiguous'].map((expectation) => [
      expectation,
      fixtures.fixtures.filter((fixture) => fixture.expectation === expectation).length,
    ])),
    { clear_positive: 6, clear_negative: 8, ambiguous: 4 },
  );
  assert.deepEqual(
    new Set(fixtures.fixtures
      .filter((fixture) => fixture.expectation === 'clear_positive')
      .map((fixture) => fixture.category)),
    new Set(['long_explainer', 'draft', 'analysis']),
  );
  assert.deepEqual(
    new Set(fixtures.fixtures
      .filter((fixture) => fixture.expectation === 'clear_negative')
      .map((fixture) => fixture.category)),
    new Set(['short_confirmation', 'structured', 'correction', 'tool_work']),
  );
});

test('streaming policy evaluator passes strong selection, protocol, and latency evidence', () => {
  const trials = fixtures.fixtures.map((fixture, index): SlackStreamingPolicyTrial => {
    const declared = fixture.expectation === 'clear_positive' ||
      (fixture.expectation === 'ambiguous' && index % 2 === 0);
    return {
      fixtureId: fixture.id,
      expectation: fixture.expectation,
      category: fixture.category,
      declared,
      declarationBeforeText: true,
      declarationShapeValid: true,
      contaminationDetected: false,
      offeredFirstVisibleMs: declared ? 500 + index : 1_200 + index,
      ...(declared ? { declarationMs: 250 + index } : {}),
      ...(fixture.expectation === 'clear_positive'
        ? { controlFirstVisibleMs: 1_500 + index }
        : {}),
    };
  });

  const report = evaluateSlackStreamingPolicy(trials);
  assert.equal(report.pass, true);
  assert.deepEqual(report.positive, { total: 6, selected: 6, recall: 1 });
  assert.deepEqual(report.negative, { total: 8, abstained: 8, abstentionRate: 1 });
  assert.deepEqual(report.ambiguous, { total: 4, selected: 2, selectionRate: 0.5 });
  assert.equal(report.protocolViolations, 0);
  assert.equal(report.contaminationCount, 0);
  assert.equal(report.latencyMs.offeredFirstVisible.count, 6);
  assert.equal(report.latencyMs.offeredFirstVisible.p90! < report.latencyMs.controlFirstVisible.p90!, true);
  assert.deepEqual(report.failedFixtureIds, []);
});

test('streaming policy evaluator fails closed on weak decisions, malformed calls, or contamination', () => {
  const trials: SlackStreamingPolicyTrial[] = [
    {
      fixtureId: 'positive_failed', expectation: 'clear_positive', category: 'analysis',
      declared: false, declarationBeforeText: true, declarationShapeValid: true,
      contaminationDetected: false, offeredFirstVisibleMs: 1_000,
      controlFirstVisibleMs: 900,
    },
    {
      fixtureId: 'negative_failed', expectation: 'clear_negative', category: 'tool_work',
      declared: true, declarationBeforeText: false, declarationShapeValid: false,
      contaminationDetected: true, offeredFirstVisibleMs: 1_100, declarationMs: 600,
    },
    {
      fixtureId: 'ambiguous_observed', expectation: 'ambiguous', category: 'decision_note',
      declared: false, declarationBeforeText: true, declarationShapeValid: true,
      contaminationDetected: false, offeredFirstVisibleMs: 800,
    },
  ];

  const report = evaluateSlackStreamingPolicy(trials);
  assert.equal(report.pass, false);
  assert.equal(report.positive.recall, 0);
  assert.equal(report.negative.abstentionRate, 0);
  assert.equal(report.protocolViolations, 1);
  assert.equal(report.contaminationCount, 1);
  assert.deepEqual(report.failedFixtureIds, ['negative_failed', 'positive_failed']);
});

test('streaming policy fixture parser rejects duplicate identities', () => {
  assert.throws(
    () => parseSlackStreamingPolicyFixtureSet({
      schemaVersion: 1,
      fixtures: [
        { id: 'same_fixture', expectation: 'clear_positive', category: 'analysis', prompt: 'A valid prompt.' },
        { id: 'same_fixture', expectation: 'clear_negative', category: 'structured', prompt: 'Another valid prompt.' },
        { id: 'ambiguous_fixture', expectation: 'ambiguous', category: 'decision_note', prompt: 'A third valid prompt.' },
      ],
    }),
    /duplicated/,
  );
});
