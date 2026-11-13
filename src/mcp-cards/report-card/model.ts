import type { z } from 'zod';

import type * as schemas from '../../management/mcp-v5/schemas.ts';
import {
  errorOf,
  httpsUrl,
  isRecord,
  NOTHING,
  presentSafely,
  sequenced,
  show,
  stay,
  type Block,
  type CardEvent,
  type CardState,
  type Next,
  type Presentation,
  type Row,
  type ToolResult,
} from '../card-model.ts';
import { plainText } from '../first-answer.ts';

/**
 * The report card: show_test_report's result, the one card of a test drive.
 * The model calls it after each round with the whole report so far, and a
 * host redraws the card in place, so the card keeps nothing between calls.
 * While testing goes on (a `round`, not `final`) it reads "Testing", with the
 * changes saved so far above the questions; at the end it reads "Tested",
 * with the questions first and the changes after them in order. One row for
 * each question, with the verdict the model gave it and its earlier verdicts
 * when they differ. A press opens a question in place to the Agent's answer as
 * Slack would show it, which the result carries in its `_meta`, where the
 * host's model never reads it, and opens a change to the model's reason for
 * it. The card waits for nothing: it calls no tool, tells the host's model
 * nothing and keeps nothing.
 */

type Report = z.infer<typeof schemas.showTestReportOutput>;

export type View =
  | { kind: 'waiting' }
  | { kind: 'notice'; title: string }
  | {
      kind: 'report';
      report: Report;
      /** Each run's answer, null for one that did not finish; none when the host dropped them. */
      answers?: Array<string | null>;
      /** The rows open now, by the press that opens each. */
      open: Action[];
    };

export type State = CardState<View>;
/** A question's row opens to its answer, a change's to its reason. */
export type Action = `toggle:${number}` | `why:${number}`;
export type Event = CardEvent<Action>;

type Shown = Extract<View, { kind: 'report' }>;

export const INITIAL: State = { view: { kind: 'waiting' }, busy: false, seq: 0 };

export const step = sequenced(transition);

function transition(state: State, event: Event): Next<View> {
  switch (event.type) {
    case 'result':
      return fromResult(event.result);
    case 'press':
      return state.view.kind === 'report' ? toggle(state, state.view, event.action) : stay(state);
    case 'no_result':
      return state.view.kind === 'waiting' ? show<View>(NOTHING) : stay(state);
    default:
      return stay(state);
  }
}

function fromResult(result: ToolResult): Next<View> {
  const failure = errorOf(result);
  if (failure) return show({ kind: 'notice', title: failure });
  const report = result.structuredContent;
  if (!isReport(report)) return show<View>(NOTHING);
  const answers = answersOf(result._meta?.['chickpea/answers'], report.runs.length);
  return show({ kind: 'report', report, ...answers ? { answers } : {}, open: [] });
}

function toggle(state: State, view: Shown, action: Action): Next<View> {
  if (!opens(view, action)) return stay(state);
  const open = view.open.includes(action) ? view.open.filter((each) => each !== action) : [...view.open, action];
  return show({ ...view, open });
}

/** A row that is there and has something to open: an answer the host passed on, or a change's reason. */
function opens(view: Shown, action: Action): boolean {
  const [kind, at] = action.split(':');
  const index = Number(at);
  if (!Number.isInteger(index) || index < 0) return false;
  if (kind === 'why') return index < (view.report.changes?.length ?? 0);
  const run = view.report.runs[index];
  return kind === 'toggle' && view.answers !== undefined && run !== undefined && !run.gone;
}

/** The answers in the result's `_meta`, one for each run, or none: a result is untrusted. */
function answersOf(value: unknown, runs: number): Array<string | null> | undefined {
  if (!Array.isArray(value) || value.length !== runs) return undefined;
  return value.every((answer) => answer === null || typeof answer === 'string') ? value as Array<string | null> : undefined;
}

function isReport(value: unknown): value is Report {
  const text = (field: unknown) => field === undefined || typeof field === 'string';
  const flag = (field: unknown) => field === undefined || field === true;
  if (!isRecord(value) || !isRecord(value.agent)) return false;
  const { agent, runs, changes, round } = value;
  return typeof agent.name === 'string' && text(agent.handle) && typeof value.summary === 'string' && text(value.next) &&
    Array.isArray(runs) && runs.length > 0 &&
    runs.every((run) => isRecord(run) && typeof run.question === 'string' && typeof run.verdict === 'string' &&
      text(run.note) && text(run.before) && flag(run.gone)) &&
    (round === undefined || Number.isInteger(round)) && flag(value.final) &&
    (changes === undefined || (Array.isArray(changes) &&
      changes.every((change) => isRecord(change) && typeof change.what === 'string' && typeof change.why === 'string' && text(change.effect))));
}

// What the card shows.

export const present = presentSafely(presentView);

function presentView(state: State): Presentation<Action> {
  const base = { busy: state.busy, error: state.error };
  const { view } = state;
  switch (view.kind) {
    case 'waiting':
      return { ...base, avatar: 'none', title: 'Loading…', blocks: [], buttons: [] };
    case 'notice':
      return { ...base, avatar: 'none', title: view.title, blocks: [], buttons: [] };
    case 'report':
      return { ...base, ...presentReport(view) };
  }
}

function presentReport(view: Shown): Omit<Presentation<Action>, 'busy' | 'error'> {
  const { report } = view;
  const { name, handle } = report.agent;
  const count = report.runs.length;
  const changes = report.changes ?? [];
  const testing = report.round !== undefined && report.final !== true;
  const next = report.next?.trim().replace(/^next:\s*/i, '');
  const rounds = report.round === undefined ? '' : ` · ${plural(report.round, 'round')}`;
  const questionBlocks: Array<Block<Action>> = [
    ...changes.length ? [{ kind: 'section' as const, label: 'Questions' }] : [],
    { kind: 'rows', rows: report.runs.map((run, index) => runRow(view, run, index)) },
  ];
  const changeBlocks: Array<Block<Action>> = changes.length
    ? [
        { kind: 'section', label: testing ? 'Changes so far' : 'What changed, in order' },
        { kind: 'rows', rows: changes.map((change, index) => changeRow(view, change, index)) },
      ]
    : [];
  return {
    avatar: 'agent',
    avatarUrl: httpsUrl(report.agent.avatarUrl),
    title: testing ? `Testing ${name} · round ${report.round}` : `Tested ${name} · ${plural(count, 'question')}${rounds}`,
    subtitle: [{
      text: [handle ? `@${handle}` : undefined, report.summary, changes.length ? `${plural(changes.length, 'change')} saved` : undefined]
        .filter(Boolean).join(' · '),
    }],
    blocks: [
      ...testing ? [...changeBlocks, ...questionBlocks] : [...questionBlocks, ...changeBlocks],
      ...next ? [{ kind: 'note' as const, text: `Next: ${next}` }] : [],
    ],
    buttons: [],
  };
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/**
 * A question, its verdict as a chip, and its earlier verdicts beside it when
 * they differ. With the answers, the row opens to the Agent's answer and the
 * model's note; without them, or once its run is gone, the note is the row's
 * own line.
 */
function runRow(view: Shown, run: Report['runs'][number], index: number): Row<Action> {
  const before = changed(run.before, run.verdict) ? trail(view.report, run.before!) : undefined;
  const title = run.gone ? 'A question asked over an hour ago' : run.question || 'A practice question';
  const base = { icon: 'tile' as const, tile: String(index + 1), title, chip: run.verdict };
  if (!view.answers || run.gone) return { ...base, ...before || run.note ? { detail: [before, run.note].filter(Boolean).join(' · ') } : {} };
  const action = `toggle:${index}` as const;
  const open = view.open.includes(action);
  return {
    ...base,
    ...before ? { detail: before } : {},
    control: { label: open ? 'Hide answer' : 'Show answer', action, style: 'toggle', expanded: open },
    ...open ? { open: opened(view, run, view.answers[index] ?? null) } : {},
  };
}

/**
 * A report with rounds gets each question's earlier verdicts as the model
 * wrote them ("round 1: fails"). One without is a single round against the
 * first, as the report was before rounds, whose before is that one verdict.
 */
function trail(report: Report, before: string): string {
  return report.round === undefined ? `was: ${before.trim()}` : before.trim();
}

/** A change saved during the test drive, with what it did once tested, opening to the model's reason for it. */
function changeRow(view: Shown, change: NonNullable<Report['changes']>[number], index: number): Row<Action> {
  const action = `why:${index}` as const;
  const open = view.open.includes(action);
  return {
    icon: 'tile',
    tile: String(index + 1),
    title: change.what,
    ...change.effect ? { detail: change.effect } : {},
    control: { label: open ? 'Hide why' : 'Show why', action, style: 'toggle', expanded: open },
    ...open ? { open: [{ kind: 'text', text: change.why }] } : {},
  };
}

/** Earlier verdicts worth showing: some, and not the same words as the verdict now. */
function changed(before: string | undefined, verdict: string): boolean {
  const was = before?.trim().toLowerCase();
  return was !== undefined && was !== '' && was !== verdict.trim().toLowerCase();
}

function opened(view: Shown, run: Report['runs'][number], answer: string | null): Array<Block<Action>> {
  return [
    answer === null
      ? { kind: 'text', text: `${view.report.agent.name} didn't finish answering this one.` }
      : { kind: 'exchange', ask: run.question, answer: shownAnswer(answer), agent: view.report.agent.name, whole: true },
    ...run.note ? [{ kind: 'note' as const, text: run.note }] : [],
  ];
}

/** As the first answer draws one: Chickpea escapes a `<` for clients that render it, and the card draws text. */
function shownAnswer(reply: string): string {
  return plainText(reply.replaceAll('&lt;', '<')).trim() || 'It gave no answer.';
}
