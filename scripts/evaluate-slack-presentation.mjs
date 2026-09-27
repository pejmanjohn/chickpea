#!/usr/bin/env node
// Slack presentation usage calibration. Offline (default): corpus contract
// plus a deterministic faux-model smoke through the Flue boundary. --live:
// the real presentation tools and guide against real models, per case, with
// a private report and a gate on the calibration targets.

import {
  SLACK_ASK_USER_ACKNOWLEDGEMENT,
  SLACK_OFFER_ACTIONS_ACKNOWLEDGEMENT,
} from '../src/slack/ui/interactive-tools.ts';
import { SlackQuestionPostedToolDeniedError } from '../src/slack/presentation-tool-policy.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  init,
  useDataWriter,
  useInstruction,
  useModel,
  useResponseFinish,
  useTool,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { thinkingLevelForModel } from '../src/config/workers-ai-models.ts';
import { SLACK_ACTION_LINK_INSTRUCTION } from '../src/slack/message-format.ts';
import {
  createSlackPresentTableTool,
  SLACK_PRESENT_TABLE_TOOL_NAME,
} from '../src/slack/table-presentation.ts';
import {
  SLACK_PRESENTATION_GUIDE,
  SLACK_PRESENTATION_TOOL_DEFINITIONS,
  validateAskUser,
  validateOfferActions,
  validatePresentCards,
  validatePresentChart,
  validatePresentDetails,
  validateRequestForm,
} from '../src/slack/ui/presentation-tools.ts';
import { assertNodeVersion } from './lib/node-version.mjs';
import { outsideGit } from './lib/private-evidence.mjs';
import {
  AGENT_PERSONA,
  BLOCKING_TOOL_NAMES,
  CATEGORIES,
  DISPLAY_TOOL_NAMES,
  INTERACTIVE_TOOL_NAMES,
  MAX_DISPLAY_PER_REPLY,
  MAX_INTERACTIVE_PER_REPLY,
  PRESENTATION_TOOL_NAMES,
  STUB_TOOLS,
  STUB_TOOL_NAMES,
  TARGETS,
  ALL_EVAL_TOOLS,
  effectiveCase,
  evalHostInstructions,
  formatSummaryTable,
  presentationSurfaceDigest,
  renderSlackTurnPrompt,
  scoreRun,
  selectCases,
  slackPresentationGuideVersion,
  stubToolOutput,
  summarizeRuns,
  validateCorpus,
} from './lib/slack-presentation-evaluation.mjs';

const CORPUS_PATH = new URL('../evals/slack-presentation/cases.json', import.meta.url);
const EVAL_DATA_NAME = 'slackPresentationEval';
const FAUX_MODEL = 'faux/slack-presentation-eval';
const MODEL_ENV = 'SLACK_PRESENTATION_EVAL_MODEL';
const SUGGESTED_MODELS = [
  'openai/gpt-5.6-terra',
  'anthropic/claude-sonnet-5',
  'cloudflare-workers-ai/@cf/openai/gpt-oss-120b',
];
// Only provider credentials are ever read from --env-file; nothing is printed.
const PROVIDER_ENV = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
};
const LOADABLE_ENV = new Set(Object.values(PROVIDER_ENV).flat());
const ABANDON_AFTER_FAILURES = 3;

// The production acknowledgements and refusal, so the gate measures what ships.
const QUESTION_POSTED = SLACK_ASK_USER_ACKNOWLEDGEMENT;
const AFTER_QUESTION = new SlackQuestionPostedToolDeniedError().message;
const ACKNOWLEDGEMENTS = {
  ask_user: SLACK_ASK_USER_ACKNOWLEDGEMENT,
  offer_actions: SLACK_OFFER_ACTIONS_ACKNOWLEDGEMENT,
};

const VALIDATORS = {
  ask_user: validateAskUser,
  offer_actions: validateOfferActions,
  present_cards: validatePresentCards,
  present_chart: validatePresentChart,
  present_details: validatePresentDetails,
  request_form: validateRequestForm,
};

// ── The evaluated Agent ────────────────────────────────────────────────────

/** Host-side state for one case run: statuses per tool call and the budget. */
class CaseRecorder {
  constructor() {
    this.byCall = new Map();
    this.interactive = 0;
    this.display = 0;
    this.questionPosted = false;
  }

  mark(toolCallId, status, extra = {}) {
    this.byCall.set(toolCallId, { status, ...extra });
  }

  /** Enforce the reply latch and the component budget before validation. */
  admit(name, toolCallId) {
    let message;
    let status = 'rejected_budget';
    if (this.questionPosted) {
      message = AFTER_QUESTION;
      status = 'rejected_after_question';
    } else if (INTERACTIVE_TOOL_NAMES.includes(name) && this.interactive >= MAX_INTERACTIVE_PER_REPLY) {
      message = 'This reply already has one of ask_user, request_form or offer_actions; use at most one per reply.';
    } else if (DISPLAY_TOOL_NAMES.includes(name) && this.display >= MAX_DISPLAY_PER_REPLY) {
      message = `This reply already has ${MAX_DISPLAY_PER_REPLY} display components; put anything else in prose.`;
    }
    if (message) {
      this.mark(toolCallId, status, { error: message });
      throw new Error(message);
    }
  }

  accept(name, toolCallId, spec) {
    if (INTERACTIVE_TOOL_NAMES.includes(name)) this.interactive += 1;
    if (DISPLAY_TOOL_NAMES.includes(name)) this.display += 1;
    if (BLOCKING_TOOL_NAMES.includes(name)) this.questionPosted = true;
    this.mark(toolCallId, 'accepted', { spec });
  }

  remaining() {
    return `Remaining in this reply: ${MAX_INTERACTIVE_PER_REPLY - this.interactive} of ask_user, request_form or offer_actions; ${MAX_DISPLAY_PER_REPLY - this.display} display component(s).`;
  }
}

const RUNS = new Map();

function errorText(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 600);
}

/** A failed run's reason: AgentRunError carries the settlement error as a plain `cause`. */
function runErrorText(error) {
  const cause = error?.cause;
  const reason = cause?.message ?? cause?.meta?.reason ??
    (cause && typeof cause === 'object' ? JSON.stringify(cause) : cause);
  return errorText(reason ? `${errorText(error)}: ${reason}` : error);
}

function presentationTool(definition, run, writeComponent) {
  const validate = VALIDATORS[definition.name];
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: v.string(),
    run: ({ data, toolCallId }) => {
      run.recorder.admit(definition.name, toolCallId);
      let spec;
      try {
        spec = validate(data);
      } catch (error) {
        // SlackPresentationInputError carries the teaching message verbatim.
        run.recorder.mark(toolCallId, 'rejected_validation', { error: errorText(error) });
        throw error;
      }
      run.recorder.accept(definition.name, toolCallId, spec);
      writeComponent({ tool: definition.name, spec });
      return ACKNOWLEDGEMENTS[definition.name] ??
        (BLOCKING_TOOL_NAMES.includes(definition.name) ? QUESTION_POSTED : `Recorded. ${run.recorder.remaining()}`);
    },
  };
}

/** The production present_table tool, inside the same latch and budget. */
function tableTool(run, writeComponent) {
  let recorded;
  const table = createSlackPresentTableTool((presentation) => { recorded = presentation; });
  return {
    ...table,
    run: (context) => {
      run.recorder.admit(SLACK_PRESENT_TABLE_TOOL_NAME, context.toolCallId);
      let result;
      try {
        result = table.run(context);
      } catch (error) {
        run.recorder.mark(context.toolCallId, 'rejected_validation', { error: errorText(error) });
        throw error;
      }
      run.recorder.accept(SLACK_PRESENT_TABLE_TOOL_NAME, context.toolCallId, recorded);
      writeComponent({ tool: SLACK_PRESENT_TABLE_TOOL_NAME, spec: recorded });
      return result;
    },
  };
}

function stubTool(name, run) {
  const stub = STUB_TOOLS[name];
  return {
    name,
    description: stub.description,
    input: stub.input,
    run: ({ toolCallId }) => {
      if (run.recorder.questionPosted) {
        run.recorder.mark(toolCallId, 'rejected_after_question', { error: AFTER_QUESTION });
        throw new Error(AFTER_QUESTION);
      }
      run.recorder.mark(toolCallId, 'ok');
      return { output: stubToolOutput(run.entry, name) };
    },
  };
}

function SlackPresentationEvalAgent({ id }) {
  const run = RUNS.get(id);
  if (!run) throw new Error(`No Slack presentation evaluation run is registered for ${id}.`);
  const thinkingLevel = thinkingLevelForModel(run.model);
  useModel(run.model, thinkingLevel ? { thinkingLevel } : {});
  useResponseFinish(({ response }) => ({ slackPresentationEval: { usage: normalizeUsage(response.usage) } }));
  const writeComponent = useDataWriter(EVAL_DATA_NAME);
  for (const instruction of evalHostInstructions({ actionLinkInstruction: SLACK_ACTION_LINK_INSTRUCTION, tools: run.tools })) {
    useInstruction(instruction);
  }
  for (const name of STUB_TOOL_NAMES) useTool(stubTool(name, run));
  if (run.tools.includes('present_table')) useTool(tableTool(run, writeComponent));
  for (const definition of SLACK_PRESENTATION_TOOL_DEFINITIONS) {
    if (run.tools.includes(definition.name)) useTool(presentationTool(definition, run, writeComponent));
  }
  return AGENT_PERSONA;
}
SlackPresentationEvalAgent.agentName = 'slack-presentation-eval';

/** One fresh conversation per case run; returns ordered calls and the final text. */
async function runCase(entry, model, { repetition = 0, timeoutMs = 240_000, tools = ALL_EVAL_TOOLS } = {}) {
  const id = `slack-presentation-${randomUUID()}`;
  const run = { entry, model, tools, recorder: new CaseRecorder() };
  RUNS.set(id, run);
  const handle = init(SlackPresentationEvalAgent, { id });
  const inputs = [];
  const outcomes = new Map();
  const startedAt = performance.now();
  const base = { caseId: entry.id, category: entry.category, model, repetition };
  try {
    const receipt = await handle.dispatch(renderSlackTurnPrompt(entry));
    const reply = await handle.read(receipt, {
      signal: AbortSignal.timeout(timeoutMs),
      onEvent(chunk) {
        if (chunk.type === 'tool-input') {
          inputs.push({ id: chunk.toolCallId, tool: chunk.toolName, input: chunk.input });
        } else if (chunk.type === 'tool-output') {
          outcomes.set(chunk.toolCallId, { ok: true });
        } else if (chunk.type === 'tool-output-error') {
          outcomes.set(chunk.toolCallId, { ok: false, error: chunk.errorText });
        }
      },
    });
    const calls = inputs.map(({ id: callId, tool, input }) => {
      const recorded = run.recorder.byCall.get(callId);
      const outcome = outcomes.get(callId);
      // Flue rejects an input its schema refuses before run() is ever called.
      const status = recorded?.status ??
        (outcome?.ok === false ? 'rejected_schema' : outcome?.ok ? 'ok' : 'unsettled');
      // Prefer the error text the model actually saw over the host's record.
      const error = outcome?.ok === false ? String(outcome.error).slice(0, 600) : recorded?.error;
      return {
        tool,
        status,
        ...(error ? { error } : {}),
        input,
        ...(recorded?.spec ? { spec: recorded.spec } : {}),
      };
    });
    const finalText = reply.text ?? '';
    const result = {
      ...base,
      durationMs: Math.round(performance.now() - startedAt),
      calls,
      finalText,
      components: reply.data?.[EVAL_DATA_NAME] ?? [],
      usage: normalizeUsage(reply.metadata?.slackPresentationEval?.usage),
    };
    return { ...result, score: scoreRun(effectiveCase(entry, tools), result) };
  } catch (error) {
    await handle.abort().catch(() => {});
    return {
      ...base,
      durationMs: Math.round(performance.now() - startedAt),
      calls: [],
      finalText: '',
      error: runErrorText(error),
    };
  } finally {
    RUNS.delete(id);
  }
}

function normalizeUsage(value) {
  const number = (candidate) => Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  return {
    input: number(value?.input),
    output: number(value?.output),
    cacheRead: number(value?.cacheRead),
    cacheWrite: number(value?.cacheWrite),
    totalTokens: number(value?.totalTokens),
  };
}

// ── Offline: corpus contract + deterministic Flue smoke ────────────────────

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function caseById(corpus, id) {
  const entry = corpus.cases.find((candidate) => candidate.id === id);
  assert(entry, `Smoke case ${id} is missing from the corpus.`);
  return entry;
}

function statuses(result) {
  return result.calls.map(({ tool, status }) => `${tool}:${status}`);
}

async function runDeterministicSmoke(corpus) {
  const stats = validateCorpus(corpus);
  let rejected = false;
  try {
    validateCorpus({ ...corpus, cases: corpus.cases.map((entry, index) => index === 0 ? { ...entry, strongSignal: true } : entry) });
  } catch (error) {
    rejected = /strongSignal/.test(errorText(error));
  }
  assert(rejected, 'Corpus validation accepted a strong signal on a no-component case.');
  for (const entry of corpus.cases) {
    const prompt = renderSlackTurnPrompt(entry);
    assert(prompt.includes(entry.request.text), `${entry.id}: the rendered Slack turn lost the request.`);
  }

  const faux = fauxProvider({ models: [{ id: 'slack-presentation-eval', reasoning: false }] });
  const flue = await start({ agents: [SlackPresentationEvalAgent], providers: [faux.provider] });
  const results = [];
  const scenario = async (caseId, responses) => {
    faux.setResponses(responses);
    const result = await runCase(caseById(corpus, caseId), FAUX_MODEL, { timeoutMs: 30_000 });
    assert(!result.error, `${caseId}: smoke run failed: ${result.error}`);
    assert(faux.getPendingResponseCount() === 0, `${caseId}: the smoke run did not consume every scripted response.`);
    results.push(result);
    return result;
  };
  try {
    // 1. Restraint: a plain answer. The request must carry the guide, the
    // production table rule and every presentation tool across the boundary.
    const plain = await scenario('plain-answer-refund-window', [
      (context) => {
        const tools = new Set((context.tools ?? []).map(({ name }) => name));
        assert(context.systemPrompt?.includes(SLACK_PRESENTATION_GUIDE), 'The presentation guide did not reach the model.');
        for (const name of [...PRESENTATION_TOOL_NAMES, ...STUB_TOOL_NAMES]) assert(tools.has(name), `Tool ${name} did not reach the model.`);
        return fauxAssistantMessage([fauxToolCall('search_docs', { query: 'refund window annual plans' })], { stopReason: 'toolUse' });
      },
      fauxAssistantMessage('Annual plans get a full refund within 30 days of purchase. After that there are no refunds.'),
    ]);
    assert(statuses(plain).join() === 'search_docs:ok', `Plain answer statuses: ${statuses(plain)}`);
    assert(!plain.score.overUse && plain.score.expectNone, 'A plain answer was scored as over-use.');

    // 2. A real decision: a teaching rejection, the retry, then the latch.
    const decision = await scenario('decision-hotfix-prod-or-staging', [
      fauxAssistantMessage([fauxToolCall('ask_user', { question: 'Where should I deploy it?', options: [{ label: 'Production' }] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('ask_user', {
        question: 'Where should I deploy the billing-service hotfix?',
        options: [{ label: 'Staging first', recommended: true }, { label: 'Production now', destructive: true }],
      })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('deploy_service', { service: 'billing-service', environment: 'production' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('One decision before I deploy.'),
    ]);
    assert(statuses(decision).join() === 'ask_user:rejected_validation,ask_user:accepted,deploy_service:rejected_after_question',
      `Decision statuses: ${statuses(decision)}`);
    assert(/2–25 options/.test(decision.calls[0].error ?? ''), 'The teaching error did not reach the recorded call.');
    assert(decision.score.strongHit && decision.score.firstTryRejected, 'Decision scoring missed the hit or the first-try error.');
    assert(decision.components.length === 1 && decision.components[0].tool === 'ask_user', 'The accepted component did not cross the Flue boundary.');

    // 3. A Flue schema rejection (unknown key), then the production table.
    const rows = Array.from({ length: 11 }, (_, index) => [5100 + index, `Ticket ${index + 1}`, 'Orchard Labs']);
    const table = await scenario('rows-p2-queue', [
      fauxAssistantMessage([fauxToolCall('present_table', { title: 'P2', caption: 'Open P2 tickets', presentation: 'static', columns: [{ header: 'ID' }], rows: [[1], [2]] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('present_table', {
        caption: 'Open P2 tickets', presentation: 'explore',
        columns: [{ header: 'Ticket', type: 'number' }, { header: 'Subject' }, { header: 'Customer' }], rows,
      })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Eleven P2 tickets are open; three are unassigned.'),
    ]);
    assert(statuses(table).join() === 'present_table:rejected_schema,present_table:accepted', `Table statuses: ${statuses(table)}`);
    assert(table.score.strongHit && !table.score.repeats, 'Table scoring is wrong.');

    // 4. Over-use with prose repetition on chit-chat.
    const chat = await scenario('chit-chat-capabilities', [
      fauxAssistantMessage([fauxToolCall('present_cards', { cards: [{ title: 'Support tickets' }, { title: 'Revenue metrics' }, { title: 'Pull requests' }] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('I can help with support tickets, pull requests and revenue metrics.'),
    ]);
    assert(chat.score.overUse && chat.score.repeats, 'Over-use or prose repetition was not detected.');

    // 5. The interactive budget.
    const budget = await scenario('next-steps-overnight-triage', [
      fauxAssistantMessage([fauxToolCall('offer_actions', { actions: [{ label: 'Draft urgent replies' }] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('offer_actions', { actions: [{ label: 'Open the queue', url: 'https://support.kestrel.example/queue' }] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Two tickets are urgent: 5220 and 5223.')]),
    ]);
    assert(statuses(budget).join() === 'offer_actions:accepted,offer_actions:rejected_budget', `Budget statuses: ${statuses(budget)}`);

    // 6. Asking permission for what was explicitly requested.
    const trap = await scenario('outward-explicit-delete-ticket', [
      fauxAssistantMessage([fauxToolCall('ask_user', { question: 'Delete ticket 4990 permanently?', options: [{ label: 'Delete it', destructive: true }, { label: 'Keep it' }] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(''),
    ]);
    assert(trap.score.permissionAsk && trap.score.overUse, 'A permission ask on an explicit request was not caught.');
  } finally {
    await flue.stop();
  }

  const summary = summarizeRuns(results);
  const m = summary.metrics;
  assert(m.overUse.count === 2 && m.overUse.total === 3, `Over-use metric is wrong: ${JSON.stringify(m.overUse)}`);
  assert(m.strongSignalRecall.count === 2 && m.strongSignalRecall.total === 2, 'Strong-signal recall metric is wrong.');
  assert(m.firstTrySchemaError.count === 2 && m.firstTrySchemaError.total === 5, `First-try metric is wrong: ${JSON.stringify(m.firstTrySchemaError)}`);
  assert(m.permissionAsks.count === 1 && m.budgetRejections === 1 && m.afterQuestionCalls === 1, 'Trap, budget or latch metric is wrong.');
  assert(!summary.gate.passed && summary.gate.failures.includes('over-use') && summary.gate.failures.includes('permission asks'),
    'The gate did not fail on over-use and permission asks.');
  return {
    kind: 'slack-presentation offline check: corpus contract and deterministic faux-model smoke; no real model',
    corpusVersion: corpus.corpusVersion,
    guideVersion: corpus.guideVersion,
    surfaceDigest: presentationSurfaceDigest(),
    corpus: stats,
    smoke: results.map((result) => ({ caseId: result.caseId, calls: statuses(result) })),
    passed: true,
  };
}

// ── Live ───────────────────────────────────────────────────────────────────

function loadProviderEnv(files) {
  const loaded = [];
  for (const file of files) {
    const parsed = parseEnv(readFileSync(resolve(file), 'utf8'));
    for (const [name, value] of Object.entries(parsed)) {
      if (!LOADABLE_ENV.has(name) || !value || process.env[name]) continue;
      process.env[name] = value;
      loaded.push(name);
    }
  }
  return [...new Set(loaded)].sort();
}

/** The Workers AI binding exists only on Cloudflare; Node reaches it over REST. */
function normalizeModel(model) {
  return model.startsWith('cloudflare/@cf/') ? `cloudflare-workers-ai/${model.slice('cloudflare/'.length)}` : model;
}

function missingCredentials(model) {
  const provider = model.slice(0, model.indexOf('/'));
  const required = PROVIDER_ENV[provider];
  if (!required) return [`unknown provider "${provider}" (supported: ${Object.keys(PROVIDER_ENV).join(', ')})`];
  return required.filter((name) => !process.env[name]);
}

function defaultOutputPath(createdAt) {
  const stamp = createdAt.replace(/[:.]/g, '-');
  return join(homedir(), '.chickpea', 'evals', 'slack-presentation', stamp, 'report.json');
}

function outputPath(option, createdAt) {
  const target = option ? resolve(option) : defaultOutputPath(createdAt);
  const file = target.endsWith('.json') ? target : join(target, 'report.json');
  return outsideGit(file);
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

function clip(text, length = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** The concrete failures behind each metric, for iterating the guide. */
function failureDetails(runs) {
  const scored = runs.filter((run) => !run.error);
  return {
    overUse: scored.filter((run) => run.score.overUse).map((run) => ({ caseId: run.caseId, components: run.score.componentsAccepted })),
    strongMisses: scored.filter((run) => run.score.strongHit === false).map((run) => ({
      caseId: run.caseId, used: run.score.componentsAccepted, attempted: run.score.componentsAttempted, finalText: clip(run.finalText),
    })),
    firstTrySchemaErrors: scored.filter((run) => run.score.firstTryRejected).map((run) => {
      const call = run.calls.find(({ tool }) => PRESENTATION_TOOL_NAMES.includes(tool));
      return { caseId: run.caseId, tool: call?.tool, status: call?.status, error: clip(call?.error, 240) };
    }),
    proseRepetition: scored.filter((run) => run.score.repeats).map((run) => ({ caseId: run.caseId, repetition: run.score.repetition })),
    permissionAsks: scored.filter((run) => run.score.permissionAsk).map((run) => ({ caseId: run.caseId })),
    proseProceedAsks: scored.filter((run) => run.score.proseProceedAsk).map((run) => ({ caseId: run.caseId, finalText: clip(run.finalText) })),
    decideAsks: scored.filter((run) => run.score.decideAsk).map((run) => ({ caseId: run.caseId })),
    forbidden: scored.filter((run) => run.score.forbiddenUsed.length).map((run) => ({ caseId: run.caseId, tools: run.score.forbiddenUsed })),
    offList: scored.filter((run) => run.score.offList.length).map((run) => ({ caseId: run.caseId, tools: run.score.offList })),
    emptyReplies: scored.filter((run) => run.score.emptyReply).map((run) => ({ caseId: run.caseId })),
    errors: runs.filter((run) => run.error).map((run) => ({ caseId: run.caseId, error: clip(run.error, 240) })),
  };
}

function printFailures(model, details) {
  const lines = [];
  const add = (label, items, render) => {
    if (items.length) lines.push(`  ${label} (${items.length}): ${items.map(render).join('; ')}`);
  };
  add('over-use', details.overUse, (item) => `${item.caseId} [${item.components.join(',')}]`);
  add('strong-signal misses', details.strongMisses, (item) => `${item.caseId} [${item.used.join(',') || 'none'}]`);
  add('first-try schema errors', details.firstTrySchemaErrors, (item) => `${item.caseId} ${item.tool}: ${clip(item.error, 90)}`);
  add('prose repetition', details.proseRepetition, (item) => item.caseId);
  add('permission asks', details.permissionAsks, (item) => item.caseId);
  add('prose proceed-asks (report only)', details.proseProceedAsks, (item) => item.caseId);
  add('low-stakes asks (report only)', details.decideAsks, (item) => item.caseId);
  add('forbidden tools', details.forbidden, (item) => `${item.caseId} [${item.tools.join(',')}]`);
  add('off-list components (report only)', details.offList, (item) => `${item.caseId} [${item.tools.join(',')}]`);
  add('errors', details.errors, (item) => `${item.caseId}: ${clip(item.error, 90)}`);
  process.stdout.write(`${model}\n${lines.length ? lines.join('\n') : '  no failures'}\n`);
}

async function runPool(jobs, concurrency, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await worker(job);
    }
  });
  await Promise.all(lanes);
}

async function runLive(corpus, options) {
  const createdAt = new Date().toISOString();
  const currentGuide = slackPresentationGuideVersion();
  validateCorpus(corpus, { requireCurrentGuide: false });
  if (corpus.guideVersion !== currentGuide) {
    process.stderr.write(`Note: the corpus was recorded for guide ${corpus.guideVersion}; the current guide is ${currentGuide}. Results are reported against the current guide.\n`);
  }
  const loadedEnv = loadProviderEnv(options.envFiles);
  if (loadedEnv.length) process.stdout.write(`Loaded provider credentials by name: ${loadedEnv.join(', ')}\n`);
  const requested = (options.models.length ? options.models : (process.env[MODEL_ENV] ?? '').split(','))
    .map((model) => model.trim())
    .filter(Boolean)
    .map(normalizeModel);
  assert(requested.length > 0, `Pass --model or set ${MODEL_ENV} (comma-separated). Suggested: ${SUGGESTED_MODELS.join(',')}`);
  assert(new Set(requested).size === requested.length, 'Models must be unique.');
  const models = [];
  const skipped = [];
  for (const model of requested) {
    const missing = missingCredentials(model);
    if (missing.length) {
      skipped.push({ model, missing });
      process.stderr.write(`Skipping ${model}: missing ${missing.join(', ')}\n`);
    } else {
      models.push(model);
    }
  }
  const cases = selectCases(corpus, { caseIds: options.caseIds, categories: options.categories });
  const path = outputPath(options.output, createdAt);
  const report = {
    kind: 'slack-presentation usage calibration: synthetic Slack turns with stub domain tools; no Slack delivery or rendering',
    schemaVersion: 1,
    createdAt,
    finishedAt: null,
    source: sourceFingerprint(),
    corpus: {
      corpusVersion: corpus.corpusVersion,
      recordedGuideVersion: corpus.guideVersion,
      guideVersion: currentGuide,
      surfaceDigest: presentationSurfaceDigest(),
      selectedCases: cases.map(({ id }) => id),
    },
    settings: { models, tools: options.tools, repeat: options.repeat, concurrency: options.concurrency, timeoutMs: options.timeoutMs },
    skippedModels: skipped,
    abandonedModels: [],
    targets: TARGETS,
    models: [],
    gate: { passed: false, failures: ['incomplete'] },
    runs: [],
  };
  writePrivateJson(path, report);
  process.stdout.write(`Private report: ${path}\n`);
  if (models.length === 0) {
    report.gate = { passed: false, failures: skipped.map(({ model, missing }) => `${model}: missing ${missing.join(', ')}`) };
    report.finishedAt = new Date().toISOString();
    writePrivateJson(path, report);
    return report;
  }

  const { bootstrapRuntimeProviders } = await import('../src/runtime-bootstrap.ts');
  bootstrapRuntimeProviders();
  const flue = await start({ agents: [SlackPresentationEvalAgent] });
  // Interleave models so each provider's requests spread across the run.
  const jobs = [];
  for (let repetition = 0; repetition < options.repeat; repetition += 1) {
    for (const entry of cases) for (const model of models) jobs.push({ entry, model, repetition });
  }
  let done = 0;
  // A model whose first runs all fail (bad credentials, unknown id) is
  // abandoned instead of failing every remaining case the same way.
  const health = new Map(models.map((model) => [model, { ok: 0, failed: 0, abandoned: 0, lastError: undefined }]));
  try {
    await runPool(jobs, options.concurrency, async ({ entry, model, repetition }) => {
      const state = health.get(model);
      if (state.ok === 0 && state.failed >= ABANDON_AFTER_FAILURES) {
        state.abandoned += 1;
        done += 1;
        return;
      }
      const result = await runCase(entry, model, { repetition, timeoutMs: options.timeoutMs, tools: options.tools });
      if (result.error) {
        state.failed += 1;
        state.lastError = result.error;
      } else {
        state.ok += 1;
      }
      report.runs.push(result);
      done += 1;
      const used = result.error ? `ERROR ${clip(result.error, 80)}` : (result.score.componentsAccepted.join(',') || 'none');
      const calls = result.calls.map(({ tool, status }) => status === 'ok' || status === 'accepted' ? tool : `${tool}(${status})`).join(' ');
      process.stdout.write(`[${done}/${jobs.length}] ${model} ${entry.id}: ${used}${calls ? ` | ${calls}` : ''}\n`);
      writePrivateJson(path, report);
    });
  } finally {
    await flue.stop();
  }

  const byCase = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  report.runs.sort((left, right) =>
    left.model.localeCompare(right.model) || left.caseId.localeCompare(right.caseId) || left.repetition - right.repetition);
  for (const model of models) {
    const runs = report.runs.filter((run) => run.model === model);
    const summary = summarizeRuns(runs);
    const perCategory = Object.fromEntries(CATEGORIES.map((category) => {
      const categoryRuns = runs.filter((run) => byCase.get(run.caseId)?.category === category);
      return [category, {
        runs: categoryRuns.length,
        withComponent: categoryRuns.filter((run) => run.score?.componentsAccepted.length).length,
      }];
    }));
    report.models.push({ model, summary, perCategory, failures: failureDetails(runs) });
  }
  report.abandonedModels = [...health].filter(([, state]) => state.abandoned > 0)
    .map(([model, state]) => ({ model, abandonedRuns: state.abandoned, lastError: state.lastError }));
  const failures = [
    ...skipped.map(({ model, missing }) => `${model}: missing ${missing.join(', ')}`),
    ...report.abandonedModels.map(({ model, abandonedRuns, lastError }) =>
      `${model}: abandoned ${abandonedRuns} run(s) after ${ABANDON_AFTER_FAILURES} failures (${clip(lastError, 120)})`),
    ...report.models.filter(({ summary }) => !summary.gate.passed)
      .map(({ model, summary }) => `${model}: ${summary.gate.failures.join(', ')}`),
  ];
  report.gate = { passed: failures.length === 0, failures };
  report.finishedAt = new Date().toISOString();
  writePrivateJson(path, report);

  process.stdout.write(`\n${formatSummaryTable(report.models)}\n\n`);
  for (const { model, failures: details } of report.models) printFailures(model, details);
  for (const { model, missing } of skipped) process.stdout.write(`${model}: not run, missing ${missing.join(', ')}\n`);
  for (const { model, abandonedRuns, lastError } of report.abandonedModels) {
    process.stdout.write(`${model}: abandoned ${abandonedRuns} run(s) after ${ABANDON_AFTER_FAILURES} failures: ${clip(lastError, 200)}\n`);
  }
  process.stdout.write(`\nPrivate report: ${path}\n`);
  return report;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function integerOption(value, name, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  assert(Number.isInteger(number) && number >= minimum && number <= maximum, `${name} must be an integer from ${minimum} to ${maximum}.`);
  return number;
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      live: { type: 'boolean' },
      help: { type: 'boolean' },
      model: { type: 'string', multiple: true },
      case: { type: 'string', multiple: true },
      category: { type: 'string', multiple: true },
      repeat: { type: 'string' },
      concurrency: { type: 'string' },
      'timeout-ms': { type: 'string' },
      output: { type: 'string' },
      'env-file': { type: 'string', multiple: true },
      tools: { type: 'string' },
    },
  });
  const liveOnly = ['model', 'case', 'category', 'repeat', 'concurrency', 'timeout-ms', 'env-file', 'tools'];
  if (!values.live) {
    const used = liveOnly.filter((name) => values[name] !== undefined);
    assert(used.length === 0, `--${used[0]} requires --live.`);
  }
  return {
    live: values.live === true,
    help: values.help === true,
    models: (values.model ?? []).flatMap((model) => model.split(',')),
    caseIds: values.case ?? [],
    categories: values.category ?? [],
    repeat: integerOption(values.repeat, '--repeat', 1, 5, 1),
    concurrency: integerOption(values.concurrency, '--concurrency', 1, 16, 4),
    timeoutMs: integerOption(values['timeout-ms'], '--timeout-ms', 10_000, 900_000, 240_000),
    output: values.output,
    envFiles: values['env-file'] ?? [],
    tools: values.tools === undefined
      ? [...ALL_EVAL_TOOLS]
      : (() => {
          const tools = values.tools.split(',').map((tool) => tool.trim()).filter(Boolean);
          for (const tool of tools) assert(ALL_EVAL_TOOLS.includes(tool), `--tools names unknown tool ${tool}.`);
          return tools;
        })(),
  };
}

function printHelp() {
  process.stdout.write([
    'Usage: npm run evaluate:slack-presentation -- [--output PATH]',
    '       npm run evaluate:slack-presentation -- --live [--model ID ...] [--case ID ...] [--category NAME ...]',
    '         [--repeat N] [--concurrency N] [--timeout-ms MS] [--output PATH] [--env-file PATH ...]',
    '',
    'Offline (default): validates evals/slack-presentation/cases.json and runs a deterministic faux-model',
    'smoke through the Flue boundary. No network, no credentials.',
    '',
    `Live: runs each selected case in a fresh conversation per model. Models come from --model (repeatable or`,
    `comma-separated) or ${MODEL_ENV}. Suggested: ${SUGGESTED_MODELS.join(', ')}.`,
    'Credentials come from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, CLOUDFLARE_API_TOKEN +',
    'CLOUDFLARE_ACCOUNT_ID); --env-file loads only those names and prints no values. A model whose',
    'credentials are missing is skipped and fails the gate. The report holds prompts\' answers and tool',
    'inputs, so it is private evidence: it defaults to ~/.chickpea/evals/slack-presentation/<time>/report.json',
    'and is refused inside any Git checkout. Exits 1 when a calibration target fails.',
    '',
    `Targets: over-use ≤ ${TARGETS.overUseRateMax * 100}%, strong-signal recall ≥ ${TARGETS.strongSignalRecallMin * 100}%,`,
    `first-try schema errors ≤ ${TARGETS.firstTrySchemaErrorRateMax * 100}%, prose repetition ≤ ${TARGETS.proseRepetitionRateMax * 100}%, permission asks = 0.`,
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
  if (options.live) {
    const report = await runLive(corpus, options);
    if (!report.gate.passed) process.exitCode = 1;
    return;
  }
  const report = await runDeterministicSmoke(corpus);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const path = outsideGit(resolve(options.output));
    writePrivateJson(path, report);
    process.stdout.write(`Wrote the offline check to ${path}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  process.stderr.write(`Slack presentation evaluation failed: ${errorText(error)}\n`);
  process.exitCode = 1;
});
