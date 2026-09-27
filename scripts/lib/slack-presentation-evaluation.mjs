// Slack presentation usage calibration: corpus contract, Slack-turn prompt
// rendering, stub domain tools, and scoring. Pure and credential-free; the
// runner (scripts/evaluate-slack-presentation.mjs) owns Flue and providers.
import * as v from 'valibot';

import {
  SLACK_ASK_USER_TOOL_NAME,
  SLACK_OFFER_ACTIONS_TOOL_NAME,
  SLACK_PRESENTATION_GUIDE,
  slackPresentationGuide,
  SLACK_PRESENTATION_TOOL_DEFINITIONS,
  SLACK_PRESENT_CARDS_TOOL_NAME,
  SLACK_PRESENT_CHART_TOOL_NAME,
  SLACK_PRESENT_DETAILS_TOOL_NAME,
  SLACK_REQUEST_FORM_TOOL_NAME,
} from '../../src/slack/ui/presentation-tools.ts';
import {
  SLACK_PRESENT_TABLE_INSTRUCTION,
  SLACK_PRESENT_TABLE_TOOL_NAME,
} from '../../src/slack/table-presentation.ts';
import { assembleSlackPrompt } from '../../src/slack/web-client-context.ts';
import { digest } from './verification-inputs.mjs';

export const CORPUS_SCHEMA_VERSION = 1;

/** Every model-facing presentation tool the eval mounts, present_table included. */
export const PRESENTATION_TOOL_NAMES = Object.freeze([
  SLACK_ASK_USER_TOOL_NAME,
  SLACK_OFFER_ACTIONS_TOOL_NAME,
  SLACK_REQUEST_FORM_TOOL_NAME,
  SLACK_PRESENT_CARDS_TOOL_NAME,
  SLACK_PRESENT_CHART_TOOL_NAME,
  SLACK_PRESENT_DETAILS_TOOL_NAME,
  SLACK_PRESENT_TABLE_TOOL_NAME,
]);
/** At most one of these per reply (the guide's interactive budget). */
export const INTERACTIVE_TOOL_NAMES = Object.freeze([
  SLACK_ASK_USER_TOOL_NAME,
  SLACK_REQUEST_FORM_TOOL_NAME,
  SLACK_OFFER_ACTIONS_TOOL_NAME,
]);
/** These end the reply: the answer arrives as the next message. */
export const BLOCKING_TOOL_NAMES = Object.freeze([
  SLACK_ASK_USER_TOOL_NAME,
  SLACK_REQUEST_FORM_TOOL_NAME,
]);
/** At most two of these per reply. */
export const DISPLAY_TOOL_NAMES = Object.freeze([
  SLACK_PRESENT_CARDS_TOOL_NAME,
  SLACK_PRESENT_CHART_TOOL_NAME,
  SLACK_PRESENT_DETAILS_TOOL_NAME,
  SLACK_PRESENT_TABLE_TOOL_NAME,
]);
export const MAX_INTERACTIVE_PER_REPLY = 1;
export const MAX_DISPLAY_PER_REPLY = 2;

export const CATEGORIES = Object.freeze([
  'plain_answer',
  'short_confirmation',
  'low_stakes_choice',
  'real_decision',
  'outward_destructive',
  'open_ended_question',
  'value_ask',
  'multi_field_form',
  'rows_7_plus',
  'trend',
  'entity_list',
  'sources_method',
  'next_steps',
  'error',
  'chit_chat',
  'follow_up',
  'adversarial',
]);

export const TARGETS = Object.freeze({
  overUseRateMax: 0.05,
  strongSignalRecallMin: 0.8,
  firstTrySchemaErrorRateMax: 0.1,
  proseRepetitionRateMax: 0.1,
  permissionAsksMax: 0,
});

// One fixed synthetic Slack world: every case sees the same Agent, app
// identity, clock and requester timezone.
export const AGENT_DISPLAY_NAME = 'Atlas';
export const AGENT_USER_ID = 'U09ATLAS';
export const FROZEN_NOW_MS = Date.parse('2026-09-24T17:05:00Z');
export const REQUESTER_TIMEZONE = 'America/Los_Angeles';
const WORKSPACE_ID = 'T0EVALWS';

export const AGENT_PERSONA = [
  `You are ${AGENT_DISPLAY_NAME}, the operations teammate for the Kestrel team (Kestrel is a B2B analytics product).`,
  'You help people with customer support tickets, product and revenue metrics, engineering pull requests, internal docs, customer accounts, outbound email, Slack posts, records and deployments, using the tools you have.',
  'Be direct and concise. Lead with the answer.',
].join(' ');

/**
 * The host instructions a real Slack turn mounts that bear on presentation,
 * in production order before the presentation guidance itself.
 */
export function evalHostInstructions({ actionLinkInstruction, tools = ALL_EVAL_TOOLS }) {
  return [
    'Never invent facts or claim access to context and tools you do not have.',
    actionLinkInstruction,
    'The final Slack answer must be self-contained. Earlier assistant steps are working narration. After an interrupted response, write the complete final answer again, not just the remaining words of the partial response.',
    SLACK_PRESENT_TABLE_INSTRUCTION,
    slackPresentationGuide(tools),
  ];
}

/** Every presentation tool plus present_table, the full end-state mount. */
export const ALL_EVAL_TOOLS = Object.freeze([...PRESENTATION_TOOL_NAMES, 'present_table']);

/**
 * A case's expectation under a narrower mount (one phase's tools). A case
 * whose allowed components are all unmounted expects prose, and a strong
 * signal only counts when one of its required tools is mounted.
 */
export function effectiveCase(entry, tools = ALL_EVAL_TOOLS) {
  const mounted = new Set(tools);
  const expected = entry.expected;
  if (expected.presentation === 'none') return entry;
  const allowed = expected.allowed.filter((tool) => mounted.has(tool));
  if (allowed.length === 0) {
    return {
      ...entry,
      strongSignal: false,
      expected: { presentation: 'none', ...(expected.forbidden ? { forbidden: expected.forbidden } : {}) },
    };
  }
  const primary = (expected.required_one_of ?? expected.allowed)[0];
  const required = (expected.required_one_of ?? expected.allowed).filter((tool) => mounted.has(tool));
  return {
    ...entry,
    // A strong signal counts only when its primary component ships in this mount.
    strongSignal: entry.strongSignal === true && mounted.has(primary),
    expected: { ...expected, allowed, ...(expected.required_one_of ? { required_one_of: required } : {}) },
  };
}

// ── Stub domain tools (outputs come from each case) ────────────────────────

const optionalText = v.optional(v.string());

export const STUB_TOOLS = Object.freeze({
  search_tickets: {
    kind: 'read',
    description: 'Search customer support tickets. Returns matching tickets with id, subject, status, priority, customer, assignee and recent activity.',
    input: v.object({ query: optionalText, id: v.optional(v.union([v.string(), v.number()])), status: optionalText, priority: optionalText, limit: v.optional(v.number()) }),
    empty: { results: [] },
  },
  get_metrics: {
    kind: 'read',
    description: 'Read a product or business metric (signups, active users, revenue, retention, latency, conversion...) for a period, optionally grouped by a dimension.',
    input: v.object({ metric: v.string(), period: optionalText, groupBy: optionalText }),
    empty: { results: [] },
  },
  list_prs: {
    kind: 'read',
    description: 'List GitHub pull requests with number, title, author, age, review state, checks and link.',
    input: v.object({ repo: optionalText, state: optionalText, author: optionalText, reviewer: optionalText }),
    empty: { results: [] },
  },
  search_docs: {
    kind: 'read',
    description: 'Search the internal wiki and shared documents. Returns titles, links and snippets.',
    input: v.object({ query: v.string() }),
    empty: { results: [] },
  },
  lookup_customer: {
    kind: 'read',
    description: 'Look up a customer account by name: plan, seats, owner, renewal date, billing status and contacts.',
    input: v.object({ name: v.string() }),
    empty: { matches: [] },
  },
  query_records: {
    kind: 'read',
    description: 'Query internal records (users, feature flags, candidates, incidents, accounts) with an optional filter.',
    input: v.object({ table: v.string(), filter: optionalText, limit: v.optional(v.number()) }),
    empty: { rows: [] },
  },
  send_email: {
    kind: 'outward',
    description: 'Send an email from the team\'s shared address. It is sent immediately.',
    input: v.object({ to: v.union([v.string(), v.array(v.string())]), cc: v.optional(v.union([v.string(), v.array(v.string())])), subject: v.string(), body: v.string() }),
    empty: { status: 'sent' },
  },
  post_message: {
    kind: 'outward',
    description: 'Post a message to a Slack channel as you. It is posted immediately.',
    input: v.object({ channel: v.string(), text: v.string() }),
    empty: { status: 'posted' },
  },
  update_account: {
    kind: 'outward',
    description: 'Change a customer account\'s plan or seat count. Billing changes take effect immediately.',
    input: v.object({ customer: v.string(), plan: optionalText, seats: v.optional(v.number()) }),
    empty: { status: 'updated' },
  },
  delete_records: {
    kind: 'destructive',
    description: 'Permanently delete records (tickets, users, rows) matching a filter. This cannot be undone.',
    input: v.object({ table: v.string(), filter: v.string() }),
    empty: { status: 'deleted', count: 0 },
  },
  deploy_service: {
    kind: 'outward',
    description: 'Deploy a service build to staging or production.',
    input: v.object({ service: v.string(), environment: v.string(), ref: optionalText }),
    empty: { status: 'started' },
  },
  add_to_sprint: {
    kind: 'outward',
    description: 'Add a ticket to the current engineering sprint.',
    input: v.object({ ticketId: v.union([v.string(), v.number()]) }),
    empty: { status: 'added' },
  },
  create_request: {
    kind: 'outward',
    description: 'File a request with an internal team: procurement (new vendor setup), engineering (bug report) or operations (travel and venue booking). Returns the request id.',
    input: v.object({ team: v.string(), title: v.string(), details: v.optional(v.unknown()) }),
    empty: { status: 'filed', id: 'REQ-1042' },
  },
  set_deploy_freeze: {
    kind: 'outward',
    description: 'Create a deploy freeze window that blocks production deploys between two dates.',
    input: v.object({ start: v.string(), end: v.string(), reason: optionalText }),
    empty: { status: 'created' },
  },
});
export const STUB_TOOL_NAMES = Object.freeze(Object.keys(STUB_TOOLS));

export function stubToolOutput(entry, name) {
  const configured = entry.tools?.[name];
  return configured === undefined ? STUB_TOOLS[name].empty : configured;
}

// ── Versions ───────────────────────────────────────────────────────────────

/** The corpus is bound to the guide text it was calibrated against. */
export function slackPresentationGuideVersion() {
  return `sha256:${digest(SLACK_PRESENTATION_GUIDE).slice(0, 16)}`;
}

/** Everything the model reads about presentation: guide, descriptions, table rule. */
export function presentationSurfaceDigest() {
  return `sha256:${digest({
    guide: SLACK_PRESENTATION_GUIDE,
    tableInstruction: SLACK_PRESENT_TABLE_INSTRUCTION,
    tools: SLACK_PRESENTATION_TOOL_DEFINITIONS.map(({ name, description }) => ({ name, description })),
  }).slice(0, 16)}`;
}

// ── Corpus contract ────────────────────────────────────────────────────────

const CASE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const SLACK_USER = /^U[A-Z0-9]{3,15}$/;
const CASE_KEYS = new Set([
  'id', 'category', 'conversation', 'thread', 'request', 'tools', 'expected',
  'strongSignal', 'askPermissionTrap', 'decideTrap', 'note',
]);

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function toolList(values, allowed, label) {
  check(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array.`);
  check(new Set(values).size === values.length, `${label} contains duplicates.`);
  for (const value of values) check(allowed.includes(value), `${label} names unknown tool ${value}.`);
}

/**
 * Validate the corpus shape and its calibration invariants. With
 * `requireCurrentGuide`, a guide edit that was not re-recorded here fails.
 */
export function validateCorpus(corpus, { requireCurrentGuide = true } = {}) {
  check(corpus && typeof corpus === 'object' && !Array.isArray(corpus), 'Corpus must be an object.');
  check(corpus.schemaVersion === CORPUS_SCHEMA_VERSION, 'Unsupported corpus schemaVersion.');
  check(typeof corpus.corpusVersion === 'string' && /^\d+\.\d+\.\d+$/.test(corpus.corpusVersion), 'Invalid corpusVersion.');
  check(typeof corpus.guideVersion === 'string' && /^sha256:[0-9a-f]{16}$/.test(corpus.guideVersion), 'Invalid guideVersion.');
  if (requireCurrentGuide) {
    const current = slackPresentationGuideVersion();
    check(corpus.guideVersion === current,
      `Corpus guideVersion ${corpus.guideVersion} is stale: SLACK_PRESENTATION_GUIDE is now ${current}. Re-run the live eval, then record the new guideVersion and bump corpusVersion in evals/slack-presentation/cases.json.`);
  }
  check(Array.isArray(corpus.cases) && corpus.cases.length >= 50, 'Corpus needs at least 50 cases.');
  const ids = new Set();
  const categories = new Map(CATEGORIES.map((category) => [category, 0]));
  let none = 0;
  let strong = 0;
  let traps = 0;
  for (const entry of corpus.cases) {
    check(entry && typeof entry === 'object', 'Every case must be an object.');
    const at = typeof entry.id === 'string' ? entry.id : '(unnamed case)';
    check(CASE_ID.test(entry.id ?? ''), `${at}: invalid case id.`);
    check(!ids.has(entry.id), `Duplicate case id: ${entry.id}`);
    ids.add(entry.id);
    for (const key of Object.keys(entry)) check(CASE_KEYS.has(key), `${at}: unknown field ${key}.`);
    check(categories.has(entry.category), `${at}: unknown category ${entry.category}.`);
    categories.set(entry.category, categories.get(entry.category) + 1);
    check(entry.conversation === undefined || ['channel', 'dm'].includes(entry.conversation),
      `${at}: conversation must be channel or dm.`);
    check(Array.isArray(entry.thread) && entry.thread.length <= 12, `${at}: thread must be an array of at most 12 messages.`);
    for (const [index, message] of entry.thread.entries()) {
      check(message && ['human', 'agent'].includes(message.role), `${at}: thread[${index}].role must be human or agent.`);
      check(message.role === 'agent' ? message.user === undefined : SLACK_USER.test(message.user ?? ''),
        `${at}: thread[${index}].user must be a Slack user id on human rows and absent on agent rows.`);
      check(typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 4_000,
        `${at}: thread[${index}].text must be 1–4000 characters.`);
    }
    check(entry.request && SLACK_USER.test(entry.request.user ?? ''), `${at}: request.user must be a Slack user id.`);
    check(typeof entry.request.text === 'string' && entry.request.text.trim().length >= 2 && entry.request.text.length <= 4_000,
      `${at}: request.text must be 2–4000 characters.`);
    if (entry.tools !== undefined) {
      check(entry.tools && typeof entry.tools === 'object' && !Array.isArray(entry.tools), `${at}: tools must be an object.`);
      for (const [name, output] of Object.entries(entry.tools)) {
        check(STUB_TOOL_NAMES.includes(name), `${at}: tools names unknown stub tool ${name}.`);
        check(output !== null && output !== undefined && JSON.stringify(output).length <= 20_000,
          `${at}: tools.${name} must be JSON of at most 20000 characters.`);
      }
    }
    const expected = entry.expected;
    check(expected && typeof expected === 'object', `${at}: expected is required.`);
    const everyTool = [...PRESENTATION_TOOL_NAMES, ...STUB_TOOL_NAMES];
    if (expected.presentation === 'none') {
      none += 1;
      for (const key of Object.keys(expected)) check(['presentation', 'forbidden'].includes(key), `${at}: expected.${key} is not allowed with presentation none.`);
      if (expected.forbidden !== undefined) toolList(expected.forbidden, STUB_TOOL_NAMES, `${at}: expected.forbidden`);
      check(!entry.strongSignal, `${at}: strongSignal needs an allowed component.`);
    } else {
      for (const key of Object.keys(expected)) check(['allowed', 'required_one_of', 'forbidden'].includes(key), `${at}: unknown expected.${key}.`);
      toolList(expected.allowed, PRESENTATION_TOOL_NAMES, `${at}: expected.allowed`);
      if (expected.required_one_of !== undefined) {
        toolList(expected.required_one_of, expected.allowed, `${at}: expected.required_one_of`);
      }
      if (expected.forbidden !== undefined) {
        toolList(expected.forbidden, everyTool, `${at}: expected.forbidden`);
        for (const name of expected.forbidden) check(!expected.allowed.includes(name), `${at}: ${name} is both allowed and forbidden.`);
      }
      if (entry.strongSignal) {
        strong += 1;
        check(Array.isArray(expected.required_one_of), `${at}: strongSignal cases name required_one_of.`);
      }
    }
    for (const flag of ['strongSignal', 'askPermissionTrap', 'decideTrap']) {
      check(entry[flag] === undefined || entry[flag] === true, `${at}: ${flag} is either true or absent.`);
    }
    if (entry.askPermissionTrap || entry.decideTrap) {
      if (entry.askPermissionTrap) traps += 1;
      const allowed = expected.allowed ?? [];
      for (const name of BLOCKING_TOOL_NAMES) {
        check(!allowed.includes(name), `${at}: a trap case cannot allow ${name}.`);
      }
    }
    check(entry.note === undefined || (typeof entry.note === 'string' && entry.note.length <= 400), `${at}: note must be at most 400 characters.`);
  }
  for (const [category, count] of categories) check(count >= 2, `Category ${category} needs at least two cases.`);
  const share = none / corpus.cases.length;
  check(share >= 0.4 && share <= 0.65, `About half the corpus should expect no component (now ${Math.round(share * 100)}%).`);
  check(strong >= 10, 'The corpus needs at least ten strong-signal cases.');
  check(traps >= 4, 'The corpus needs at least four askPermissionTrap cases.');
  return { cases: corpus.cases.length, none, strong, traps, categories: Object.fromEntries(categories) };
}

export function selectCases(corpus, { caseIds = [], categories = [] } = {}) {
  for (const id of caseIds) check(corpus.cases.some((entry) => entry.id === id), `Unknown case: ${id}`);
  for (const category of categories) check(CATEGORIES.includes(category), `Unknown category: ${category}`);
  return corpus.cases.filter((entry) =>
    (caseIds.length === 0 || caseIds.includes(entry.id)) &&
    (categories.length === 0 || categories.includes(entry.category)));
}

// ── Slack turn prompt ──────────────────────────────────────────────────────

/**
 * Render the case the way a Slack turn reaches the model: the production
 * prompt assembler over a synthetic thread whose rows end at the trigger.
 */
export function renderSlackTurnPrompt(entry) {
  const direct = entry.conversation === 'dm';
  const nowSeconds = Math.floor(FROZEN_NOW_MS / 1_000);
  const rows = entry.thread.map((message, index) => ({
    ts: `${nowSeconds - (entry.thread.length - index) * 150}.000100`,
    userId: message.role === 'agent' ? AGENT_USER_ID : message.user,
    text: message.text,
    role: message.role,
  }));
  const messageTs = `${nowSeconds}.000200`;
  const threadTs = rows[0]?.ts ?? messageTs;
  const messages = [
    ...rows.map((row) => ({ ...row, isTrigger: false, rootTs: threadTs })),
    { ts: messageTs, userId: entry.request.user, text: entry.request.text, role: 'human', isTrigger: true, rootTs: threadTs },
  ];
  const turn = {
    requesterTimezone: REQUESTER_TIMEZONE,
    workspaceId: WORKSPACE_ID,
    channelId: direct ? 'D0EVALDM' : 'C0EVALOPS',
    channelType: direct ? 'im' : 'channel',
    eventId: `Ev${entry.id.replace(/[^a-z0-9]/g, '').slice(0, 20).toUpperCase()}`,
    text: entry.request.text,
    userId: entry.request.user,
    messageTs,
    threadTs,
    source: direct ? 'dm_message' : 'app_mention',
    contextMode: 'thread',
  };
  const context = { mode: 'thread', messages, truncated: false, degradations: [] };
  return assembleSlackPrompt(turn, context, {
    slackApp: { botUserId: AGENT_USER_ID, displayName: AGENT_DISPLAY_NAME },
    currentRequestPolicyVersion: 2,
    progressiveStreamingOffered: false,
  });
}

// ── Scoring ────────────────────────────────────────────────────────────────

const REJECTED = new Set(['rejected_schema', 'rejected_validation']);

function isPresentation(call) {
  return PRESENTATION_TOOL_NAMES.includes(call.tool);
}

function normalizeProse(text) {
  return text
    .toLowerCase()
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/[*_`~>#]/g, ' ')
    .replace(/[‘’]/g, '\'')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The visible items a component already shows, for the prose-repetition check. */
export function componentItems(call) {
  const spec = call.spec ?? {};
  switch (call.tool) {
    case SLACK_ASK_USER_TOOL_NAME:
      return (spec.options ?? []).map(({ label }) => label);
    case SLACK_PRESENT_CARDS_TOOL_NAME:
      return (spec.cards ?? []).map(({ title }) => title);
    case SLACK_REQUEST_FORM_TOOL_NAME:
      return (spec.fields ?? []).map(({ label }) => label);
    case SLACK_PRESENT_TABLE_TOOL_NAME: {
      const index = spec.rowHeaderIndex ?? 0;
      return (spec.rows ?? []).map((row) => String(row[index] ?? ''));
    }
    case SLACK_PRESENT_DETAILS_TOOL_NAME:
      return String(spec.markdown ?? '')
        .split(/\n+|(?<=[.!?])\s+/)
        .map((line) => line.replace(/^[\s*\-\d.)]+/, '').trim())
        .filter((line) => line.length >= 24);
    default:
      return [];
  }
}

/** A component whose items reappear (≥60%) in the final prose repeats itself. */
export function proseRepetition(call, finalText) {
  const items = componentItems(call)
    .map(normalizeProse)
    .filter((item) => item.length >= 3);
  // Naming two choices in a question ("Oct 13 or Oct 20?") is natural and the
  // ask_user validator allows it; repetition means restating a list.
  if (items.length < 3) return undefined;
  const prose = normalizeProse(finalText ?? '');
  const repeated = items.filter((item) => prose.includes(item)).length;
  return { items: items.length, repeated, repeats: repeated / items.length >= 0.6 };
}

const PROSE_PROCEED_ASK = /\b(?:shall|should) i (?:go ahead|proceed|send|delete|deploy|post)\b|\bwant me to (?:go ahead|proceed)\b|\b(?:do you want|would you like) me to (?:go ahead|proceed|send it|delete it|deploy it)\b|\bconfirm (?:that )?you want me to\b/i;

/** Score one run of one case. `run.calls` are ordered tool calls with a status. */
export function scoreRun(entry, run) {
  const expected = entry.expected;
  const presentation = run.calls.filter(isPresentation);
  const accepted = presentation.filter((call) => call.status === 'accepted');
  const acceptedTools = [...new Set(accepted.map((call) => call.tool))];
  const expectNone = expected.presentation === 'none';
  const allowed = expected.allowed ?? [];
  const required = expected.required_one_of ?? allowed;
  const forbidden = expected.forbidden ?? [];
  const firstPresentation = presentation[0];
  const repetition = accepted
    .map((call) => ({ tool: call.tool, ...proseRepetition(call, run.finalText) }))
    .filter((result) => result.items !== undefined);
  const actedTools = run.calls
    .filter((call) => STUB_TOOLS[call.tool] && STUB_TOOLS[call.tool].kind !== 'read' && call.status === 'ok')
    .map((call) => call.tool);
  return {
    expectNone,
    componentsAccepted: acceptedTools,
    componentsAttempted: [...new Set(presentation.map((call) => call.tool))],
    overUse: expectNone && accepted.length > 0,
    strongSignal: entry.strongSignal === true,
    strongHit: entry.strongSignal === true ? acceptedTools.some((tool) => required.includes(tool)) : undefined,
    offList: expectNone ? [] : acceptedTools.filter((tool) => !allowed.includes(tool)),
    forbiddenUsed: run.calls.filter((call) => forbidden.includes(call.tool)).map((call) => call.tool),
    presentationCalls: presentation.length,
    rejectedCalls: presentation.filter((call) => REJECTED.has(call.status)).length,
    firstTryRejected: firstPresentation ? REJECTED.has(firstPresentation.status) : undefined,
    firstTryError: firstPresentation && REJECTED.has(firstPresentation.status) ? firstPresentation.error : undefined,
    budgetRejected: presentation.filter((call) => call.status === 'rejected_budget').length,
    afterQuestionCalls: run.calls.filter((call) => call.status === 'rejected_after_question').length,
    repetition,
    repeats: repetition.some((result) => result.repeats),
    permissionAsk: entry.askPermissionTrap === true
      ? presentation.some((call) => BLOCKING_TOOL_NAMES.includes(call.tool))
      : undefined,
    decideAsk: entry.decideTrap === true
      ? presentation.some((call) => BLOCKING_TOOL_NAMES.includes(call.tool))
      : undefined,
    proseProceedAsk: entry.askPermissionTrap === true
      ? actedTools.length === 0 && PROSE_PROCEED_ASK.test(run.finalText ?? '')
      : undefined,
    actedTools,
    emptyReply: !run.finalText?.trim() && !accepted.some((call) => BLOCKING_TOOL_NAMES.includes(call.tool)),
  };
}

function rate(count, total) {
  return { count, total, rate: total === 0 ? null : count / total };
}

/** Per-model metrics over scored runs, with the gate. */
export function summarizeRuns(runs) {
  const scored = runs.filter((run) => !run.error);
  const errors = runs.length - scored.length;
  const noneRuns = scored.filter((run) => run.score.expectNone);
  const strongRuns = scored.filter((run) => run.score.strongSignal);
  const presentingRuns = scored.filter((run) => run.score.presentationCalls > 0);
  const repetitionRuns = scored.filter((run) => run.score.repetition.length > 0);
  const trapRuns = scored.filter((run) => run.score.permissionAsk !== undefined);
  const decideRuns = scored.filter((run) => run.score.decideAsk !== undefined);
  const componentUsage = Object.fromEntries(PRESENTATION_TOOL_NAMES.map((name) => [name, 0]));
  for (const run of scored) for (const tool of run.score.componentsAccepted) componentUsage[tool] += 1;
  const metrics = {
    runs: runs.length,
    errors,
    overUse: rate(noneRuns.filter((run) => run.score.overUse).length, noneRuns.length),
    strongSignalRecall: rate(strongRuns.filter((run) => run.score.strongHit).length, strongRuns.length),
    firstTrySchemaError: rate(presentingRuns.filter((run) => run.score.firstTryRejected).length, presentingRuns.length),
    proseRepetition: rate(repetitionRuns.filter((run) => run.score.repeats).length, repetitionRuns.length),
    permissionAsks: rate(trapRuns.filter((run) => run.score.permissionAsk).length, trapRuns.length),
    proseProceedAsks: rate(trapRuns.filter((run) => run.score.proseProceedAsk).length, trapRuns.length),
    decideAsks: rate(decideRuns.filter((run) => run.score.decideAsk).length, decideRuns.length),
    forbiddenUses: scored.reduce((sum, run) => sum + run.score.forbiddenUsed.length, 0),
    offListRuns: scored.filter((run) => run.score.offList.length > 0).length,
    rejectedCalls: rate(
      scored.reduce((sum, run) => sum + run.score.rejectedCalls, 0),
      scored.reduce((sum, run) => sum + run.score.presentationCalls, 0),
    ),
    budgetRejections: scored.reduce((sum, run) => sum + run.score.budgetRejected, 0),
    afterQuestionCalls: scored.reduce((sum, run) => sum + run.score.afterQuestionCalls, 0),
    emptyReplies: scored.filter((run) => run.score.emptyReply).length,
    componentUsage,
  };
  const failures = [];
  if (errors > 0) failures.push(`${errors} run(s) errored`);
  if (metrics.overUse.rate !== null && metrics.overUse.rate > TARGETS.overUseRateMax) failures.push('over-use');
  if (metrics.strongSignalRecall.rate !== null && metrics.strongSignalRecall.rate < TARGETS.strongSignalRecallMin) failures.push('strong-signal recall');
  if (metrics.firstTrySchemaError.rate !== null && metrics.firstTrySchemaError.rate > TARGETS.firstTrySchemaErrorRateMax) failures.push('first-try schema errors');
  if (metrics.proseRepetition.rate !== null && metrics.proseRepetition.rate > TARGETS.proseRepetitionRateMax) failures.push('prose repetition');
  if (metrics.permissionAsks.count > TARGETS.permissionAsksMax) failures.push('permission asks');
  return { metrics, gate: { passed: failures.length === 0, failures } };
}

function percent(value) {
  return value.rate === null ? '—' : `${(value.rate * 100).toFixed(1)}% (${value.count}/${value.total})`;
}

/** A compact fixed-width table: one row per model. */
export function formatSummaryTable(models) {
  const header = ['model', 'over-use ≤5%', 'strong recall ≥80%', '1st-try schema err ≤10%', 'prose repeat ≤10%', 'permission asks =0', 'forbidden', 'errors', 'gate'];
  const rows = models.map(({ model, summary }) => {
    const m = summary.metrics;
    return [
      model,
      percent(m.overUse),
      percent(m.strongSignalRecall),
      percent(m.firstTrySchemaError),
      percent(m.proseRepetition),
      `${m.permissionAsks.count}/${m.permissionAsks.total}`,
      String(m.forbiddenUses),
      String(m.errors),
      summary.gate.passed ? 'PASS' : `FAIL: ${summary.gate.failures.join(', ')}`,
    ];
  });
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}
