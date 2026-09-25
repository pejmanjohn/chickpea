/**
 * Offline fakes for the dry-run mode and tests: a synthetic browser export,
 * wrangler tail capture and run record that a healthy runner stack would
 * produce for a plan. Mutate the returned objects to model failures.
 */
import type { BrowserExport, FrameEvent, HookRecord, MatrixPlan, MessageSummary, RunRecord, SentRecord } from './types.ts';

export interface FakeScenario { data: BrowserExport; tailText: string; run: RunRecord }

const tsOf = (ms: number) => (ms / 1000).toFixed(6);

export function fakeScenario(plan: MatrixPlan, options: { t0?: number; version?: string; newVersion?: string } = {}): FakeScenario {
  const t0 = options.t0 ?? 1_800_000_000_000;
  const version = options.version ?? '11111111-aaaa-4bbb-8ccc-000000000001';
  const newVersion = options.newVersion ?? '22222222-aaaa-4bbb-8ccc-000000000002';
  const sent: SentRecord[] = [];
  const frames: FrameEvent[] = [];
  const threads: Record<string, MessageSummary[]> = {};
  const tail: Array<Record<string, unknown>> = [];
  const finalAt = new Map<string, number>();
  const dm = plan.dm ?? 'DFAKEDM01';
  const log = (at: number, entrypoint: string, message: unknown, ver = version) => tail.push({
    outcome: 'ok', scriptVersion: { id: ver }, entrypoint, scriptName: plan.worker, diagnosticsChannelEvents: [], exceptions: [],
    logs: [{ message: [message], level: 'info', timestamp: at }], eventTimestamp: at, event: {},
  });
  const hooks: HookRecord[] = plan.hooks.map((hook) => {
    const startedAt = t0 + hook.atMs;
    const record: HookRecord = { id: hook.id, kind: hook.kind, caseId: hook.caseId, plannedAt: startedAt, startedAt, endedAt: startedAt + 95_000, exitCode: 0, skipped: null, log: null };
    if (hook.round !== undefined) record.round = hook.round;
    return record;
  });

  const ordered = [...plan.items].sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity));
  ordered.forEach((item, index) => {
    const parentFinal = item.after ? finalAt.get(item.after.label) : undefined;
    const sendAt = item.atMs !== undefined ? t0 + item.atMs : (parentFinal ?? t0) + (item.after?.delayMs ?? 0);
    const channel = item.where === 'dm' ? dm : plan.channel;
    const ts = tsOf(sendAt + 150);
    const parent = item.after ? sent.find((s) => s.label === item.after!.label) : undefined;
    const thread = parent?.thread ?? ts;
    sent.push({ label: item.label, caseId: item.caseId, channel, t0: sendAt, tAck: sendAt + 180, ok: true, ts, thread, retries: 0 });
    const key = `${channel}:${thread}`;
    threads[key] ??= [];
    threads[key].push({ ts, bot: false, who: 'user', textLen: item.text.length, blockTextLen: item.text.length, blockTypes: ['rich_text'], footer: false, failure: null, marker: true, tail: item.marker });
    const native = sendAt + 3500 + (index % 5) * 200; // after receipt (+0.9 s), admission (+0.75 s) and start (+1.5 s)
    const custom = native + 700;
    const duration = item.role === 'redeploy-a' ? 160_000 : item.long ? 110_000 : 12_000;
    const done = sendAt + duration;
    finalAt.set(item.label, done);
    const who = item.agent === 'b' ? 'Agent B' : 'Agent A';
    frames.push(
      { t: native, kind: 'native', channel, thread, status: 'is typing...', statusType: 'banner', who },
      { t: native + 450, kind: 'native-clear', channel, thread, status: '', statusType: 'banner' },
      { t: custom, kind: 'custom', channel, thread, status: 'Thinking…', statusType: 'banner', who },
      { t: done, kind: 'bot-post', channel, thread, ts: tsOf(done), len: 13 },
      { t: done + 1500, kind: 'custom-clear', channel, thread, status: '', statusType: 'typing' },
    );
    const parts = item.long ? [11_000, 9_000, 8_000] : [180];
    parts.forEach((chars, part) => {
      const last = part === parts.length - 1;
      threads[key]!.push({ ts: tsOf(done + part * 600), bot: true, who, textLen: Math.min(chars, 4000), blockTextLen: chars, blockTypes: last ? ['rich_text', 'context'] : ['rich_text'], footer: last, failure: null, marker: false, tail: last ? `${who} | model | Configure` : '…' });
    });
    const receivedAt = sendAt + 900;
    const admittedAt = receivedAt + 750;
    const startedAt = admittedAt + 1500;
    const turnRef = `turn_${(index + 1).toString(16).padStart(24, '0')}`;
    log(receivedAt, 'SlackGatewaySession', { component: 'runtime', event: 'gateway_delivery', transport: 'socket', deliveryKind: 'event', outcome: 'accepted', slackLagMs: 450 });
    log(done + 300, 'SlackThreadRunner', {
      component: 'runtime', event: 'turn_latency', turnRef, lane: 'cloudflare', executor: 'runner', attempt: 1, outcome: 'returned', firstWrite: 'agent_session', final: 'delivered',
      admissionToStartMs: startedAt - admittedAt, admissionToFirstWriteMs: native - admittedAt, admissionToFinalMs: done - admittedAt,
      receiptToAdmissionMs: admittedAt - receivedAt, receiptToFirstWriteMs: native - receivedAt, attemptMs: done + 300 - startedAt,
    }, item.role === 'redeploy-a' ? newVersion : version);
  });
  for (const hook of hooks) {
    const at = hook.startedAt! + 30_000;
    tail.push({
      outcome: 'ok', scriptVersion: { id: version }, entrypoint: 'FlueChickpeaSlackV2Agent', exceptions: [], logs: [], eventTimestamp: at, event: {},
      diagnosticsChannelEvents: [{ message: { type: 'fiber:run:interrupted', payload: { fiberName: 'flue:submission-attempt', fiberId: 'fake', recoveryReason: 'interrupted', elapsedMs: 30_000 }, timestamp: at }, timestamp: at }],
    });
    tail.push({ outcome: 'exception', scriptVersion: { id: version }, entrypoint: 'TagStateStore', diagnosticsChannelEvents: [], logs: [], exceptions: [{ name: 'Error', message: 'Durable Object reset because its code was updated.', timestamp: at + 4000 }], eventTimestamp: at + 4000, event: {} });
  }
  tail.sort((a, b) => Number(a.eventTimestamp) - Number(b.eventTimestamp));
  const data: BrowserExport = {
    schema: 'chickpea-runner-matrix-export/v1', tag: plan.tag, armedT0: t0, exportedAt: t0 + plan.endMs,
    sent, frames, threads, resolved: { dm, agents: { a: 'SFAKEGROUPA', b: 'SFAKEGROUPB' } }, errors: [],
  };
  const run: RunRecord = {
    schema: 'chickpea-runner-matrix-run/v1', t0, startedAt: t0 - 30_000, endedAt: t0 + plan.endMs, hooks,
    tail: { file: 'tail.json', segments: [{ start: t0 - 30_000, end: t0 + plan.endMs, ready: t0 - 27_000, exit: 0 }], skipped: null },
    attempts: {}, interrupted: false,
  };
  // Wrangler prints pretty JSON objects back to back, with connection chatter between segments.
  const tailText = `Connected to ${plan.worker}, waiting for logs...\n${tail.map((o) => JSON.stringify(o, null, 2)).join('\n')}\n`;
  return { data, tailText, run };
}
