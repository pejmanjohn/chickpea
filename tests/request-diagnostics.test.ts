import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { FlueObservation } from '@flue/runtime';
import { opaqueId } from '../src/work/admission.ts';
import { emitRuntimeCorrelation } from '../src/work/trace-correlation.ts';
// @ts-expect-error Operational helpers are native ESM, exercised directly below.
import { cloudflareDiagnosticScript, collectCloudflareDiagnostics, localDiagnosticQuery, projectDiagnosticSession, resolveDiagnosticRequest } from '../scripts/lib/request-diagnostics.mjs';
// @ts-expect-error Operational CLI is native ESM.
import { runDiagnosticCli } from '../scripts/diagnose-request.mjs';

const coordinates = { workspaceId: 'T_TEST', workerName: 'chickpea-test', accountId: 'a'.repeat(32),
  adminOrigin: 'https://chickpea.example', slackUrl: 'https://test.slack.com/archives/C123/p1788554224622389' };
const request = resolveDiagnosticRequest(coordinates);
const ref = opaqueId('fluesubmission', 'submission-123');
const traceId = '1'.repeat(32);
const secret = 'PRIVATE_PROMPT_AND_TOOL_RESULT';
const sessionBody = () => ({
  session: { runId: request.runId, status: 'settled', settledAt: request.timeframe.from + 500, content: secret },
  accountRef: request.accountRef, executions: [{ id: 'exec_test', flueSubmissionRef: ref, credential: secret }],
  timeline: [{ eventType: 'work.run_settled', createdAt: request.timeframe.from + 500, metadata: { body: secret } }],
  content: { body: secret },
});
const session = projectDiagnosticSession(sessionBody(), request);

test('runtime bridge emits only ledger-compatible opaque references and never changes execution', () => {
  const observation: Extract<FlueObservation, { type: 'operation_start' }> = {
    v: 3, type: 'operation_start', timestamp: '2026-09-04T00:00:00Z', eventIndex: 1,
    operationId: 'operation_test', operationKind: 'prompt', instanceId: secret, submissionId: 'submission-123',
  };
  const records: unknown[] = [];
  const sink = { info: (record: unknown) => records.push(record) };
  emitRuntimeCorrelation(observation, sink);
  assert.deepEqual(records, [{ component: 'runtime', event: 'run.correlation',
    flueInstanceRef: opaqueId('flueinstance', secret), flueSubmissionRef: ref }]);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|submission-123|operation_test/);
  emitRuntimeCorrelation({ ...observation, operationKind: 'shell' }, sink);
  const { submissionId: _omitted, ...missingSubmission } = observation;
  emitRuntimeCorrelation(missingSubmission, sink);
  assert.equal(records.length, 1);
  assert.doesNotThrow(() => emitRuntimeCorrelation(observation, { info() { throw new Error('sink'); } }));
});

test('permalinks use exact message microseconds and refuse conflicting or unbounded coordinates', () => {
  assert.equal(request.runId, opaqueId('run', 'slack:T_TEST:C123:1788554224.622389'));
  assert.throws(() => resolveDiagnosticRequest({ ...coordinates, runId: 'run_other' }), /disagree/);
  assert.throws(() => resolveDiagnosticRequest({ ...coordinates, adminOrigin: 'https://secret@host.test' }), /credential-free/);
  assert.throws(() => resolveDiagnosticRequest({ ...coordinates, to: '2026-09-05T00:00:00Z' }), /30 minutes/);
  assert.throws(() => resolveDiagnosticRequest({ ...coordinates, slackUrl: undefined, runId: request.runId }), /Run-ID-only/);
  assert.throws(() => resolveDiagnosticRequest({ ...coordinates, local: true }), /loopback/);
});

test('Sessions projection excludes content and refuses another run or workspace', () => {
  assert.doesNotMatch(JSON.stringify(session), new RegExp(secret));
  assert.equal(session.executions[0].flueSubmissionRef, ref);
  assert.throws(() => projectDiagnosticSession({ ...sessionBody(), accountRef: 'account_other' }, request), /another Slack/);
  assert.throws(() => projectDiagnosticSession({ ...sessionBody(), session: { runId: 'run_other' } }, request), /requested Run/);
  assert.throws(() => projectDiagnosticSession({ ...sessionBody(), executions: {} }, request), /malformed/);
  assert.equal(projectDiagnosticSession({ error: 'session_not_found' }, request), null);
});

function event(id: string, source: Record<string, unknown>, type = 'log') {
  return { timestamp: request.timeframe.from + 100, source,
    $metadata: { id, traceId, type, service: coordinates.workerName, requestId: 'req123' },
    $workers: { scriptVersion: { id: 'incident-version' }, outcome: 'ok' } };
}
function cloudflareFixture(calls: any[], override?: (options: any) => any) {
  return async (options: any) => {
    calls.push(options);
    const overridden = override?.(options);
    if (overridden) return overridden;
    if (options.path.endsWith('/settings')) return { success: true, result: { observability: {
      enabled: true, logs: { enabled: true, persist: true, head_sampling_rate: 1 },
      traces: { enabled: true, persist: true, head_sampling_rate: 1 } } } };
    if (options.path.endsWith('/deployments')) return { success: true, result: { deployments: [
      { created_on: '2026-09-04T22:00:00Z', versions: [{ version_id: 'current-version', percentage: 100 }] } ] } };
    if (options.path.endsWith('/keys')) return { success: true, result: [{ key: 'flueSubmissionRef', type: 'string' }] };
    const correlation = options.body.parameters.filters.some((f: any) => f.key === 'flueSubmissionRef');
    const events = correlation ? [event('bridge', { event: 'run.correlation', flueSubmissionRef: ref })] : [
      event('tool', { gen_ai: { operation: { name: 'execute_tool' }, tool: { name: 'read_fixture' } }, durationMs: 17,
        'error.type': 'ToolError', args: secret, result: secret }),
      event('legacy', { message: `[chickpea:management] ${JSON.stringify({ event: 'tool.failure', tool: 'read_fixture', code: 'validation_failed', result: secret })}` }),
      event('model', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'test/model', 'gen_ai.usage.output_tokens': 34,
        durationMS: 120, 'gen_ai.prompt': secret }),
      { ...event('unrelated', { event: 'unrelated' }), $metadata: { id: 'unrelated', traceId: '2'.repeat(32) } },
    ];
    return { success: true, status: 200, result: { run: { status: 'COMPLETED' }, events: { events } } };
  };
}

test('hosted collector joins by submission hash, projects legacy/new spans and preserves diagnostic limits', async () => {
  const calls: any[] = [];
  const result = await collectCloudflareDiagnostics({ request, session }, cloudflareFixture(calls));
  assert.equal(result.correlation, 'ledger_submission');
  assert.equal(result.timeline.length, 4);
  assert.equal(result.timeline.find((e: any) => e.event === 'execute_tool').errorReported, true);
  assert.equal(result.timeline.find((e: any) => e.event === 'execute_tool').outcome, 'ok');
  assert.equal(result.timeline.find((e: any) => e.event === 'chat').outputTokens, 34);
  assert.equal(result.timeline[0].version, 'incident-version');
  assert.equal(result.currentDeployment.versions[0].versionId, 'current-version');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${secret}|unrelated`));
  for (const call of calls.filter((c) => c.path.endsWith('/query'))) {
    assert.equal(call.body.dry, true);
    assert.deepEqual(call.body.timeframe, request.timeframe);
    assert.ok(call.body.parameters.filters.some((f: any) => ['flueSubmissionRef', '$metadata.traceId'].includes(f.key)));
  }
  assert.deepEqual(result.gaps, []);
});

test('MCP script runs standalone with no module globals or credentials', async () => {
  const script = cloudflareDiagnosticScript(request, session);
  const execute = new Function('cloudflare', `return (${script})();`);
  const result = await execute({ request: cloudflareFixture([]) });
  assert.equal(result.correlation, 'ledger_submission');
  assert.doesNotMatch(script, new RegExp(secret));
});

test('unavailable historical access and absent bridge never become proof of a failed product action', async () => {
  const calls: any[] = [];
  const unavailable = await collectCloudflareDiagnostics({ request, session }, cloudflareFixture(calls,
    (o) => o.path.endsWith('/keys') ? { success: false, status: 403 } : null));
  assert.equal(unavailable.correlation, 'unavailable');
  assert.ok(unavailable.gaps.includes('correlation_field_unavailable'));
  assert.ok(unavailable.gaps.includes('no_correlated_trace'));
  assert.equal(calls.some((c) => c.path.endsWith('/query')), false);
  const explicit = await collectCloudflareDiagnostics({ request: { ...request, suppliedTraceId: traceId }, session: null },
    cloudflareFixture([], (o) => o.path.endsWith('/query') ? { success: false, status: 403 } : null));
  assert.equal(explicit.correlation, 'operator_supplied_trace');
  assert.ok(explicit.gaps.includes('trace_query_unavailable'));
  assert.ok(explicit.gaps.includes('ledger_unavailable'));
});

test('full telemetry pages stop at a bounded limit and record incomplete coverage', async () => {
  const calls: any[] = [];
  const result = await collectCloudflareDiagnostics({ request: { ...request, suppliedTraceId: traceId }, session },
    cloudflareFixture(calls, (o) => o.path.endsWith('/query') ? { success: true, result: {
      run: { status: 'COMPLETED' }, events: { events: Array.from({ length: 100 }, (_, i) =>
        event(`${calls.length}_${i}`, { event: 'tool.failure' })) },
    } } : null));
  assert.equal(calls.filter((c) => c.path.endsWith('/query')).length, 3);
  assert.ok(result.gaps.includes('trace_page_limit'));
});

test('adaptive sampling and string-form legacy logs remain explicit', async () => {
  const result = await collectCloudflareDiagnostics({ request: { ...request, suppliedTraceId: traceId }, session },
    cloudflareFixture([], (o) => o.path.endsWith('/query') ? { success: true, result: {
      run: { status: 'COMPLETED' }, statistics: { abr_level: 2 }, events: { events: [{
        ...event('legacy-string', {}), source: '[chickpea:management] {"event":"tool.validation_failure","code":"validation_failed"}',
      }] },
    } } : null));
  assert.ok(result.gaps.includes('trace_adaptive_sampling'));
  assert.equal(result.timeline.find((e: any) => e.source === 'cloudflare').event, 'tool.validation_failure');
});

test('Local Explorer query joins only exact bridge hashes and never selects raw messages or attributes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE logs (trace_id TEXT, span_id TEXT, ts_ms INTEGER, message TEXT);
      CREATE TABLE spans (trace_id TEXT, span_id TEXT, parent_id TEXT, service TEXT, start_ms INTEGER,
        duration_ms INTEGER, outcome TEXT, error TEXT, attributes TEXT);`);
    const insert = db.prepare('INSERT INTO logs VALUES (?, ?, ?, ?)');
    insert.run(traceId, 'span', request.timeframe.from + 1, JSON.stringify([{ event: 'run.correlation', flueSubmissionRef: ref, secret }]));
    insert.run('other', 'span', request.timeframe.from + 1, JSON.stringify([{ event: 'run.correlation', flueSubmissionRef: `${ref}_other`, secret }]));
    db.prepare('INSERT INTO spans VALUES (?, ?, NULL, ?, ?, 13, ?, NULL, ?)').run(traceId, 'span', coordinates.workerName,
      request.timeframe.from + 2, 'ok', JSON.stringify({ 'gen_ai.operation.name': 'chat', 'gen_ai.prompt': secret }));
    const query = localDiagnosticQuery(request, session);
    const rows = db.prepare(query.sql).all(...query.params);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.traceId === traceId));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(secret));
    const empty = localDiagnosticQuery(request, null);
    assert.equal(db.prepare(empty.sql).all(...empty.params).length, 0);
  } finally { db.close(); }
});

test('CLI preserves each attempt in private files outside Git and rejects target mismatches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-diagnostics-test-'));
  const output: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (v: string) => output.push(v), stderr: (v: string) => errors.push(v),
    readRegistry: () => ({ targets: { amber: { workerName: coordinates.workerName, workspaceId: coordinates.workspaceId } } }) };
  const prepare = ['prepare', '--target', 'amber', '--account-id', coordinates.accountId,
    '--admin-origin', coordinates.adminOrigin, '--slack-url', coordinates.slackUrl];
  try {
    assert.equal(await runDiagnosticCli([...prepare, '--output-root', root], io), 0);
    const { record } = JSON.parse(output.at(-1)!);
    assert.equal(statSync(record).mode & 0o777, 0o700);
    assert.equal(statSync(join(record, 'request.json')).mode & 0o777, 0o600);
    const input = join(root, 'session-input.json');
    writeFileSync(input, JSON.stringify(sessionBody()));
    const query = ['query', '--record', record, '--session', input];
    assert.equal(await runDiagnosticCli(query, io), 0);
    const first = JSON.parse(output.at(-1)!);
    assert.equal(await runDiagnosticCli(query, io), 0);
    assert.notEqual(JSON.parse(output.at(-1)!).attempt, first.attempt);
    assert.doesNotMatch(readFileSync(join(first.attempt, 'session.json'), 'utf8'), new RegExp(secret));
    assert.equal(await runDiagnosticCli([...prepare, '--worker', 'wrong', '--output-root', root], io), 1);
    assert.match(errors.at(-1)!, /disagree/);
    assert.equal(await runDiagnosticCli([...prepare, '--output-root', process.cwd()], io), 1);
    assert.match(errors.at(-1)!, /outside Git/);
    writeFileSync(input, secret);
    assert.equal(await runDiagnosticCli(query, io), 1);
    assert.doesNotMatch(errors.at(-1)!, new RegExp(secret));
    const otherRepo = join(root, 'other-repo');
    execFileSync('git', ['init', '--quiet', otherRepo]);
    const trackedLocation = join(otherRepo, 'session.json');
    writeFileSync(trackedLocation, JSON.stringify(sessionBody()));
    assert.equal(await runDiagnosticCli(['query', '--record', record, '--session', trackedLocation], io), 1);
    assert.match(errors.at(-1)!, /outside Git/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
