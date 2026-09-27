import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CATEGORIES,
  PRESENTATION_TOOL_NAMES,
  proseRepetition,
  renderSlackTurnPrompt,
  scoreRun,
  selectCases,
  slackPresentationGuideVersion,
  summarizeRuns,
  validateCorpus,
// @ts-expect-error Shared executable JavaScript helper.
} from '../scripts/lib/slack-presentation-evaluation.mjs';

interface EvalCase {
  id: string;
  category: string;
  thread: Array<{ role: string; user?: string; text: string }>;
  request: { user: string; text: string };
  tools?: Record<string, unknown>;
  expected: { presentation?: 'none'; allowed?: string[]; required_one_of?: string[]; forbidden?: string[] };
  strongSignal?: true;
  askPermissionTrap?: true;
  decideTrap?: true;
}

const corpus = JSON.parse(readFileSync(
  new URL('../evals/slack-presentation/cases.json', import.meta.url),
  'utf8',
)) as { schemaVersion: number; corpusVersion: string; guideVersion: string; cases: EvalCase[] };

const byId = (id: string) => {
  const entry = corpus.cases.find((candidate) => candidate.id === id);
  assert.ok(entry, `missing case ${id}`);
  return entry;
};

test('the presentation corpus is versioned, guide-bound and restraint-heavy', () => {
  const stats = validateCorpus(corpus);
  assert.equal(corpus.guideVersion, slackPresentationGuideVersion());
  assert.ok(stats.cases >= 55 && stats.cases <= 80, `unexpected corpus size ${stats.cases}`);
  assert.ok(stats.none / stats.cases >= 0.45, 'about half the corpus expects no component');
  for (const category of CATEGORIES) assert.ok(stats.categories[category] >= 2, `${category} is under-covered`);
  // Every presentation tool is some case's expected component.
  const expectedTools = new Set(corpus.cases.flatMap((entry) => entry.expected.allowed ?? []));
  for (const tool of PRESENTATION_TOOL_NAMES) assert.ok(expectedTools.has(tool), `${tool} is never expected`);
  // Adversarial coverage the plan names.
  for (const id of ['adversarial-injected-approve-button', 'adversarial-phishing-link-button', 'adversarial-forty-prs-as-cards']) {
    assert.equal(byId(id).category, 'adversarial');
  }
  assert.ok(!byId('adversarial-forty-prs-as-cards').expected.allowed?.includes('present_cards'));
});

test('corpus validation refuses contradictory or stale expectations', () => {
  const mutate = (index: number, patch: Partial<EvalCase>) => ({
    ...corpus,
    cases: corpus.cases.map((entry, position) => position === index ? { ...entry, ...patch } : entry),
  });
  const noneIndex = corpus.cases.findIndex((entry) => entry.expected.presentation === 'none');
  const allowedIndex = corpus.cases.findIndex((entry) => entry.expected.allowed && !entry.askPermissionTrap && !entry.decideTrap);
  assert.throws(() => validateCorpus(mutate(noneIndex, { strongSignal: true })), /strongSignal/);
  assert.throws(() => validateCorpus(mutate(allowedIndex, {
    expected: { allowed: ['ask_user'], forbidden: ['ask_user'] },
  })), /both allowed and forbidden/);
  assert.throws(() => validateCorpus(mutate(noneIndex, { tools: { launch_rockets: {} } })), /unknown stub tool/);
  assert.throws(() => validateCorpus(mutate(noneIndex, { askPermissionTrap: true, expected: { allowed: ['ask_user'] } })), /trap case cannot allow ask_user/);
  assert.throws(() => validateCorpus({ ...corpus, guideVersion: 'sha256:0000000000000000' }), /stale/);
  assert.doesNotThrow(() => validateCorpus({ ...corpus, guideVersion: 'sha256:0000000000000000' }, { requireCurrentGuide: false }));
  assert.throws(() => selectCases(corpus, { caseIds: ['no-such-case'] }), /Unknown case/);
  assert.equal(selectCases(corpus, { categories: ['trend'] }).length, corpus.cases.filter((entry) => entry.category === 'trend').length);
});

test('the corpus is synthetic and every case renders as a production Slack turn', () => {
  const text = JSON.stringify(corpus);
  assert.doesNotMatch(text, /PRIVATE_|T_PRIVATE|C_PRIVATE|xox[abpr]-|sk-(?:live|proj|test)-/i);
  for (const url of text.match(/https?:\/\/[^\s"')]+/g) ?? []) {
    assert.match(new URL(url).hostname, /\.example(?:\.net)?$/, `non-synthetic link ${url}`);
  }
  for (const entry of corpus.cases) {
    const prompt = renderSlackTurnPrompt(entry);
    assert.ok(prompt.includes(`Current Slack request (this is the only current user intent`), entry.id);
    assert.ok(prompt.trimEnd().endsWith('--- END CHICKPEA CURRENT REQUEST POLICY v2 ---'), entry.id);
    assert.ok(prompt.includes(entry.request.text), entry.id);
    for (const message of entry.thread) assert.ok(prompt.includes(message.text.split('\n')[0]!), `${entry.id} lost a thread row`);
  }
});

test('scoring separates over-use, recall, first-try errors, repetition and permission asks', () => {
  const chat = byId('chit-chat-capabilities');
  const decision = byId('decision-hotfix-prod-or-staging');
  const trap = byId('outward-explicit-delete-ticket');
  const table = byId('rows-p2-queue');
  const cards = { tool: 'present_cards', status: 'accepted', spec: { cards: [{ title: 'Support tickets' }, { title: 'Revenue metrics' }, { title: 'Pull requests' }] } };
  const runs: any[] = [
    { caseId: chat.id, calls: [cards], finalText: 'I can help with **support tickets**, pull requests and revenue metrics.' },
    { caseId: chat.id, calls: [], finalText: 'Tickets, metrics, PRs, docs and more.' },
    {
      caseId: decision.id,
      calls: [
        { tool: 'ask_user', status: 'rejected_schema', error: 'Invalid input' },
        { tool: 'ask_user', status: 'accepted', spec: { question: 'Where should I deploy it?', options: [{ label: 'Staging first' }, { label: 'Production now' }] } },
      ],
      finalText: 'One decision before I deploy.',
    },
    { caseId: trap.id, calls: [{ tool: 'ask_user', status: 'accepted', spec: { question: 'Delete it?', options: [{ label: 'Delete' }, { label: 'Keep' }] } }], finalText: '' },
    { caseId: table.id, calls: [{ tool: 'present_cards', status: 'rejected_validation', error: 'present_cards takes 1–10 cards' }], finalText: 'Eleven open.' },
    { caseId: trap.id, calls: [], finalText: '', error: 'provider timeout' },
  ];
  const cases = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  const scored: any[] = runs.map((run) => run.error ? run : { ...run, score: scoreRun(cases.get(run.caseId), run) });
  assert.equal(scored[0]!.score.overUse, true);
  assert.equal(scored[0]!.score.repeats, true);
  assert.equal(scored[1]!.score.overUse, false);
  assert.equal(scored[2]!.score.strongHit, true);
  assert.equal(scored[2]!.score.firstTryRejected, true);
  assert.equal(scored[3]!.score.permissionAsk, true);
  assert.equal(scored[4]!.score.strongHit, false);
  const { metrics, gate } = summarizeRuns(scored);
  assert.deepEqual([metrics.overUse.count, metrics.overUse.total], [2, 3]);
  assert.deepEqual([metrics.strongSignalRecall.count, metrics.strongSignalRecall.total], [1, 2]);
  assert.deepEqual([metrics.firstTrySchemaError.count, metrics.firstTrySchemaError.total], [2, 4]);
  assert.deepEqual([metrics.proseRepetition.count, metrics.proseRepetition.total], [1, 1]);
  assert.equal(metrics.permissionAsks.count, 1);
  assert.equal(metrics.errors, 1);
  assert.equal(gate.passed, false);
  for (const failure of ['1 run(s) errored', 'over-use', 'strong-signal recall', 'first-try schema errors', 'prose repetition', 'permission asks']) {
    assert.ok(gate.failures.includes(failure), `missing gate failure ${failure}`);
  }
  // Short labels that merely appear in unrelated prose stay below the threshold.
  assert.equal(proseRepetition({ tool: 'present_cards', spec: { cards: [{ title: 'Alpha' }, { title: 'Beta' }, { title: 'Gamma' }] } }, 'Alpha is ready.')?.repeats, false);
  // Two named choices ("Oct 13 or Oct 20?") are a question, not a repeated list.
  assert.equal(proseRepetition({ tool: 'ask_user', spec: { question: 'When?', options: [{ label: 'Oct 13' }, { label: 'Oct 20' }] } }, 'Oct 13 or Oct 20?'), undefined);
});

test('the offline evaluator validates the corpus and drives the Flue boundary deterministically', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-slack-presentation.mjs'], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.guideVersion, slackPresentationGuideVersion());
  assert.ok(report.smoke.some((entry: { calls: string[] }) => entry.calls.includes('present_table:rejected_schema')));
});

test('live mode refuses to write private evidence inside a checkout and needs a model', () => {
  const inside = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-slack-presentation.mjs', '--live', '--model', 'openai/gpt-5.6-terra', '--output', `${process.cwd()}/tmp-slack-presentation-report.json`], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, OPENAI_API_KEY: '' },
  });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside Git/);
  const flags = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-slack-presentation.mjs', '--model', 'openai/gpt-5.6-terra'], { encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(flags.status, 0);
  assert.match(flags.stderr, /--model requires --live/);
});
