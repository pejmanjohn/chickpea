import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Verification tooling JavaScript helper.
import { buildCase } from '../../../scripts/lib/verification-record-builders.mjs';
// @ts-expect-error Verification tooling JavaScript helper.
import { validateSpec } from '../../../scripts/lib/verification-record.mjs';
// @ts-expect-error Verification tooling JavaScript helper.
import { runRecordCli } from '../../../scripts/verification-record.mjs';
import type { CaseOutcome } from './analysis.ts';
import type { MatrixCaseId } from './types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Product intent for each matrix case, written into the private run spec so
 * `/chickpea-live-verification` records one attempt per case around the
 * concurrent batch. Same record format as every other attended case.
 */
export const CASE_CONTRACTS: Record<MatrixCaseId, { title: string; originalRequest: string; expectedOutcome: string }> = {
  parity: {
    title: 'Runner matrix: parity (channel, DM, thread follow-up)',
    originalRequest: 'A channel mention, a DM and a mention-free thread follow-up each deliver one final on the runner stack.',
    expectedOutcome: 'Exactly one final in each thread, no failure notice.',
  },
  'first-status': {
    title: 'Runner matrix: first visible status while a long turn runs',
    originalRequest: 'Side threads (two Agents, stacked threads of one Agent in one channel, one DM) mentioned while a long turn runs show their first status quickly.',
    expectedOutcome: 'Mention to first visible status max <= 10 s and p95 <= 5 s; native then custom status; one final each; stage breakdown recorded.',
  },
  'long-turns': {
    title: 'Runner matrix: concurrent long turns with an interruption',
    originalRequest: 'Concurrent long streamed answers survive a mid-turn Flue interruption (same-candidate redeploy) and deliver in full.',
    expectedOutcome: 'Exactly one final each with full content (continuations when > 12k chars, attribution footer last), no failure notice.',
  },
  'redeploy-mid-turn': {
    title: 'Runner matrix: sequential redeploys mid-turn',
    originalRequest: 'A long turn running across a guarded same-candidate redeploy resumes on the new version; a probe mentioned during the deploy responds.',
    expectedOutcome: 'One full final per round, no failure notice; probe first status <= 10 s; resume time recorded.',
  },
  'rate-limit': {
    title: 'Runner matrix: burst of simultaneous mentions',
    originalRequest: 'A burst of mentions at once is admitted without drops or failure finals under the shared gateway rate limit.',
    expectedOutcome: 'Every mention gets one final, none dropped at routing, no failure notice; gateway rate-limit lines counted.',
  },
};

export const DEFAULT_CLEANUP = 'Retain run-marked Slack messages in the QA channel and Chickpea DM as attributed QA output; stop the runner-matrix tail; leave the lane serving the candidate; no other resources are created.';

export function recordCaseId(prefix: string, caseId: MatrixCaseId): string {
  return `${prefix}${caseId}`;
}

export function addSpecCases(spec: Record<string, any>, options: { context: string; requires: string[]; prefix: string; cases: MatrixCaseId[]; cleanup?: string }): Record<string, any> {
  const next = structuredClone(spec);
  next.cases ??= [];
  for (const caseId of options.cases) {
    const id = recordCaseId(options.prefix, caseId);
    if (next.cases.some((entry: { id: string }) => entry.id === id)) throw new Error(`Spec already has case ${id}.`);
    const contract = CASE_CONTRACTS[caseId];
    next.cases.push(buildCase(next, {
      case: id, title: contract.title, context: options.context, area: ['delivery'], require: options.requires, proof: ['slack'],
      maxAttempts: '2', maxWaitMs: '120000', minObservationMs: '0',
      originalRequest: contract.originalRequest, expectedOutcome: contract.expectedOutcome, cleanup: options.cleanup ?? DEFAULT_CLEANUP,
    }));
  }
  validateSpec(next);
  return next;
}

function recordCli(argv: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const code = runRecordCli(argv, ROOT, { stdout: (value: string) => { out += value; }, stderr: (value: string) => { err += value; } });
  return { code, out, err };
}

/** Record `begin` for each case before any message is sent. Reuses an attempt this run already opened. */
export function beginAttempts(runPath: string, prefix: string, cases: MatrixCaseId[], existing: Record<string, string>, reason?: string): Record<string, string> {
  const attempts = { ...existing };
  for (const caseId of cases) {
    if (attempts[caseId]) continue;
    const argv = ['begin', '--run', runPath, '--case', recordCaseId(prefix, caseId)];
    if (reason) argv.push('--reason', reason);
    const { code, out, err } = recordCli(argv);
    const id = /"id":\s*"([^"]+)"/.exec(out)?.[1];
    if (code !== 0 || !id) throw new Error(`record begin refused for ${recordCaseId(prefix, caseId)}: ${err.trim() || out.trim()}`);
    attempts[caseId] = id;
  }
  return attempts;
}

export function finishAttempts(runPath: string, attempts: Record<string, string>, outcomes: CaseOutcome[], evidence: { results: string; markdown: string; slack: string; extra: string[] }, observedAt: Date): Array<{ caseId: string; code: number; message: string }> {
  const out: Array<{ caseId: string; code: number; message: string }> = [];
  for (const outcome of outcomes) {
    const attempt = attempts[outcome.caseId];
    if (!attempt) { out.push({ caseId: outcome.caseId, code: 2, message: 'no open attempt recorded by run' }); continue; }
    const argv = ['finish', '--run', runPath, '--attempt', attempt, '--result', outcome.result, '--summary', outcome.summary.slice(0, 3000),
      '--evidence', evidence.results, '--evidence', evidence.markdown, ...evidence.extra.flatMap((path) => ['--evidence', path]),
      '--proof', `slack=${evidence.slack}`, '--observed-at', observedAt.toISOString(), '--cost-usd', 'unknown'];
    if (outcome.category) argv.push('--category', outcome.category);
    if (outcome.completedAt) argv.push('--completed-at', new Date(outcome.completedAt).toISOString());
    const { code, out: stdout, err } = recordCli(argv);
    out.push({ caseId: outcome.caseId, code, message: code === 0 ? 'recorded' : (err.trim() || stdout.trim()).slice(0, 400) });
  }
  return out;
}
