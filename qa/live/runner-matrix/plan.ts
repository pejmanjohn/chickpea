import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_FAILURE_TEXT,
  DURABLE_RECOVERY_FAILURE_TEXT,
  PROVIDER_FAILURE_TEXT,
} from '../../../src/slack/web-client-presenter.ts';
import { GATEWAY_OFFLINE_NOTICE } from './analysis.ts';
import { MATRIX_CASES, type MatrixCaseId, type MatrixParams, type MatrixPlan, type MatrixSpec, type PlanHook, type PlanItem } from './types.ts';

export const DEFAULT_SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'spec.json');

/** Product failure notices a final must never be; matched by prefix in readback. */
export const FAILURE_SIGNATURES: ReadonlyArray<{ key: string; prefix: string }> = Object.freeze([
  { key: 'agent_failure', prefix: AGENT_FAILURE_TEXT.slice(0, 60) },
  { key: 'durable_recovery_failure', prefix: DURABLE_RECOVERY_FAILURE_TEXT.slice(0, 60) },
  { key: 'provider_failure', prefix: PROVIDER_FAILURE_TEXT.slice(0, 60) },
  GATEWAY_OFFLINE_NOTICE,
]);

const TAG = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export function readSpec(path: string = DEFAULT_SPEC_PATH): MatrixSpec {
  const spec = JSON.parse(readFileSync(path, 'utf8')) as MatrixSpec;
  if (spec.schema !== 'chickpea-runner-matrix-spec/v1') throw new Error(`${path}: not a runner-matrix spec`);
  return spec;
}

export function parseCaseList(value: string | undefined): MatrixCaseId[] {
  if (!value || value === 'all') return [...MATRIX_CASES];
  const cases = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of cases) if (!(MATRIX_CASES as readonly string[]).includes(entry)) throw new Error(`Unknown case: ${entry}`);
  return MATRIX_CASES.filter((entry) => cases.includes(entry));
}

export function defaultTag(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `RM-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

export function buildPlan(spec: MatrixSpec, params: MatrixParams, now = new Date()): MatrixPlan {
  if (!TAG.test(params.tag)) throw new Error('Tag must be 3-32 letters, digits or dashes.');
  for (const [ref, handle] of Object.entries(params.agents)) {
    if (!HANDLE.test(handle)) throw new Error(`Agent ${ref} handle is not a Slack handle.`);
  }
  for (const [name, value] of [['channel', params.channel], ['workspace', params.workspaceId], ['worker', params.worker], ['bot user', params.botUserId]] as const) {
    if (!value) throw new Error(`Missing ${name}; resolve it from the lane registry or the private params file.`);
  }
  const scale = params.timeScale ?? 1;
  if (!(scale > 0 && scale <= 1)) throw new Error('timeScale must be in (0, 1].');
  const at = (ms: number) => Math.round(ms * scale);
  const enabled = new Set(params.cases);
  const count = (id: keyof NonNullable<MatrixParams['counts']>, fallback: number) => {
    const value = params.counts?.[id] ?? fallback;
    if (!Number.isInteger(value) || value < 1 || value > 40) throw new Error(`${id} count must be 1-40.`);
    return value;
  };
  const items: PlanItem[] = [];
  const hooks: PlanHook[] = [];
  const add = (item: Omit<PlanItem, 'marker' | 'text'> & { prompt: string }) => {
    const marker = `[${params.tag}:${item.label}]`;
    const mention = item.agent ? '{mention} ' : '';
    const { prompt, ...rest } = item;
    items.push({ ...rest, marker, text: `${mention}${prompt} ${marker}` });
  };

  const c = spec.cases;
  if (enabled.has('parity')) {
    add({ label: 'P-CH', caseId: 'parity', role: 'root', agent: 'a', where: 'channel', atMs: at(c.parity.atMs), long: false, prompt: spec.prompts.parityChannel });
    add({ label: 'P-DM', caseId: 'parity', role: 'root', agent: 'b', where: 'dm', atMs: at(c.parity.dmAtMs), long: false, prompt: spec.prompts.parityDm });
    add({ label: 'P-FU', caseId: 'parity', role: 'followup', agent: null, where: 'channel', after: { label: 'P-CH', delayMs: at(c.parity.followupDelayMs) }, long: false, prompt: spec.prompts.parityFollowup });
  }
  if (enabled.has('first-status')) {
    const fs = c['first-status'];
    add({ label: 'FS-A', caseId: 'first-status', role: 'anchor', agent: 'a', where: 'channel', atMs: at(fs.anchorAtMs), long: true, prompt: spec.prompts.long });
    if (fs.warmupAtMs !== null) add({ label: 'FS-W', caseId: 'first-status', role: 'warmup', agent: 'b', where: 'dm', atMs: at(fs.warmupAtMs), long: false, prompt: spec.prompts.short });
    const n = count('first-status', fs.count);
    for (let i = 0; i < n; i += 1) {
      const side = fs.sides[i % fs.sides.length]!;
      add({ label: `FS-${i + 1}`, caseId: 'first-status', role: 'side', agent: side.agent, where: side.where, atMs: at(fs.sidesAtMs + i * fs.spacingMs), long: false, prompt: spec.prompts.short });
    }
  }
  if (enabled.has('long-turns')) {
    const lt = c['long-turns'];
    const n = count('long-turns', lt.count);
    for (let i = 0; i < n; i += 1) {
      add({ label: `LT-${i + 1}`, caseId: 'long-turns', role: 'long', round: i + 1, agent: i % 2 === 0 ? 'a' : 'b', where: 'channel', atMs: at(lt.atMs + i * lt.spacingMs), long: true, prompt: spec.prompts.long });
    }
    if (lt.interruptAfterMs !== null) hooks.push({ id: 'interrupt-long-turns', kind: 'redeploy', caseId: 'long-turns', atMs: at(lt.atMs + lt.interruptAfterMs) });
  }
  if (enabled.has('rate-limit')) {
    const rl = c['rate-limit'];
    const n = count('rate-limit', rl.count);
    for (let i = 0; i < n; i += 1) {
      add({ label: `RL-${i + 1}`, caseId: 'rate-limit', role: 'burst', agent: i % 2 === 0 ? 'a' : 'b', where: i % 6 === 5 ? 'dm' : 'channel', atMs: at(rl.atMs + i * rl.spacingMs), long: false, prompt: spec.prompts.burst });
    }
  }
  if (enabled.has('redeploy-mid-turn')) {
    const rd = c['redeploy-mid-turn'];
    const n = count('redeploy-mid-turn', rd.count);
    for (let i = 0; i < n; i += 1) {
      const start = rd.atMs + i * rd.roundGapMs;
      add({ label: `RD${i + 1}-A`, caseId: 'redeploy-mid-turn', role: 'redeploy-a', round: i + 1, agent: 'a', where: 'channel', atMs: at(start), long: true, prompt: spec.prompts.long });
      add({ label: `RD${i + 1}-B`, caseId: 'redeploy-mid-turn', role: 'redeploy-b', round: i + 1, agent: 'b', where: 'channel', atMs: at(start + rd.probeAfterMs), long: false, prompt: spec.prompts.short });
      hooks.push({ id: `redeploy-${i + 1}`, kind: 'redeploy', caseId: 'redeploy-mid-turn', round: i + 1, atMs: at(start + rd.deployAfterMs) });
    }
  }
  if (items.length === 0) throw new Error('No cases selected.');

  const expected = (item: PlanItem) => at(item.role === 'redeploy-a' ? spec.expectedTurnMs.redeploy
    : item.long ? spec.expectedTurnMs.long : spec.expectedTurnMs.short);
  const byLabel = new Map(items.map((item) => [item.label, item]));
  const startOf = (item: PlanItem): number => item.atMs ?? (() => {
    const parent = byLabel.get(item.after!.label)!;
    return startOf(parent) + expected(parent) + item.after!.delayMs;
  })();
  const endMs = Math.max(...items.map((item) => startOf(item) + expected(item)), ...hooks.map((hook) => hook.atMs))
    + at(spec.defaults.collectGraceMs);

  return {
    schema: 'chickpea-runner-matrix-plan/v1',
    createdAt: now.toISOString(),
    tag: params.tag,
    lane: params.lane,
    workspaceId: params.workspaceId,
    worker: params.worker,
    botUserId: params.botUserId,
    channel: params.channel,
    dm: params.dm ?? null,
    agents: { ...params.agents },
    cases: [...params.cases],
    timeScale: scale,
    items,
    hooks,
    endMs,
    minLeadMs: at(spec.defaults.minLeadMs),
    continuationGapMs: at(spec.defaults.continuationGapMs),
    requireInterruption: c['long-turns'].requireInterruption,
    bounds: structuredClone(spec.bounds),
    failureSignatures: FAILURE_SIGNATURES.map((entry) => ({ ...entry })),
  };
}
