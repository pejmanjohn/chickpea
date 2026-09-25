import type { RuntimeExtract, SignalKind, TurnLatencyRow } from './tail.ts';
import type { BrowserExport, HookRecord, MatrixCaseId, MatrixPlan, MessageSummary, PlanItem, RunRecord, SentRecord } from './types.ts';

/** Nearest-rank percentile: the smallest value with at least p% of samples at or below it. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function summarize(values: number[]): { n: number; p50: number | null; p95: number | null; max: number | null; min: number | null } {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null, min: values.length ? Math.min(...values) : null };
}

const tsMs = (ts: string) => Math.round(Number(ts) * 1000);

export interface ThreadResult {
  label: string;
  caseId: MatrixCaseId;
  role: PlanItem['role'];
  round?: number;
  sent: boolean;
  sendError?: string;
  sendAckMs?: number;
  channel?: string;
  thread?: string;
  firstNativeMs: number | null;
  firstCustomMs: number | null;
  firstVisibleMs: number | null;
  handoverMs: number | null;
  nativeAfterCustom: boolean;
  finals: number;
  parts: number;
  totalChars: number;
  footer: boolean;
  complete: boolean;
  failureNotice: string | null;
  firstReplyMs: number | null;
  finalMs: number | null;
  finalAt: number | null;
  dropped: boolean;
  stage?: StageRow;
}

export interface StageRow {
  turnRef: string;
  attempts: number;
  outcomes: string[];
  executor?: string;
  firstWrite?: string;
  receiptToAdmissionMs?: number;
  admissionToStartMs?: number;
  startToWriteMs?: number;
  receiptToFirstWriteMs?: number;
  sendToReceiptMs?: number;
  gatewaySlackLagMs?: number;
  gatewayLagMs?: number;
  versions: string[];
}

export function analyzeThread(item: PlanItem, sent: SentRecord | undefined, data: BrowserExport, plan: MatrixPlan): ThreadResult {
  const base: ThreadResult = {
    label: item.label, caseId: item.caseId, role: item.role, sent: false,
    firstNativeMs: null, firstCustomMs: null, firstVisibleMs: null, handoverMs: null, nativeAfterCustom: false,
    finals: 0, parts: 0, totalChars: 0, footer: false, complete: false, failureNotice: null,
    firstReplyMs: null, finalMs: null, finalAt: null, dropped: true,
  };
  if (item.round !== undefined) base.round = item.round;
  if (!sent || !sent.ok || !sent.ts || !sent.thread) {
    base.sendError = sent?.error ?? 'not_sent';
    return base;
  }
  base.sent = true;
  base.sendAckMs = sent.tAck - sent.t0;
  base.channel = sent.channel;
  base.thread = sent.thread;
  const frames = data.frames.filter((f) => f.channel === sent.channel && f.thread === sent.thread && f.t >= sent.t0)
    .sort((a, b) => a.t - b.t);
  const first = (kind: string) => frames.find((f) => f.kind === kind)?.t ?? null;
  const native = first('native'), custom = first('custom');
  base.firstNativeMs = native === null ? null : native - sent.t0;
  base.firstCustomMs = custom === null ? null : custom - sent.t0;
  const visible = [native, custom].filter((v): v is number => v !== null);
  base.firstVisibleMs = visible.length ? Math.min(...visible) - sent.t0 : null;
  base.handoverMs = native !== null && custom !== null && custom >= native ? custom - native : null;
  base.nativeAfterCustom = custom !== null && frames.some((f) => f.kind === 'native' && f.t > custom);

  const messages = (data.threads[`${sent.channel}:${sent.thread}`] ?? []).slice().sort((a, b) => Number(a.ts) - Number(b.ts));
  const replies: MessageSummary[] = [];
  for (const message of messages) {
    if (Number(message.ts) <= Number(sent.ts)) continue;
    if (!message.bot) break; // the next human message starts another turn
    replies.push(message);
  }
  const groups: MessageSummary[][] = [];
  for (const reply of replies) {
    const last = groups.at(-1)?.at(-1);
    if (last && tsMs(reply.ts) - tsMs(last.ts) <= plan.continuationGapMs) groups.at(-1)!.push(reply);
    else groups.push([reply]);
  }
  base.finals = groups.length;
  base.failureNotice = replies.find((r) => r.failure)?.failure ?? null;
  const final = groups[0];
  if (final) {
    base.parts = final.length;
    base.totalChars = final.reduce((sum, m) => sum + Math.max(m.blockTextLen, m.textLen), 0);
    base.footer = final.at(-1)!.footer;
    base.complete = base.footer && (base.totalChars <= plan.bounds.longTurn.continuationThresholdChars || final.length >= 2);
    base.firstReplyMs = tsMs(final[0]!.ts) - sent.t0;
    base.finalAt = tsMs(final.at(-1)!.ts);
    base.finalMs = base.finalAt - sent.t0;
  }
  base.dropped = base.firstVisibleMs === null && replies.length === 0;
  return base;
}

interface TurnGroup { turnRef: string; rows: TurnLatencyRow[]; receiptAt: number; firstWriteAt: number | null }

function turnGroups(runtime: RuntimeExtract): TurnGroup[] {
  const byRef = new Map<string, TurnLatencyRow[]>();
  for (const row of runtime.turnLatency) {
    if (!row.turnRef) continue;
    const list = byRef.get(row.turnRef) ?? [];
    list.push(row);
    byRef.set(row.turnRef, list);
  }
  const groups: TurnGroup[] = [];
  for (const [turnRef, rows] of byRef) {
    rows.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0) || a.at - b.at);
    const head = rows[0]!;
    const admission = head.at - (head.attemptMs ?? 0) - (head.admissionToStartMs ?? 0);
    const receiptAt = admission - (head.receiptToAdmissionMs ?? 0);
    const best = rows.filter((r) => r.receiptToFirstWriteMs !== undefined || r.admissionToFirstWriteMs !== undefined)
      .sort((a, b) => (a.receiptToFirstWriteMs ?? a.admissionToFirstWriteMs ?? 0) - (b.receiptToFirstWriteMs ?? b.admissionToFirstWriteMs ?? 0))[0];
    const firstWriteAt = best ? (best.receiptToFirstWriteMs !== undefined ? receiptAt + best.receiptToFirstWriteMs : admission + (best.admissionToFirstWriteMs ?? 0)) : null;
    groups.push({ turnRef, rows, receiptAt, firstWriteAt });
  }
  return groups;
}

/**
 * Join Slack threads to `turn_latency` records. The record is content-free
 * (opaque turnRef only), so the join is by time: the tail-derived first write
 * against the websocket's first visible status, else receipt against send.
 */
export function correlateStages(results: ThreadResult[], sent: Map<string, SentRecord>, runtime: RuntimeExtract): void {
  const groups = turnGroups(runtime);
  const pairs: Array<{ cost: number; result: ThreadResult; group: TurnGroup }> = [];
  for (const result of results) {
    const s = sent.get(result.label);
    if (!s || !s.ok) continue;
    const visibleAt = result.firstVisibleMs === null ? null : s.t0 + result.firstVisibleMs;
    for (const group of groups) {
      const lag = group.receiptAt - s.t0;
      if (lag < -2000 || lag > 60_000) continue;
      let cost = Math.abs(lag - 1000) + 2000;
      if (visibleAt !== null && group.firstWriteAt !== null) {
        const delta = Math.abs(group.firstWriteAt - visibleAt);
        if (delta <= 4000) cost = delta;
      }
      pairs.push({ cost, result, group });
    }
  }
  pairs.sort((a, b) => a.cost - b.cost);
  const usedResults = new Set<ThreadResult>(), usedGroups = new Set<TurnGroup>();
  for (const { result, group } of pairs) {
    if (usedResults.has(result) || usedGroups.has(group)) continue;
    usedResults.add(result); usedGroups.add(group);
    const head = group.rows[0]!;
    const best = group.rows.slice().sort((a, b) => (a.receiptToFirstWriteMs ?? Infinity) - (b.receiptToFirstWriteMs ?? Infinity))[0]!;
    const stage: StageRow = {
      turnRef: group.turnRef,
      attempts: new Set(group.rows.map((r) => r.attempt ?? 1)).size,
      outcomes: group.rows.map((r) => `${r.attempt ?? '-'}:${r.outcome ?? '?'}/${r.final ?? '?'}`),
      versions: [...new Set(group.rows.map((r) => r.version))],
      sendToReceiptMs: group.receiptAt - sent.get(result.label)!.t0,
    };
    if (head.executor) stage.executor = head.executor;
    if (best.firstWrite) stage.firstWrite = best.firstWrite;
    if (head.receiptToAdmissionMs !== undefined) stage.receiptToAdmissionMs = head.receiptToAdmissionMs;
    if (best.admissionToStartMs !== undefined) stage.admissionToStartMs = best.admissionToStartMs;
    if (best.admissionToStartMs !== undefined && best.admissionToFirstWriteMs !== undefined) stage.startToWriteMs = best.admissionToFirstWriteMs - best.admissionToStartMs;
    if (best.receiptToFirstWriteMs !== undefined) stage.receiptToFirstWriteMs = best.receiptToFirstWriteMs;
    const delivery = runtime.gatewayDelivery
      .filter((row) => Math.abs(row.at - group.receiptAt) <= 1500)
      .sort((a, b) => Math.abs(a.at - group.receiptAt) - Math.abs(b.at - group.receiptAt))[0];
    if (delivery?.slackLagMs !== undefined) stage.gatewaySlackLagMs = delivery.slackLagMs;
    if (delivery?.lagMs !== undefined) stage.gatewayLagMs = delivery.lagMs;
    result.stage = stage;
  }
}

export type CaseResult = 'pass' | 'fail' | 'blocked';

export interface CaseOutcome {
  caseId: MatrixCaseId;
  result: CaseResult;
  category?: 'product' | 'tool' | 'infrastructure' | 'unknown';
  summary: string;
  failures: string[];
  notes: string[];
  metrics: Record<string, unknown>;
  threads: ThreadResult[];
  completedAt: number | null;
}

export interface MatrixResults {
  schema: 'chickpea-runner-matrix-results/v1';
  tag: string;
  lane: string;
  t0: number | null;
  generatedAt: string;
  tail: { objects: number; versions: string[]; segments: number; skipped: string | null; signals: Partial<Record<SignalKind, number>> };
  bounds: MatrixPlan['bounds'];
  hooks: HookRecord[];
  cases: CaseOutcome[];
}

const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(2)} s`);

function countSignals(runtime: RuntimeExtract, from: number, to: number): Partial<Record<SignalKind, number>> {
  const counts: Partial<Record<SignalKind, number>> = {};
  for (const s of runtime.signals) if (s.at >= from && s.at <= to) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return counts;
}

function threadFailures(t: ThreadResult, opts: { requireComplete: boolean }): string[] {
  const out: string[] = [];
  if (!t.sent) return [`${t.label}: message not sent (${t.sendError})`];
  if (t.dropped) out.push(`${t.label}: dropped (no status, no reply)`);
  else if (t.finals === 0) out.push(`${t.label}: no final`);
  else if (t.finals > 1) out.push(`${t.label}: ${t.finals} finals`);
  if (t.failureNotice) out.push(`${t.label}: failure notice (${t.failureNotice})`);
  if (opts.requireComplete && t.finals >= 1 && !t.complete) {
    out.push(`${t.label}: incomplete final (${t.parts} part(s), ${t.totalChars} chars, footer ${t.footer ? 'present' : 'missing'})`);
  }
  return out;
}

function interruptionObserved(runtime: RuntimeExtract, hook: HookRecord | undefined): { interruptedAt: number | null; codeUpdatedAt: number | null } {
  if (!hook?.startedAt) return { interruptedAt: null, codeUpdatedAt: null };
  const from = hook.startedAt, to = (hook.endedAt ?? hook.startedAt) + 120_000;
  const fiber = runtime.fibers.find((f) => f.type === 'fiber:run:interrupted' && f.at >= from && f.at <= to);
  const code = runtime.signals.find((s) => s.kind === 'codeUpdated' && s.at >= from && s.at <= to);
  return { interruptedAt: fiber?.at ?? null, codeUpdatedAt: code?.at ?? null };
}

const hookRan = (hook: HookRecord | undefined) => Boolean(hook && hook.startedAt && hook.exitCode === 0);

export function evaluateMatrix(input: { plan: MatrixPlan; data: BrowserExport | null; runtime: RuntimeExtract; run: RunRecord | null; now?: Date }): MatrixResults {
  const { plan, runtime, run } = input;
  const data: BrowserExport = input.data ?? { schema: 'chickpea-runner-matrix-export/v1', tag: plan.tag, armedT0: null, exportedAt: 0, sent: [], frames: [], threads: {}, resolved: { dm: null, agents: {} }, errors: ['browser export missing'] };
  const sent = new Map(data.sent.map((s) => [s.label, s]));
  const threads = plan.items.map((item) => analyzeThread(item, sent.get(item.label), data, plan));
  correlateStages(threads, sent, runtime);
  const hooks = run?.hooks ?? [];
  const cases: CaseOutcome[] = [];
  const of = (caseId: MatrixCaseId) => threads.filter((t) => t.caseId === caseId);
  const lastFinal = (list: ThreadResult[]) => {
    const values = list.map((t) => t.finalAt).filter((v): v is number => v !== null);
    return values.length ? Math.max(...values) : null;
  };
  const toolGap = input.data === null ? ['browser export missing: run collect in the lane tab and save every chunk'] : [];

  for (const caseId of plan.cases) {
    const list = of(caseId);
    const failures: string[] = [...toolGap];
    const notes: string[] = [];
    const metrics: Record<string, unknown> = {};
    let blocked: string | null = null;
    let category: CaseOutcome['category'] = 'product';
    if (list.some((t) => !t.sent)) category = 'tool';

    if (caseId === 'parity') {
      for (const t of list) failures.push(...threadFailures(t, { requireComplete: false }));
      metrics.finalMs = Object.fromEntries(list.map((t) => [t.label, t.finalMs]));
      metrics.firstVisibleMs = Object.fromEntries(list.map((t) => [t.label, t.firstVisibleMs]));
    } else if (caseId === 'first-status') {
      const sides = list.filter((t) => t.role === 'side');
      for (const t of list.filter((x) => x.role !== 'warmup')) failures.push(...threadFailures(t, { requireComplete: t.role === 'anchor' }));
      const latencies = sides.map((t) => t.firstVisibleMs).filter((v): v is number => v !== null);
      const stats = summarize(latencies);
      metrics.firstVisible = stats;
      metrics.handover = summarize(sides.map((t) => t.handoverMs).filter((v): v is number => v !== null));
      const stage = (key: keyof StageRow) => summarize(sides.map((t) => t.stage?.[key]).filter((v): v is number => typeof v === 'number'));
      metrics.stages = {
        sendToReceipt: stage('sendToReceiptMs'), receiptToAdmission: stage('receiptToAdmissionMs'),
        admissionToStart: stage('admissionToStartMs'), startToWrite: stage('startToWriteMs'), receiptToFirstWrite: stage('receiptToFirstWriteMs'),
      };
      const { p95Ms, maxMs } = plan.bounds.firstStatus;
      if (latencies.length < sides.length) failures.push(`${sides.length - latencies.length} side thread(s) without a visible status`);
      if (stats.max !== null && stats.max > maxMs) failures.push(`max first status ${seconds(stats.max)} > ${seconds(maxMs)}`);
      if (stats.p95 !== null && stats.p95 > p95Ms) failures.push(`p95 first status ${seconds(stats.p95)} > ${seconds(p95Ms)}`);
      const reshow = sides.filter((t) => t.nativeAfterCustom).map((t) => t.label);
      if (reshow.length) notes.push(`native status re-shown after custom: ${reshow.join(', ')}`);
      const unmatched = sides.filter((t) => t.sent && !t.stage).map((t) => t.label);
      if (unmatched.length) notes.push(`no turn_latency match (stage unknown): ${unmatched.join(', ')}`);
    } else if (caseId === 'long-turns') {
      for (const t of list) failures.push(...threadFailures(t, { requireComplete: true }));
      const { minDurationMs, minChars } = plan.bounds.longTurn;
      const short = list.filter((t) => t.finalMs !== null && t.finalMs < minDurationMs).map((t) => t.label);
      const small = list.filter((t) => t.finals > 0 && t.totalChars < minChars).map((t) => t.label);
      if (short.length) notes.push(`coverage: finished under ${seconds(minDurationMs)}: ${short.join(', ')}`);
      if (small.length) notes.push(`coverage: answer under ${minChars} chars: ${small.join(', ')}`);
      const hook = hooks.find((h) => h.id === 'interrupt-long-turns');
      const planned = plan.hooks.some((h) => h.id === 'interrupt-long-turns');
      const observed = interruptionObserved(runtime, hook);
      metrics.interruption = { planned, ran: hookRan(hook), skipped: hook?.skipped ?? null, ...observed };
      if (planned && !hookRan(hook) && plan.requireInterruption) blocked = `interruption hook did not run (${hook?.skipped ?? (hook ? `exit ${hook.exitCode}` : 'no run record')})`;
      else if (planned && hookRan(hook) && observed.interruptedAt === null) notes.push('deploy ran but no fiber:run:interrupted was captured in its window (turns may have been between fibers; see tail)');
      metrics.finalMs = Object.fromEntries(list.map((t) => [t.label, t.finalMs]));
      metrics.chars = Object.fromEntries(list.map((t) => [t.label, `${t.totalChars} (${t.parts} part(s))`]));
    } else if (caseId === 'redeploy-mid-turn') {
      const rounds = [...new Set(list.map((t) => t.round))].sort();
      const perRound: Record<string, unknown> = {};
      for (const round of rounds) {
        const a = list.find((t) => t.round === round && t.role === 'redeploy-a');
        const b = list.find((t) => t.round === round && t.role === 'redeploy-b');
        const hook = hooks.find((h) => h.id === `redeploy-${round}`);
        if (!hookRan(hook)) { blocked = `redeploy ${round} hook did not run (${hook?.skipped ?? (hook ? `exit ${hook.exitCode}` : 'no run record')})`; }
        if (a) failures.push(...threadFailures(a, { requireComplete: true }));
        if (b) {
          failures.push(...threadFailures(b, { requireComplete: false }));
          if (b.firstVisibleMs === null || b.firstVisibleMs > plan.bounds.redeployProbe.maxMs) failures.push(`${b.label}: probe first status ${seconds(b.firstVisibleMs)} > ${seconds(plan.bounds.redeployProbe.maxMs)}`);
        }
        const observed = interruptionObserved(runtime, hook);
        const next = list.find((t) => t.round === (round ?? 0) + 1 && t.role === 'redeploy-a');
        const nextSent = next ? sent.get(next.label) : undefined;
        if (hook?.endedAt && nextSent && nextSent.t0 < hook.endedAt) {
          failures.push(`round ${(round ?? 0) + 1} started before redeploy ${round} finished; rounds overlapped`);
          category = 'tool';
        }
        perRound[`round${round}`] = {
          deployMs: hook?.startedAt && hook.endedAt ? hook.endedAt - hook.startedAt : null,
          ...observed,
          resumeMs: a?.finalAt && hook?.endedAt ? a.finalAt - hook.endedAt : null,
          interruptToFinalMs: a?.finalAt && observed.interruptedAt ? a.finalAt - observed.interruptedAt : null,
          aFinalMs: a?.finalMs ?? null, aAttempts: a?.stage?.attempts ?? null, aVersions: a?.stage?.versions ?? [],
          probeFirstVisibleMs: b?.firstVisibleMs ?? null,
        };
      }
      metrics.rounds = perRound;
    } else if (caseId === 'rate-limit') {
      for (const t of list) failures.push(...threadFailures(t, { requireComplete: false }));
      const starts = list.map((t) => sent.get(t.label)?.t0).filter((v): v is number => v !== undefined);
      const from = starts.length ? Math.min(...starts) - 1000 : 0;
      const to = lastFinal(list) ?? (from + 120_000);
      const signals = countSignals(runtime, from, to + 5000);
      metrics.signals = signals;
      metrics.firstVisible = summarize(list.map((t) => t.firstVisibleMs).filter((v): v is number => v !== null));
      metrics.sendRetries = list.reduce((sum, t) => sum + (sent.get(t.label)?.retries ?? 0), 0);
      metrics.gatewayDeliveries = runtime.gatewayDelivery.filter((d) => d.at >= from && d.at <= to + 5000)
        .reduce<Record<string, number>>((acc, d) => { acc[d.outcome ?? '?'] = (acc[d.outcome ?? '?'] ?? 0) + 1; return acc; }, {});
      metrics.slackOps = 'not in the Worker tail (the shared gateway counts operations); rate-limit and rejection lines are counted instead';
      if ((signals.noAssignment ?? 0) > 0) failures.push(`${signals.noAssignment} mention(s) dropped at routing ("no assignment for turn")`);
      if ((signals.rateLimited ?? 0) + (signals.gatewayRejected ?? 0) > 0) notes.push(`gateway rate-limit/rejection lines: ${(signals.rateLimited ?? 0) + (signals.gatewayRejected ?? 0)} (retried is fine; a drop or failure final is not)`);
    }

    const completedAt = lastFinal(list);
    let result: CaseResult = failures.length ? 'fail' : 'pass';
    if (blocked && result === 'pass') { result = 'blocked'; category = 'infrastructure'; }
    else if (blocked) notes.push(`also blocked: ${blocked}`);
    if (toolGap.length) category = 'tool';
    const summary = [
      `${caseId}: ${result.toUpperCase()}`,
      blocked && result === 'blocked' ? `blocked: ${blocked}` : null,
      failures.length ? `failures: ${failures.join('; ')}` : null,
      notes.length ? `notes: ${notes.join('; ')}` : null,
    ].filter(Boolean).join('. ');
    const outcome: CaseOutcome = { caseId, result, summary, failures, notes, metrics, threads: list, completedAt };
    if (result !== 'pass') outcome.category = category;
    cases.push(outcome);
  }
  const t0 = run?.t0 ?? data.armedT0 ?? null;
  return {
    schema: 'chickpea-runner-matrix-results/v1',
    tag: plan.tag,
    lane: plan.lane,
    t0,
    generatedAt: (input.now ?? new Date()).toISOString(),
    tail: { objects: runtime.objects, versions: runtime.versions, segments: run?.tail.segments.length ?? 0, skipped: run?.tail.skipped ?? null, signals: countSignals(runtime, -Infinity, Infinity) },
    bounds: plan.bounds,
    hooks,
    cases,
  };
}

export function renderMarkdown(results: MatrixResults, evidence: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`# Runner matrix ${results.tag} (${results.lane})`, '');
  lines.push(`T0 ${results.t0 ? new Date(results.t0).toISOString() : 'unknown'}; generated ${results.generatedAt}. Tail: ${results.tail.objects} objects, ${results.tail.segments} segment(s), versions ${results.tail.versions.join(', ') || 'none'}${results.tail.skipped ? ` (skipped: ${results.tail.skipped})` : ''}.`, '');
  lines.push('| Case | Result | Key measurements | Failures / notes |', '| --- | --- | --- | --- |');
  for (const c of results.cases) {
    const key = c.caseId === 'first-status' ? (() => {
      const s = c.metrics.firstVisible as ReturnType<typeof summarize>;
      return `first status n=${s.n} p50 ${seconds(s.p50)} / p95 ${seconds(s.p95)} / max ${seconds(s.max)} (bounds p95 ≤ ${seconds(results.bounds.firstStatus.p95Ms)}, max ≤ ${seconds(results.bounds.firstStatus.maxMs)})`;
    })() : c.caseId === 'redeploy-mid-turn' ? Object.entries(c.metrics.rounds as Record<string, Record<string, unknown>>)
      .map(([round, m]) => `${round}: deploy ${seconds(m.deployMs as number | null)}, resume ${seconds(m.resumeMs as number | null)}, probe ${seconds(m.probeFirstVisibleMs as number | null)}`).join('; ')
      : c.caseId === 'rate-limit' ? `signals ${JSON.stringify(c.metrics.signals)}; gateway ${JSON.stringify(c.metrics.gatewayDeliveries)}`
        : `${c.threads.length} thread(s); finals ${c.threads.map((t) => `${t.label}=${t.finals}`).join(', ')}`;
    const detail = [...c.failures, ...c.notes].join('; ').replaceAll('|', '/') || '—';
    lines.push(`| ${c.caseId} | ${c.result.toUpperCase()}${c.category ? ` (${c.category})` : ''} | ${key} | ${detail} |`);
  }
  lines.push('', '## Threads', '', '| Thread | Case | Sent | Native | Custom | Hand-over | Finals | Parts | Chars | Final at | Failure | rcpt→adm | adm→start | start→write | rcpt→write | send→rcpt | Attempts |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of results.cases) {
    for (const t of c.threads) {
      const s = t.stage;
      lines.push(`| ${t.label} | ${t.caseId} | ${t.sent ? 'yes' : `no (${t.sendError})`} | ${seconds(t.firstNativeMs)} | ${seconds(t.firstCustomMs)} | ${seconds(t.handoverMs)} | ${t.finals} | ${t.parts} | ${t.totalChars} | ${seconds(t.finalMs)} | ${t.failureNotice ?? '—'} | ${seconds(s?.receiptToAdmissionMs)} | ${seconds(s?.admissionToStartMs)} | ${seconds(s?.startToWriteMs)} | ${seconds(s?.receiptToFirstWriteMs)} | ${seconds(s?.sendToReceiptMs)} | ${s ? s.attempts : '—'} |`);
    }
  }
  if (results.hooks.length) {
    lines.push('', '## Hooks', '', '| Hook | Planned | Started | Ended | Exit | Skipped |', '| --- | --- | --- | --- | --- | --- |');
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(11, 23) : '—');
    for (const h of results.hooks) lines.push(`| ${h.id} | ${iso(h.plannedAt)} | ${iso(h.startedAt)} | ${iso(h.endedAt)} | ${h.exitCode ?? '—'} | ${h.skipped ?? '—'} |`);
  }
  lines.push('', '## Evidence', '');
  for (const [name, path] of Object.entries(evidence)) lines.push(`- ${name}: ${path}`);
  lines.push('', 'Percentiles are nearest-rank (p95 of 8 samples is the maximum). Times are from the harness send start in the signed-in Slack client; stage times come from `turn_latency` joined by time, since the record carries only an opaque turn reference.', '');
  return lines.join('\n');
}
