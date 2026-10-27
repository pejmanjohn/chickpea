/**
 * The private smoke ledger: one JSON line per `npm run verify:smoke` run,
 * appended to an owner-only file outside Git. Cloud pins only Core commits
 * with a passed line (release-speed ruling R6), so its admission reads this
 * file through `readSmokeLedger` and `smokePassed`.
 *
 *   {
 *     "schema": "chickpea-smoke-ledger/v1",
 *     "coreSha": "<40 hex>",            // the deployed candidate's commit
 *     "lane": "amber",
 *     "profile": "core" | "sandbox",
 *     "workerVersion": "<uuid>" | null, // the serving version the cases ran on
 *     "result": "pass" | "fail",        // pass only when every case passed
 *     "startedAt": "ISO", "finishedAt": "ISO",
 *     "durationMs": 0, "deployMs": 0 | null,
 *     "cases": [{ "id": "dm-reply", "result": "pass" | "fail" | "blocked",
 *                 "category": null | "product" | "model" | "tool", "durationMs": 0 }],
 *     "evidence": "/abs/private/run/dir"
 *   }
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { SMOKE_CASES } from './smoke-cases.mjs';

export const SMOKE_LEDGER_SCHEMA = 'chickpea-smoke-ledger/v1';
export const CASE_RESULTS = Object.freeze(['pass', 'fail', 'blocked']);
export const FAILURE_CATEGORIES = Object.freeze(['product', 'model', 'tool']);

export function defaultSmokeLedger(home = homedir()) {
  return path.join(home, '.chickpea', 'verification', 'smoke-ledger.jsonl');
}

const SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isDuration = (value) => Number.isSafeInteger(value) && value >= 0;

/** The entry when `value` is a well-formed ledger line, else `undefined`. */
export function parseSmokeEntry(value) {
  if (!value || typeof value !== 'object' || value.schema !== SMOKE_LEDGER_SCHEMA) return undefined;
  const { coreSha, lane, profile, workerVersion, result, startedAt, finishedAt, durationMs, deployMs, cases, evidence } = value;
  if (!SHA.test(coreSha ?? '') || typeof lane !== 'string' || !['core', 'sandbox'].includes(profile)) return undefined;
  if (workerVersion !== null && !VERSION.test(workerVersion ?? '')) return undefined;
  if (!['pass', 'fail'].includes(result) || !isIso(startedAt) || !isIso(finishedAt)) return undefined;
  if (!isDuration(durationMs) || (deployMs !== null && !isDuration(deployMs)) || typeof evidence !== 'string') return undefined;
  if (!Array.isArray(cases) || cases.length === 0) return undefined;
  for (const entry of cases) {
    if (typeof entry?.id !== 'string' || !CASE_RESULTS.includes(entry.result) || !isDuration(entry.durationMs)) return undefined;
    if (entry.category !== null && !FAILURE_CATEGORIES.includes(entry.category)) return undefined;
  }
  if ((result === 'pass') !== cases.every((entry) => entry.result === 'pass')) return undefined;
  return value;
}

/** Appends one line, creating the owner-only directory and file on first use. */
export function appendSmokeLedger(entry, file = defaultSmokeLedger()) {
  if (!parseSmokeEntry(entry)) throw new Error('Refusing to write a malformed smoke ledger line.');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Every well-formed line, oldest first; a malformed line is skipped, never trusted. */
export function readSmokeLedger(file = defaultSmokeLedger()) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const entry = parseSmokeEntry(JSON.parse(line));
      return entry ? [entry] : [];
    } catch {
      return [];
    }
  });
}

/** Whether some run on `sha` passed every fixed case; a run of a chosen subset never counts. */
export function smokePassed(entries, sha, caseIds = SMOKE_CASES.map((entry) => entry.id)) {
  return entries.some((entry) => entry.coreSha === sha && entry.result === 'pass' &&
    caseIds.every((id) => entry.cases.some((outcome) => outcome.id === id)));
}
