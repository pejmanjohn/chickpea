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
 * The report card: show_test_report's result. One row for each practice
 * question, with the verdict the model gave it, and the verdict from the
 * first round when the model sent one. A press opens a row in place to the
 * Agent's answer as Slack would show it, which the result carries in its
 * `_meta`, where the host's model never reads it. The card waits for
 * nothing: it calls no tool, tells the host's model nothing and keeps nothing.
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
      /** The rows open now. */
      open: number[];
    };

export type State = CardState<View>;
export type Action = `toggle:${number}`;
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
  const index = Number(action.slice('toggle:'.length));
  if (!view.answers || !Number.isInteger(index) || index < 0 || index >= view.report.runs.length) return stay(state);
  const open = view.open.includes(index) ? view.open.filter((each) => each !== index) : [...view.open, index];
  return show({ ...view, open });
}

/** The answers in the result's `_meta`, one for each run, or none: a result is untrusted. */
function answersOf(value: unknown, runs: number): Array<string | null> | undefined {
  if (!Array.isArray(value) || value.length !== runs) return undefined;
  return value.every((answer) => answer === null || typeof answer === 'string') ? value as Array<string | null> : undefined;
}

function isReport(value: unknown): value is Report {
  const text = (field: unknown) => field === undefined || typeof field === 'string';
  return isRecord(value) && isRecord(value.agent) && typeof value.agent.name === 'string' &&
    typeof value.summary === 'string' && text(value.next) && Array.isArray(value.runs) && value.runs.length > 0 &&
    value.runs.every((run) => isRecord(run) && typeof run.question === 'string' && typeof run.verdict === 'string' &&
      text(run.note) && text(run.before));
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
  const count = report.runs.length;
  const next = report.next?.trim().replace(/^next:\s*/i, '');
  return {
    avatar: 'agent',
    avatarUrl: httpsUrl(report.agent.avatarUrl),
    title: `Tested ${report.agent.name} · ${count} ${count === 1 ? 'question' : 'questions'}`,
    subtitle: [{ text: report.summary }],
    blocks: [
      { kind: 'rows', rows: report.runs.map((run, index) => runRow(view, run, index)) },
      ...next ? [{ kind: 'note' as const, text: `Next: ${next}` }] : [],
    ],
    buttons: [],
  };
}

/**
 * A question, its verdict as a chip, and the first round's beside it when it
 * differs. With the answers, the row opens to the Agent's answer and the
 * model's note; without them, the note is the row's own line.
 */
function runRow(view: Shown, run: Report['runs'][number], index: number): Row<Action> {
  const was = changed(run.before, run.verdict) ? `was: ${run.before!.trim()}` : undefined;
  const base = { icon: 'tile' as const, tile: String(index + 1), title: run.question || 'A practice question', chip: run.verdict };
  if (!view.answers) return { ...base, ...was || run.note ? { detail: [was, run.note].filter(Boolean).join(' · ') } : {} };
  const open = view.open.includes(index);
  return {
    ...base,
    ...was ? { detail: was } : {},
    control: { label: open ? 'Hide answer' : 'Show answer', action: `toggle:${index}`, style: 'toggle', expanded: open },
    ...open ? { open: opened(view, run, view.answers[index] ?? null) } : {},
  };
}

/** A first-round verdict worth showing: one, and not the same words as the verdict now. */
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
