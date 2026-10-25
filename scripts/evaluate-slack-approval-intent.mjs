#!/usr/bin/env node
// Slack approval intent calibration. Offline (default): the corpus contract
// plus a deterministic smoke of the production side call against a stubbed
// provider endpoint. --live: the same side call against real models, with a
// private report and a gate on false approvals and recall.

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

import { configureModelAccessResolver } from '../src/config/model-access.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { bootstrapRuntimeProviders } from '../src/runtime-bootstrap.ts';
import {
  classifySlackManagementApproval,
  SLACK_MANAGEMENT_APPROVAL_INSTRUCTIONS,
  slackManagementApprovalMessage,
} from '../src/slack/interaction-intent.ts';
import { assertNodeVersion } from './lib/node-version.mjs';
import { outsideGit } from './lib/private-evidence.mjs';

const CORPUS_PATH = new URL('../evals/slack-approval-intent/cases.json', import.meta.url);
const LABELS = ['approve', 'decline', 'other'];
const MINIMUM_CASES = { approve: 15, decline: 8, other: 12 };
const REQUIRED_OTHER_CATEGORIES = ['conditional', 'question', 'quote', 'injection'];
const SMOKE_MODEL = 'anthropic/claude-sonnet-5';
const MODEL_ENV = 'SLACK_APPROVAL_EVAL_MODEL';
const TARGETS = { falseApprovalsMax: 0, approveRecallMin: 0.9, declineRecallMin: 0.75, failuresMax: 0 };
// Only provider credentials are ever read from --env-file; nothing is printed.
const PROVIDER_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Corpus ─────────────────────────────────────────────────────────────────

function validateCorpus(corpus) {
  assert(corpus.schemaVersion === 1, 'Unknown corpus schema version.');
  const ids = new Set();
  const counts = { approve: 0, decline: 0, other: 0 };
  const otherCategories = new Set();
  for (const entry of corpus.cases) {
    assert(typeof entry.id === 'string' && !ids.has(entry.id), `Duplicate or missing case id: ${entry.id}`);
    ids.add(entry.id);
    assert(LABELS.includes(entry.expected), `${entry.id}: expected must be one of ${LABELS.join(', ')}.`);
    assert(typeof entry.text === 'string' && entry.text.trim(), `${entry.id}: text is required.`);
    assert(typeof corpus.previews[entry.preview] === 'string', `${entry.id}: unknown preview ${entry.preview}.`);
    counts[entry.expected] += 1;
    if (entry.expected === 'other') otherCategories.add(entry.category);
  }
  for (const label of LABELS) {
    assert(counts[label] >= MINIMUM_CASES[label], `The corpus needs at least ${MINIMUM_CASES[label]} ${label} cases.`);
  }
  for (const category of REQUIRED_OTHER_CATEGORIES) {
    assert(otherCategories.has(category), `The corpus needs an other case in category ${category}.`);
  }
  return counts;
}

function caseInput(corpus, entry) {
  return { text: entry.text, preview: corpus.previews[entry.preview] };
}

// ── Offline smoke ──────────────────────────────────────────────────────────

function anthropicStream(text) {
  const usage = { input_tokens: 10, output_tokens: 1 };
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** Every request goes to this stub; it answers `answer(body)`, or fails with HTTP 500 when that is undefined. */
function stubProvider(answer) {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = await new Request(input, init).json();
    bodies.push(body);
    const text = answer(body);
    return text === undefined
      ? new Response('{}', { status: 500 })
      : new Response(anthropicStream(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

function requestTexts(body) {
  const blockText = (content) => typeof content === 'string'
    ? content
    : content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  return {
    system: Array.isArray(body.system) ? blockText(body.system) : body.system,
    messages: body.messages.map(({ role, content }) => ({ role, text: blockText(content) })),
  };
}

async function runOfflineSmoke(corpus, settings) {
  // A stand-in key: every request below goes to the stub, never to Anthropic.
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-key';
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-test-not-a-key' }) });
  const judge = (input) => classifySlackManagementApproval(
    { ...input, requestedModel: SMOKE_MODEL }, undefined, undefined, 10_000, { settings });

  const smoke = [];
  for (const entry of corpus.cases) {
    const input = caseInput(corpus, entry);
    const provider = stubProvider(() => JSON.stringify({ approval: entry.expected }));
    let judgment;
    try {
      judgment = await judge(input);
    } finally {
      provider.restore();
    }
    assert(provider.bodies.length === 1, `${entry.id}: expected one side call, saw ${provider.bodies.length}.`);
    const sent = requestTexts(provider.bodies[0]);
    assert(sent.system === SLACK_MANAGEMENT_APPROVAL_INSTRUCTIONS, `${entry.id}: the instructions were not sent as the system prompt.`);
    assert(sent.messages.length === 1 && sent.messages[0].role === 'user' &&
      sent.messages[0].text === slackManagementApprovalMessage(input),
    `${entry.id}: the judge must see exactly the person's message and the preview.`);
    assert(judgment.approval === entry.expected && judgment.failed === false,
      `${entry.id}: the side call answer was not parsed (${JSON.stringify(judgment)}).`);
    smoke.push({ caseId: entry.id, judged: judgment.approval });
  }

  const exact = stubProvider(() => '{"approval":"other"}');
  try {
    const judgment = await judge({ text: 'approve', preview: corpus.previews.instructions });
    assert(judgment.approval === 'approve' && exact.bodies.length === 0, 'The exact word must approve without a side call.');
  } finally {
    exact.restore();
  }
  for (const [name, answer] of [
    ['provider error', () => undefined],
    ['extra field', () => '{"approval":"approve","because":"they said yes"}'],
    ['prose', () => 'The person approves.'],
  ]) {
    const provider = stubProvider(answer);
    try {
      const judgment = await judge({ text: 'sure', preview: corpus.previews.instructions });
      assert(judgment.approval === 'other', `A ${name} must judge other, not ${judgment.approval}.`);
    } finally {
      provider.restore();
    }
  }
  return smoke;
}

// ── Live ───────────────────────────────────────────────────────────────────

function loadProviderEnv(files) {
  const loadable = new Set(Object.values(PROVIDER_ENV));
  const loaded = [];
  for (const file of files) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(resolve(file), 'utf8')))) {
      if (!loadable.has(name) || !value || process.env[name]) continue;
      process.env[name] = value;
      loaded.push(name);
    }
  }
  return [...new Set(loaded)].sort();
}

function credentialName(model) {
  return PROVIDER_ENV[model.slice(0, model.indexOf('/'))];
}

function summarize(results) {
  const matrix = Object.fromEntries(LABELS.map((label) => [label, { approve: 0, decline: 0, other: 0 }]));
  let failures = 0;
  for (const result of results) {
    matrix[result.expected][result.judged] += 1;
    if (result.failed) failures += 1;
  }
  const total = (label) => LABELS.reduce((sum, judged) => sum + matrix[label][judged], 0);
  const falseApprovals = matrix.decline.approve + matrix.other.approve;
  const approveRecall = total('approve') ? matrix.approve.approve / total('approve') : 0;
  const declineRecall = total('decline') ? matrix.decline.decline / total('decline') : 0;
  const gateFailures = [
    ...(falseApprovals > TARGETS.falseApprovalsMax ? ['false approvals'] : []),
    ...(approveRecall < TARGETS.approveRecallMin ? ['approve recall'] : []),
    ...(declineRecall < TARGETS.declineRecallMin ? ['decline recall'] : []),
    ...(failures > TARGETS.failuresMax ? ['side-call failures'] : []),
  ];
  return { matrix, falseApprovals, approveRecall, declineRecall, failures, gate: { passed: gateFailures.length === 0, failures: gateFailures } };
}

async function runLive(corpus, options, settings) {
  const createdAt = new Date().toISOString();
  // Refuse a report path inside a checkout before any paid call.
  const path = outputPath(options.output, createdAt);
  const loaded = loadProviderEnv(options.envFiles);
  configureModelAccessResolver({
    resolve: async (grant) => {
      const key = process.env[PROVIDER_ENV[grant.providerId]];
      if (!key) throw new Error(`No credential for ${grant.providerId}.`);
      return { apiKey: key };
    },
  });
  const models = options.models.length ? options.models : (process.env[MODEL_ENV] ?? '').split(',').filter(Boolean);
  assert(models.length > 0, `Name a model with --model or ${MODEL_ENV}.`);
  const cases = options.caseIds.length
    ? corpus.cases.filter(({ id }) => options.caseIds.includes(id))
    : corpus.cases;
  assert(cases.length > 0, 'No case matches --case.');
  const report = { kind: 'slack-approval-intent live calibration', corpusVersion: corpus.corpusVersion, createdAt, source: sourceFingerprint(), loadedEnv: loaded, targets: TARGETS, models: [] };
  for (const model of models) {
    const missing = credentialName(model);
    if (!missing || !process.env[missing]) {
      report.models.push({ model, skipped: missing ? `${missing} is not set` : 'unsupported provider', gate: { passed: false, failures: ['skipped'] } });
      continue;
    }
    const results = [];
    for (const entry of cases) {
      const startedAt = performance.now();
      const judgment = await classifySlackManagementApproval(
        { ...caseInput(corpus, entry), requestedModel: model }, undefined, undefined, options.timeoutMs, { settings });
      results.push({
        caseId: entry.id, category: entry.category, expected: entry.expected, judged: judgment.approval,
        failed: judgment.failed, durationMs: Math.round(performance.now() - startedAt),
        ...(judgment.result ? { raw: judgment.result.text, usage: judgment.result.reportedUsage } : {}),
      });
      process.stdout.write(`${model} ${entry.id}: ${judgment.approval}${judgment.approval === entry.expected ? '' : ` (expected ${entry.expected})`}\n`);
    }
    report.models.push({ model, ...summarize(results), results });
  }
  report.gate = { passed: report.models.every(({ gate }) => gate.passed) };
  writePrivateJson(path, report);
  for (const entry of report.models) {
    process.stdout.write(entry.skipped
      ? `${entry.model}: skipped (${entry.skipped})\n`
      : `${entry.model}: false approvals ${entry.falseApprovals}, approve recall ${entry.approveRecall.toFixed(2)}, decline recall ${entry.declineRecall.toFixed(2)}, failures ${entry.failures}; gate ${entry.gate.passed ? 'passed' : `failed (${entry.gate.failures.join(', ')})`}\n`);
  }
  process.stdout.write(`Wrote the private report to ${path}\n`);
  return report;
}

function outputPath(option, createdAt) {
  const target = option
    ? resolve(option)
    : join(homedir(), '.chickpea', 'evals', 'slack-approval-intent', createdAt.replace(/[:.]/g, '-'), 'report.json');
  return outsideGit(target.endsWith('.json') ? target : join(target, 'report.json'));
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.pending`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

function sourceFingerprint() {
  try {
    const root = new URL('..', import.meta.url).pathname;
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
    return { head, dirty };
  } catch {
    return { head: null, dirty: null };
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      live: { type: 'boolean' },
      help: { type: 'boolean' },
      model: { type: 'string', multiple: true },
      case: { type: 'string', multiple: true },
      'timeout-ms': { type: 'string' },
      output: { type: 'string' },
      'env-file': { type: 'string', multiple: true },
    },
  });
  const liveOnly = ['model', 'case', 'timeout-ms', 'output', 'env-file'];
  if (!values.live) {
    const used = liveOnly.filter((name) => values[name] !== undefined);
    assert(used.length === 0, `--${used[0]} requires --live.`);
  }
  const timeoutMs = values['timeout-ms'] === undefined ? 30_000 : Number(values['timeout-ms']);
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 120_000, '--timeout-ms must be an integer from 1000 to 120000.');
  return {
    live: values.live === true,
    help: values.help === true,
    models: (values.model ?? []).flatMap((model) => model.split(',')).filter(Boolean),
    caseIds: values.case ?? [],
    timeoutMs,
    output: values.output,
    envFiles: values['env-file'] ?? [],
  };
}

function printHelp() {
  process.stdout.write([
    'Usage: npm run evaluate:slack-approval-intent',
    '       npm run evaluate:slack-approval-intent -- --live [--model ID ...] [--case ID ...] [--timeout-ms MS]',
    '         [--output PATH] [--env-file PATH ...]',
    '',
    'Offline (default): validates evals/slack-approval-intent/cases.json, then sends every case through the',
    'production approval side call to a stubbed provider endpoint. It checks the judge sees only the',
    'person\'s message and the preview, that answers parse, and that the exact word, a provider error and a',
    'malformed answer behave. No network, no credentials, and no real model: it does not measure judgment.',
    '',
    `Live: judges every selected case with each model from --model (repeatable or comma-separated) or`,
    `${MODEL_ENV}, through the same side call the host runs. Providers: anthropic, openai, openrouter;`,
    'credentials come from ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, and --env-file loads only',
    'those names. The report holds the cases\' raw answers, so it is private: it defaults to',
    '~/.chickpea/evals/slack-approval-intent/<time>/report.json and is refused inside any Git checkout.',
    `Exits 1 unless false approvals = ${TARGETS.falseApprovalsMax}, approve recall >= ${TARGETS.approveRecallMin},`,
    `decline recall >= ${TARGETS.declineRecallMin} and side-call failures = ${TARGETS.failuresMax} for every model.`,
    '',
  ].join('\n'));
}

async function main() {
  process.env.DO_NOT_TRACK ??= '1';
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  assertNodeVersion();
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
  const counts = validateCorpus(corpus);
  bootstrapRuntimeProviders();
  const settings = new SqliteSettingsStore(':memory:');
  try {
    if (options.live) {
      const report = await runLive(corpus, options, settings);
      if (!report.gate.passed) process.exitCode = 1;
      return;
    }
    const smoke = await runOfflineSmoke(corpus, settings);
    process.stdout.write(`${JSON.stringify({
      kind: 'slack-approval-intent offline check: corpus contract and the production side call against a stubbed provider; no real model',
      corpusVersion: corpus.corpusVersion,
      corpus: counts,
      smoke: smoke.length,
      passed: true,
    }, null, 2)}\n`);
  } finally {
    settings.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Slack approval intent evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
