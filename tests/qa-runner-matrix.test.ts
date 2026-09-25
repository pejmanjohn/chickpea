import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { evaluateMatrix, percentile, renderMarkdown, summarize } from '../qa/live/runner-matrix/analysis.ts';
import { fakeScenario } from '../qa/live/runner-matrix/fake.ts';
import { classifyFrame, renderHarness, summarizeMessage } from '../qa/live/runner-matrix/page.ts';
import { buildPlan, FAILURE_SIGNATURES, parseCaseList, readSpec } from '../qa/live/runner-matrix/plan.ts';
import { HookRunner } from '../qa/live/runner-matrix/hooks.ts';
import { extractRuntime, splitJsonObjects, TailCapture } from '../qa/live/runner-matrix/tail.ts';
import type { MatrixParams, MatrixPlan } from '../qa/live/runner-matrix/types.ts';

const params = (overrides: Partial<MatrixParams> = {}): MatrixParams => ({
  lane: 'amber', tag: 'RM-TEST', workspaceId: 'TFAKEWORKSPACE', worker: 'fake-worker', botUserId: 'UFAKEBOT01',
  channel: 'CFAKECHAN01', agents: { a: 'fake-agent-a', b: 'fake-agent-b' }, cases: parseCaseList('all'), ...overrides,
});

function evaluate(plan: MatrixPlan, mutate?: (fake: ReturnType<typeof fakeScenario>) => void) {
  const fake = fakeScenario(plan);
  mutate?.(fake);
  const runtime = extractRuntime(splitJsonObjects(fake.tailText));
  return evaluateMatrix({ plan, data: fake.data, runtime, run: fake.run });
}
const caseOf = (results: ReturnType<typeof evaluate>, id: string) => results.cases.find((c) => c.caseId === id)!;

test('splitJsonObjects reads pretty-printed wrangler objects and skips chatter and torn fragments', () => {
  const a = { outcome: 'ok', logs: [{ message: ['brace { in "string" }', { event: 'x' }], timestamp: 1 }] };
  const b = { outcome: 'ok', note: 'escaped \\" quote }' };
  const text = `Connected to worker, waiting for logs...\n${JSON.stringify(a, null, 2)}\n{ "torn": \nsegment 2 "quote\n${JSON.stringify(b, null, 2)}\n`;
  const objects = splitJsonObjects(text);
  assert.equal(objects.length, 2);
  assert.deepEqual(objects[1], b);
});

test('extractRuntime keeps latency events, fiber diagnostics and failure signals', () => {
  const objects = [
    { scriptVersion: { id: 'abcdef12-0000' }, entrypoint: 'SlackThreadRunner', outcome: 'ok', eventTimestamp: 10,
      logs: [{ timestamp: 20, message: [{ component: 'runtime', event: 'turn_latency', turnRef: 'turn_1', attempt: 1, receiptToFirstWriteMs: 3000, outcome: 'returned' }] },
        { timestamp: 30, message: ['[chickpea] no assignment for turn:', 'Slack users.info failed (gateway_rejected)'] }] },
    { scriptVersion: { id: 'abcdef12-0000' }, entrypoint: 'TagStateStore', outcome: 'exception', eventTimestamp: 40, logs: [],
      exceptions: [{ name: 'Error', message: 'Durable Object reset because its code was updated.', timestamp: 41 }] },
    { entrypoint: 'FlueChickpeaSlackV2Agent', eventTimestamp: 50, logs: [],
      diagnosticsChannelEvents: [{ message: { type: 'fiber:run:interrupted', payload: { recoveryReason: 'interrupted', elapsedMs: 5 }, timestamp: 51 } }, { message: { type: 'schedule:create' } }] },
  ];
  const runtime = extractRuntime(objects);
  assert.equal(runtime.turnLatency.length, 1);
  assert.equal(runtime.turnLatency[0]!.receiptToFirstWriteMs, 3000);
  assert.deepEqual(runtime.signals.map((s) => s.kind).sort(), ['codeUpdated', 'gatewayRejected', 'noAssignment']);
  assert.deepEqual(runtime.fibers.map((f) => [f.type, f.reason]), [['fiber:run:interrupted', 'interrupted']]);
  assert.deepEqual(runtime.outcomes, { ok: 1, exception: 1 });
});

test('percentiles are nearest-rank', () => {
  const eight = [5800, 7700, 7600, 14000, 8200, 9400, 9100, 6400];
  assert.equal(percentile(eight, 95), 14000);
  assert.equal(percentile(eight, 50), 7700);
  assert.equal(percentile([], 95), null);
  assert.deepEqual(summarize([4000]), { n: 1, p50: 4000, p95: 4000, max: 4000, min: 4000 });
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19);
});

test('default plan: case list, markers, serial redeploys and a ~15 minute window', () => {
  const plan = buildPlan(readSpec(), params());
  const count = (caseId: string) => plan.items.filter((i) => i.caseId === caseId).length;
  assert.equal(count('parity'), 3);
  assert.equal(plan.items.filter((i) => i.role === 'side').length, 8);
  assert.equal(count('long-turns'), 4);
  assert.equal(count('rate-limit'), 12);
  assert.equal(count('redeploy-mid-turn'), 4);
  assert.deepEqual(plan.hooks.map((h) => h.id), ['interrupt-long-turns', 'redeploy-1', 'redeploy-2']);
  const markers = plan.items.map((i) => i.marker);
  assert.equal(new Set(markers).size, markers.length);
  for (const item of plan.items) assert.ok(item.text.endsWith(item.marker));
  const followup = plan.items.find((i) => i.role === 'followup')!;
  assert.ok(!followup.text.includes('{mention}'));
  assert.equal(followup.after?.label, 'P-CH');
  assert.ok(plan.items.some((i) => i.role === 'side' && i.where === 'dm'));
  assert.ok(new Set(plan.items.filter((i) => i.role === 'side').map((i) => i.agent)).size === 2);
  assert.ok(plan.endMs >= 13 * 60_000 && plan.endMs <= 17 * 60_000, `window ${plan.endMs}`);
  // The long-turn interruption deploy finishes before the first redeploy round starts (~2 min deploys).
  const deploys = plan.hooks.map((h) => h.atMs).sort((a, b) => a - b);
  for (let i = 1; i < deploys.length; i += 1) assert.ok(deploys[i]! - deploys[i - 1]! >= 180_000);
  assert.deepEqual(plan.failureSignatures, FAILURE_SIGNATURES.map((s) => ({ ...s })));
});

test('plan overrides and refusals', () => {
  const plan = buildPlan(readSpec(), params({ cases: parseCaseList('first-status,rate-limit'), counts: { 'first-status': 10, 'rate-limit': 3 } }));
  assert.equal(plan.items.filter((i) => i.role === 'side').length, 10);
  assert.equal(plan.items.filter((i) => i.caseId === 'rate-limit').length, 3);
  assert.equal(plan.hooks.length, 0);
  assert.throws(() => buildPlan(readSpec(), params({ tag: 'bad tag!' })), /Tag/);
  assert.throws(() => buildPlan(readSpec(), params({ channel: '' })), /channel/);
  assert.throws(() => parseCaseList('parity,nope'), /Unknown case/);
});

test('healthy fake run passes every case with stage breakdowns', () => {
  const plan = buildPlan(readSpec(), params());
  const results = evaluate(plan);
  assert.deepEqual(results.cases.map((c) => [c.caseId, c.result]), plan.cases.map((c) => [c, 'pass']));
  const fs = caseOf(results, 'first-status');
  const stats = fs.metrics.firstVisible as ReturnType<typeof summarize>;
  assert.equal(stats.n, 8);
  assert.ok(fs.threads.filter((t) => t.role === 'side').every((t) => t.stage?.receiptToFirstWriteMs !== undefined));
  const rounds = caseOf(results, 'redeploy-mid-turn').metrics.rounds as Record<string, { resumeMs: number; interruptedAt: number }>;
  assert.ok(rounds.round1!.resumeMs > 0 && rounds.round1!.interruptedAt > 0);
  const markdown = renderMarkdown(results, { results: '/private/results.json' });
  assert.match(markdown, /\| first-status \| PASS \|/);
  assert.match(markdown, /p95 3\.\d\d s|p95 4\.\d\d s/);
});

test('first status over the bounds fails with the percentile in the summary', () => {
  const plan = buildPlan(readSpec(), params({ cases: ['first-status'] }));
  const results = evaluate(plan, (fake) => {
    const fs3 = fake.data.sent.find((s) => s.label === 'FS-3')!;
    for (const frame of fake.data.frames) if (frame.thread === fs3.thread && (frame.kind === 'native' || frame.kind === 'custom')) frame.t += 9000;
  });
  const fs = caseOf(results, 'first-status');
  assert.equal(fs.result, 'fail');
  assert.equal(fs.category, 'product');
  assert.ok(fs.failures.some((f) => /max first status 1\d\.\d\d s > 10\.00 s/.test(f)), fs.failures.join('; '));
  assert.ok(fs.failures.some((f) => /p95 first status/.test(f)));
});

test('failure notices, duplicate finals, truncated long answers and drops fail', () => {
  const plan = buildPlan(readSpec(), params());
  const results = evaluate(plan, (fake) => {
    const key = (label: string) => { const s = fake.data.sent.find((x) => x.label === label)!; return `${s.channel}:${s.thread}`; };
    fake.data.threads[key('P-DM')]!.at(-1)!.failure = 'agent_failure';
    const lt2 = fake.data.threads[key('LT-2')]!;
    lt2.splice(lt2.length - 2, 2); // prefix only: the 11k first message, no continuation, no footer
    const lt3 = fake.data.threads[key('LT-3')]!;
    lt3.push({ ...lt3.at(-1)!, ts: (Number(lt3.at(-1)!.ts) + 60).toFixed(6) });
    const rl = fake.data.sent.find((s) => s.label === 'RL-4')!;
    fake.data.frames = fake.data.frames.filter((f) => f.thread !== rl.thread);
    fake.data.threads[key('RL-4')] = fake.data.threads[key('RL-4')]!.slice(0, 1);
  });
  assert.equal(caseOf(results, 'parity').result, 'fail');
  assert.ok(caseOf(results, 'parity').failures.some((f) => f.includes('P-DM: failure notice (agent_failure)')));
  const lt = caseOf(results, 'long-turns');
  assert.ok(lt.failures.some((f) => f.startsWith('LT-2: incomplete final')), lt.failures.join('; '));
  assert.ok(lt.failures.some((f) => f === 'LT-3: 2 finals'));
  assert.ok(caseOf(results, 'rate-limit').failures.some((f) => f === 'RL-4: dropped (no status, no reply)'));
});

test('routing drops in the burst window fail rate-limit; skipped deploy hooks block their cases', () => {
  const plan = buildPlan(readSpec(), params());
  const results = evaluate(plan, (fake) => {
    const at = fake.data.sent.find((s) => s.label === 'RL-1')!.t0 + 2000;
    fake.tailText += JSON.stringify({ entrypoint: 'TagStateStore', eventTimestamp: at, logs: [{ timestamp: at, message: ['[chickpea] no assignment for turn:', 'gateway_rate_limited'] }] });
    for (const hook of fake.run.hooks) Object.assign(hook, { startedAt: null, endedAt: null, exitCode: null, skipped: 'deploy hooks not allowed (pass --allow-deploy)' });
  });
  const rl = caseOf(results, 'rate-limit');
  assert.equal(rl.result, 'fail');
  assert.deepEqual(rl.metrics.signals, { noAssignment: 1, rateLimited: 1 });
  assert.equal(caseOf(results, 'long-turns').result, 'blocked');
  assert.equal(caseOf(results, 'redeploy-mid-turn').result, 'blocked');
  assert.equal(caseOf(results, 'redeploy-mid-turn').category, 'infrastructure');
});

test('a missing browser export is a tool failure, not a product verdict', () => {
  const plan = buildPlan(readSpec(), params({ cases: ['parity'] }));
  const results = evaluateMatrix({ plan, data: null, runtime: extractRuntime([]), run: null });
  assert.equal(results.cases[0]!.result, 'fail');
  assert.equal(results.cases[0]!.category, 'tool');
});

test('classifyFrame distinguishes native and custom status, bot posts and stream edits', () => {
  const base = { type: 'ai_assistant_status', channel_id: 'C1', thread_ts: '1.0' };
  assert.equal(classifyFrame({ ...base, status: 'is typing...', is_using_sessions: true }, 5)!.kind, 'native');
  assert.equal(classifyFrame({ ...base, status: 'Thinking…', loading_messages: ['Thinking…'] }, 5)!.kind, 'custom');
  assert.equal(classifyFrame({ ...base, status: '', is_using_sessions: true }, 5)!.kind, 'native-clear');
  assert.equal(classifyFrame({ ...base, status: '' }, 5)!.kind, 'custom-clear');
  assert.deepEqual(classifyFrame({ type: 'message', channel: 'C1', ts: '2.0', thread_ts: '1.0', bot_id: 'B1', text: 'hi' }, 7),
    { t: 7, kind: 'bot-post', channel: 'C1', thread: '1.0', ts: '2.0', len: 2 });
  assert.equal(classifyFrame({ type: 'message', subtype: 'message_changed', channel: 'C1', message: { ts: '2.0', thread_ts: '1.0', bot_id: 'B1', text: 'x', stream_state: 'in_progress' } }, 7)!.kind, 'stream-in_progress');
  assert.equal(classifyFrame({ type: 'message', subtype: 'channel_join', channel: 'C1', ts: '3.0' }, 7), null);
  assert.equal(classifyFrame({ type: 'presence_change' }, 7), null);
});

test('summarizeMessage measures block text, footer and failure notices without keeping content', () => {
  const summary = summarizeMessage({
    ts: '2.0', bot_id: 'B1', username: 'Agent A', text: `${FAILURE_SIGNATURES[0]!.prefix} rest`,
    blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Title' } },
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Body' }, { type: 'link', url: 'https://x', text: 'L' }] }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Agent A | model' }] }],
  }, FAILURE_SIGNATURES, '[RM:X]');
  assert.equal(summary.blockTextLen, 'TitleBodyLAgent A | model'.length);
  assert.deepEqual(summary.blockTypes, ['header', 'rich_text', 'context']);
  assert.equal(summary.footer, true);
  assert.equal(summary.failure, FAILURE_SIGNATURES[0]!.key);
  assert.equal(summary.marker, false);
  assert.equal(summary.who, 'Agent A');
});

test('the generated harness sends the plan, taps the socket and exports readback without the session credential', async () => {
  const plan = buildPlan(readSpec(), params({ cases: ['parity'], timeScale: 0.01 }));
  const credential = 'fake-session-credential-value';
  const posted: Array<Record<string, string>> = [];
  const replies = new Map<string, Array<Record<string, unknown>>>();
  let seq = 100;
  class FakeFormData { entries: Record<string, string> = {}; append(k: string, v: string) { this.entries[k] = v; } }
  class FakeWebSocket {}
  class FakeMessageEvent { constructor(readonly raw: string, readonly target: unknown) {} }
  Object.defineProperty(FakeMessageEvent.prototype, 'data', { configurable: true, enumerable: true, get(this: { raw: string }) { return this.raw; } });
  const store = new Map<string, string>([['localConfig_v2', JSON.stringify({ teams: { TFAKEWORKSPACE: { token: credential, url: 'https://fake.example/' } } })]]);
  const fetch = async (url: string, init: { body: FakeFormData }) => {
    const body = init.body.entries;
    assert.equal(body.token, credential);
    const method = url.replace('https://fake.example/api/', '');
    const ok = (value: Record<string, unknown>) => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ...value }) });
    if (method === 'usergroups.list') return ok({ usergroups: [{ id: 'SGA', handle: 'fake-agent-a' }, { id: 'SGB', handle: 'fake-agent-b' }] });
    if (method === 'conversations.open') return ok({ channel: { id: 'DFAKEDM01' } });
    if (method === 'chat.postMessage') {
      posted.push(body);
      const ts = `1800000000.${String(seq += 1).padStart(6, '0')}`;
      const thread = body.thread_ts ?? ts;
      const list = replies.get(`${body.channel}:${thread}`) ?? [];
      list.push({ ts, user: 'UHUMAN', text: body.text });
      replies.set(`${body.channel}:${thread}`, list);
      return ok({ ts });
    }
    if (method === 'conversations.replies') return ok({ messages: replies.get(`${body.channel}:${body.ts}`) ?? [] });
    throw new Error(`unexpected ${method}`);
  };
  const context = vm.createContext({
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    fetch, FormData: FakeFormData, WebSocket: FakeWebSocket, MessageEvent: FakeMessageEvent, URL, setTimeout, clearTimeout,
  });
  const describe = vm.runInContext(`(${renderHarness(plan)})()`, context);
  assert.equal(describe.planned, 3);
  const harness = vm.runInContext('globalThis.__chickpeaRunnerMatrix', context);
  const armed = await harness.arm({ leadMs: 1 });
  assert.ok(armed.t0 > Date.now() - 1000);
  const socket = new FakeWebSocket();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(350);
  const root = posted.find((p) => p.channel === 'CFAKECHAN01' && !p.thread_ts)!;
  assert.match(root.text!, /^<!subteam\^SGA> Reply with exactly the words PARITY-CHANNEL OK .* \[RM-TEST:P-CH\]$/);
  const rootTs = [...replies.keys()].find((k) => k.startsWith('CFAKECHAN01:'))!.split(':')[1]!;
  // Slack reads frames off its socket; the tap sees each frame once.
  const frame = (payload: unknown) => { const event = new FakeMessageEvent(JSON.stringify(payload), socket) as unknown as { data: string }; void event.data; void event.data; };
  frame({ type: 'ai_assistant_status', channel_id: 'CFAKECHAN01', thread_ts: rootTs, status: 'is typing...', is_using_sessions: true });
  frame({ type: 'message', channel: 'CFAKECHAN01', ts: '1800000000.900000', thread_ts: rootTs, bot_id: 'B1', text: 'PARITY-CHANNEL OK' });
  frame({ type: 'message', channel: 'COTHER', ts: '1.0', text: 'ignored' });
  replies.get(`CFAKECHAN01:${rootTs}`)!.push({ ts: '1800000000.900000', bot_id: 'B1', username: 'Agent A', text: 'PARITY-CHANNEL OK', blocks: [{ type: 'context', elements: [] }] });
  await wait(700);
  const followup = posted.find((p) => p.thread_ts === rootTs);
  assert.ok(followup, 'follow-up waits for the root final, then posts in its thread');
  assert.ok(!followup!.text!.includes('subteam'));
  assert.ok(posted.some((p) => p.channel === 'DFAKEDM01' && p.text!.startsWith('<!subteam^SGB>')));
  const again = await harness.arm({ leadMs: 1 });
  assert.match(again.note, /already armed/);
  const collected = await harness.collect({ chunkChars: 4000 });
  let text = '';
  for (let i = 0; i < collected.chunks; i += 1) text += harness.chunk(i);
  assert.ok(!text.includes(credential));
  assert.ok(![...store.entries()].some(([key, value]) => key.startsWith('chickpea-runner-matrix') && value.includes(credential)));
  const data = JSON.parse(text);
  assert.equal(data.sent.filter((s: { ok: boolean }) => s.ok).length, 3);
  assert.deepEqual(data.frames.map((f: { kind: string }) => f.kind), ['native', 'bot-post']);
  const thread = data.threads[`CFAKECHAN01:${rootTs}`];
  assert.equal(thread[0].marker, true);
  assert.equal(thread[1].footer, true);
  harness.dispose();
});

test('deploy hooks run serially at their offsets and are skipped without --allow-deploy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-matrix-hooks-'));
  const plan = { ...buildPlan(readSpec(), params({ cases: ['redeploy-mid-turn'] })), hooks: [
    { id: 'redeploy-1', kind: 'redeploy' as const, caseId: 'redeploy-mid-turn' as const, round: 1, atMs: 0 },
    { id: 'redeploy-2', kind: 'redeploy' as const, caseId: 'redeploy-mid-turn' as const, round: 2, atMs: 10 },
  ] };
  const command = [process.execPath, '-e', 'setTimeout(() => console.log(process.env.CHICKPEA_DEPLOY_TARGET), 150)'];
  const runner = new HookRunner({ plan, t0: Date.now(), recordDir: dir, cwd: dir, allowDeploy: true, command });
  runner.start();
  await new Promise((r) => setTimeout(r, 50)); // both are due; the second waits behind the first
  await runner.settled();
  await runner.stop();
  const [first, second] = runner.records;
  assert.equal(first!.exitCode, 0);
  assert.ok(second!.startedAt! >= first!.endedAt!, 'deploys never overlap');
  assert.equal(readFileSync(first!.log!, 'utf8').trim(), 'amber');
  const skipped = new HookRunner({ plan, t0: Date.now(), recordDir: dir, cwd: dir, allowDeploy: false, command });
  skipped.start();
  await skipped.stop();
  const interrupted = new HookRunner({ plan: { ...plan, hooks: [{ ...plan.hooks[0]!, atMs: 60_000 }] }, t0: Date.now(), recordDir: dir, cwd: dir, allowDeploy: true, command });
  interrupted.start();
  await interrupted.stop();
  assert.match(interrupted.records[0]!.skipped ?? '', /stopped before/);
  assert.ok(skipped.records.every((r) => r.startedAt === null && /--allow-deploy/.test(r.skipped ?? '')));
});

test('tail capture waits for readiness and keeps the JSON stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-matrix-tail-'));
  const script = "console.error('Connected to fake-worker, waiting for logs...'); console.log(JSON.stringify({ outcome: 'ok', logs: [] }, null, 2)); setInterval(() => {}, 1000);";
  const tail = new TailCapture({ worker: 'fake-worker', file: join(dir, 'tail.json'), errFile: join(dir, 'tail.err'), cwd: dir, command: [process.execPath, '-e', script] });
  tail.start();
  assert.equal(await tail.waitReady(5000), true);
  await new Promise((r) => setTimeout(r, 200));
  await tail.stop();
  assert.equal(splitJsonObjects(readFileSync(join(dir, 'tail.json'), 'utf8')).length, 1);
  assert.equal(tail.segments.length, 1);
  assert.ok(tail.segments[0]!.ready && tail.segments[0]!.end);
});
