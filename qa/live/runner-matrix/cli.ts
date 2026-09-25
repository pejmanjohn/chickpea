#!/usr/bin/env node
/**
 * Scripted driver for the parallel-turns / runner-stack live matrix.
 * See qa/live/operator/runner-matrix.md. Usage: npm run verify:live:runner-matrix -- --help
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// @ts-expect-error Verification tooling JavaScript helper.
import { readEnvironmentRegistry } from '../../../scripts/lib/environment-registry.mjs';
// @ts-expect-error Verification tooling JavaScript helper.
import { outsideGit } from '../../../scripts/lib/private-evidence.mjs';
import { evaluateMatrix, renderMarkdown, type MatrixResults } from './analysis.ts';
import { fakeScenario } from './fake.ts';
import { HookRunner } from './hooks.ts';
import { RECEIVER_PORT, renderHarness, renderSnippets } from './page.ts';
import { buildPlan, defaultTag, parseCaseList, readSpec } from './plan.ts';
import { addSpecCases, beginAttempts, finishAttempts } from './record.ts';
import { extractRuntime, splitJsonObjects, TailCapture } from './tail.ts';
import type { BrowserExport, MatrixParams, MatrixPlan, RunRecord } from './types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const HELP = `Usage: npm run verify:live:runner-matrix -- COMMAND --record /private/dir [options]

plan        Write plan.json, harness.js and page snippets for one run.
            --lane amber|cobalt|violet --channel ID --agent-a HANDLE --agent-b HANDLE
            [--dm ID] [--tag TAG] [--cases parity,first-status,long-turns,redeploy-mid-turn,rate-limit]
            [--fs-n 8] [--long-k 4] [--redeploy-r 2] [--burst-m 12] [--spec FILE] [--params PRIVATE.json]
            Worker, workspace and bot user come from the lane registry; --params may supply any field.
spec-cases  Append one record case per selected matrix case to a private run spec.
            --spec IN --output OUT --context ID [--require CAP]... [--prefix rm-] (cases from plan.json)
run         Tail the lane Worker, open record attempts, fire deploy hooks at their offsets, wait out the plan.
            --t0 EPOCH_MS (returned by arm.js) [--allow-deploy] [--cwd CANDIDATE_WORKTREE]
            [--run RUN.json] [--prefix rm-] [--hook-command "CMD ARGS"] [--no-tail]
receive     One-shot 127.0.0.1 receiver for the export: start it, then evaluate send.js in the Slack tab
            (after collect.js). Writes browser-export.json. [--port 47811] [--timeout-ms 300000]
report      Join the browser export, tail and hook records; write results.json and results.md.
            [--run RUN.json --finish] [--prefix rm-]
dry-run     Offline: fake export + tail for a plan with fake coordinates, then report.
            [--cases LIST]

The page half runs in the lane browser's signed-in Slack tab via evaluate_script:
harness.js (install), arm.js (returns t0), status.js, collect.js, chunk.js (edit the index).
All files stay in the private record directory, outside Git.
`;

const STRING_FLAGS = ['record', 'lane', 'channel', 'agent-a', 'agent-b', 'dm', 'tag', 'cases', 'fs-n', 'long-k', 'redeploy-r', 'burst-m', 'spec', 'params',
  'output', 'context', 'prefix', 't0', 'cwd', 'run', 'hook-command', 'workspace', 'worker', 'bot-user', 'lead-ms', 'port', 'timeout-ms'] as const;

type Flags = Partial<Record<typeof STRING_FLAGS[number], string>> & { require?: string[]; 'allow-deploy'?: boolean; 'no-tail'?: boolean; finish?: boolean; help?: boolean };

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}
const writeJson = (path: string, value: unknown) => writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function recordDir(flags: Flags): string {
  if (!flags.record) throw new Error('Pass --record /private/absolute/dir (outside Git).');
  const dir = outsideGit(flags.record);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const int = (value: string | undefined) => (value === undefined ? undefined : Number(value));

function planParams(flags: Flags): MatrixParams {
  const privateParams = flags.params ? readJson<Partial<MatrixParams> & { agents?: Partial<MatrixParams['agents']> }>(outsideGit(flags.params)) : {};
  const lane = flags.lane ?? privateParams.lane;
  if (!lane || !/^(amber|cobalt|violet)$/.test(lane)) throw new Error('Pass --lane amber|cobalt|violet.');
  let registration: Record<string, any> = {};
  if (!(flags.workspace && flags.worker && flags['bot-user'])) {
    registration = readEnvironmentRegistry().targets?.[lane] ?? {};
  }
  const counts: NonNullable<MatrixParams['counts']> = {};
  for (const [flag, key] of [['fs-n', 'first-status'], ['long-k', 'long-turns'], ['redeploy-r', 'redeploy-mid-turn'], ['burst-m', 'rate-limit']] as const) {
    const value = int(flags[flag]);
    if (value !== undefined) counts[key] = value;
  }
  return {
    lane,
    tag: flags.tag ?? privateParams.tag ?? defaultTag(),
    workspaceId: flags.workspace ?? privateParams.workspaceId ?? registration.workspaceId,
    worker: flags.worker ?? privateParams.worker ?? registration.workerName,
    botUserId: flags['bot-user'] ?? privateParams.botUserId ?? registration.botUserId,
    channel: flags.channel ?? privateParams.channel ?? '',
    dm: flags.dm ?? privateParams.dm,
    agents: { a: flags['agent-a'] ?? privateParams.agents?.a ?? '', b: flags['agent-b'] ?? privateParams.agents?.b ?? '' },
    cases: parseCaseList(flags.cases),
    counts,
  };
}

function writePlanFiles(dir: string, plan: MatrixPlan, leadMs: number): void {
  writeJson(join(dir, 'plan.json'), plan);
  writePrivate(join(dir, 'harness.js'), renderHarness(plan));
  for (const [name, content] of Object.entries(renderSnippets(leadMs))) writePrivate(join(dir, name), content);
}

function readExport(dir: string): BrowserExport | null {
  const whole = join(dir, 'browser-export.json');
  if (existsSync(whole)) return readJson<BrowserExport>(whole);
  const parts = readdirSync(dir).filter((name) => /^browser-export\.part-\d+\.txt$/.test(name)).sort();
  if (parts.length === 0) return null;
  return JSON.parse(parts.map((name) => readFileSync(join(dir, name), 'utf8')).join('')) as BrowserExport;
}

export function reportFromDir(dir: string, now = new Date()): { results: MatrixResults; paths: Record<string, string> } {
  const plan = readJson<MatrixPlan>(join(dir, 'plan.json'));
  const runPath = join(dir, 'run-state.json');
  const run = existsSync(runPath) ? readJson<RunRecord>(runPath) : null;
  const data = readExport(dir);
  const tailPath = join(dir, 'tail.json');
  const runtime = extractRuntime(existsSync(tailPath) ? splitJsonObjects(readFileSync(tailPath, 'utf8')) : []);
  const paths: Record<string, string> = {
    plan: join(dir, 'plan.json'), browserExport: existsSync(join(dir, 'browser-export.json')) ? join(dir, 'browser-export.json') : `${join(dir, 'browser-export.part-*.txt')}`,
    tail: tailPath, tailRuntime: join(dir, 'tail-runtime.json'), runState: runPath, results: join(dir, 'results.json'), markdown: join(dir, 'results.md'),
  };
  if (data && data.tag !== plan.tag) throw new Error(`Browser export tag ${data.tag} does not match plan tag ${plan.tag}.`);
  const results = evaluateMatrix({ plan, data, runtime, run, now });
  writeJson(paths.tailRuntime!, { ...runtime, turnLatency: runtime.turnLatency, note: 'Filtered from tail.json: turn_latency, gateway_delivery, fiber diagnostics, failure/rate-limit signals.' });
  writeJson(paths.results!, results);
  writePrivate(paths.markdown!, renderMarkdown(results, paths));
  return { results, paths };
}

async function runCommand(flags: Flags, dir: string): Promise<number> {
  const plan = readJson<MatrixPlan>(join(dir, 'plan.json'));
  const t0 = int(flags.t0);
  if (!t0 || !Number.isFinite(t0)) throw new Error('Pass --t0 with the epoch milliseconds returned by arm.js.');
  const lead = t0 - Date.now();
  if (lead < 10_000) throw new Error(`T0 is ${Math.round(lead / 1000)} s away; the tail needs at least 10 s. Run disarm.js, then arm.js again, then run.`);
  if (t0 - Date.now() > 30 * 60_000) throw new Error('T0 is more than 30 minutes away; arm again closer to the run.');
  const statePath = join(dir, 'run-state.json');
  const previous = existsSync(statePath) ? readJson<RunRecord>(statePath) : null;
  const record: RunRecord = {
    schema: 'chickpea-runner-matrix-run/v1', t0, startedAt: Date.now(), endedAt: null, hooks: [],
    tail: { file: null, segments: [], skipped: null }, attempts: previous?.t0 === t0 ? previous.attempts : {}, interrupted: false,
  };
  const log = (line: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  const save = () => writeJson(statePath, record);

  if (flags.run) {
    record.attempts = beginAttempts(outsideGit(flags.run), flags.prefix ?? 'rm-', plan.cases, record.attempts, `runner matrix ${plan.tag}`);
    save();
    log(`record attempts open: ${Object.entries(record.attempts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  let tail: TailCapture | null = null;
  if (flags['no-tail']) record.tail.skipped = 'operator passed --no-tail';
  else if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Set CLOUDFLARE_ACCOUNT_ID for the lane account (the tail needs it), or pass --no-tail and record the gap.');
  else {
    record.tail.file = join(dir, 'tail.json');
    tail = new TailCapture({ worker: plan.worker, file: record.tail.file, errFile: join(dir, 'tail.err'), cwd: ROOT });
    tail.start();
    const ready = await tail.waitReady(Math.min(30_000, t0 - Date.now() - 2000));
    log(ready ? `tail connected to the lane Worker` : 'WARNING: tail did not report readiness before T0; continuing (check tail.err)');
  }
  const hooks = new HookRunner({
    plan, t0, recordDir: dir, cwd: flags.cwd ? resolve(flags.cwd) : ROOT, allowDeploy: Boolean(flags['allow-deploy']), log,
    ...(flags['hook-command'] ? { command: flags['hook-command'].split(/\s+/).filter(Boolean) } : {}),
  });
  record.hooks = hooks.records;
  hooks.start();
  if (!flags['allow-deploy'] && plan.hooks.length) log(`deploy hooks skipped (${plan.hooks.map((h) => h.id).join(', ')}); dependent cases will be blocked`);
  save();

  const end = t0 + plan.endMs;
  log(`T0 ${new Date(t0).toISOString()}; plan ends ${new Date(end).toISOString()} (${Math.round(plan.endMs / 60000)} min)`);
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  while (!interrupted && Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(0, end - Date.now()))));
    if (tail) record.tail.segments = tail.segments;
    save();
  }
  record.interrupted = interrupted;
  log(interrupted ? 'interrupted; stopping hooks (a running deploy is allowed to finish) and the tail' : 'plan window over; stopping');
  await hooks.stop();
  if (tail) { await tail.stop(); record.tail.segments = tail.segments; }
  record.endedAt = Date.now();
  save();
  log(`next: start \`receive --record ${dir}\`, then in the lane Slack tab evaluate ${join(dir, 'collect.js')} and ${join(dir, 'send.js')} (or save each chunk(i) as browser-export.part-000.txt, 001 ...), then run report.`);
  return interrupted ? 130 : 0;
}

const SLACK_ORIGIN = 'https://app.slack.com';

/** Page served to the receiver window: relays the opener's postMessage to this origin. */
function receiverPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>runner-matrix receiver</title><p>Waiting for the export...</p><script>
addEventListener('message', async (event) => {
  if (event.origin !== ${JSON.stringify(SLACK_ORIGIN)} || typeof event.data !== 'string' || window.__sent) return;
  window.__sent = true;
  const response = await fetch('/upload', { method: 'POST', body: event.data });
  document.body.textContent = 'Export ' + (response.ok ? 'saved' : 'refused (' + response.status + ')') + '; this tab can be closed.';
  event.source.postMessage('ack:' + response.status, event.origin);
});
</script>`;
}

/** Receive one export over loopback and write it privately. Resolves with the written path. */
export function receiveExport(dir: string, tag: string, options: { port?: number | undefined; timeoutMs?: number | undefined; log?: ((line: string) => void) | undefined } = {}): Promise<string> {
  const port = options.port ?? RECEIVER_PORT;
  const target = join(dir, 'browser-export.json');
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(receiverPage());
        return;
      }
      if (req.method !== 'POST' || req.url !== '/upload') { res.writeHead(404); res.end(); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; if (body.length > 64 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        let parsed: BrowserExport;
        try { parsed = JSON.parse(body) as BrowserExport; } catch { res.writeHead(400); res.end('not json'); return; }
        if (parsed.tag !== tag) { res.writeHead(409); res.end('tag mismatch'); return; }
        writePrivate(target, body);
        res.writeHead(200); res.end('ok');
        options.log?.(`received export: ${body.length} chars, ${Object.keys(parsed.threads ?? {}).length} thread(s) -> ${target}`);
        clearTimeout(timer);
        server.close(() => resolvePromise(target));
      });
    });
    const timer = setTimeout(() => { server.close(); reject(new Error(`no export received within ${Math.round((options.timeoutMs ?? 300_000) / 1000)} s`)); }, options.timeoutMs ?? 300_000);
    server.on('error', (error) => { clearTimeout(timer); reject(error); });
    server.listen(port, '127.0.0.1', () => options.log?.(`receiver listening on http://127.0.0.1:${port}/; evaluate ${join(dir, 'send.js')} in the lane Slack tab`));
  });
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      ...Object.fromEntries(STRING_FLAGS.map((key) => [key, { type: 'string' as const }])),
      require: { type: 'string', multiple: true }, 'allow-deploy': { type: 'boolean' }, 'no-tail': { type: 'boolean' }, finish: { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  const flags = values as Flags;
  if (flags.help || positionals.length !== 1) { process.stdout.write(HELP); return flags.help ? 0 : 2; }
  const command = positionals[0];
  if (command === 'plan') {
    const dir = recordDir(flags);
    const spec = readSpec(flags.spec ? resolve(flags.spec) : undefined);
    const plan = buildPlan(spec, planParams(flags));
    const leadMs = int(flags['lead-ms']) ?? 90_000;
    writePlanFiles(dir, plan, leadMs);
    process.stdout.write(`${JSON.stringify({
      plan: join(dir, 'plan.json'), tag: plan.tag, cases: plan.cases, messages: plan.items.length, hooks: plan.hooks.map((h) => h.id),
      windowMinutes: Math.round(plan.endMs / 600) / 100,
      next: [
        `spec-cases (once) then verify:live:record init/preflight`,
        `lane Slack tab: evaluate harness.js, then arm.js (returns t0)`,
        `npm run verify:live:runner-matrix -- run --record ${dir} --t0 <t0> --allow-deploy --run <run.json> --cwd <candidate worktree>`,
        'after run: receive, then collect.js + send.js in the Slack tab (or chunk.js by hand), then report',
      ],
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'spec-cases') {
    if (!flags.spec || !flags.output || !flags.context) throw new Error('spec-cases needs --spec, --output and --context.');
    const input = outsideGit(flags.spec), output = outsideGit(flags.output);
    if (input === output) throw new Error('spec-cases output must differ from its input.');
    const cases = flags.record ? readJson<MatrixPlan>(join(recordDir(flags), 'plan.json')).cases : parseCaseList(flags.cases);
    const ctx = flags.context;
    const requires = flags.require ?? [`${ctx}.target`, `${ctx}.owner`, `${ctx}.slack`, `${ctx}.channel`, `${ctx}.agents`];
    const next = addSpecCases(readJson(input), { context: ctx, requires, prefix: flags.prefix ?? 'rm-', cases });
    writeFileSync(output, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ output, cases: cases.map((c) => `${flags.prefix ?? 'rm-'}${c}`) })}\n`);
    return 0;
  }
  if (command === 'run') return runCommand(flags, recordDir(flags));
  if (command === 'receive') {
    const dir = recordDir(flags);
    const plan = readJson<MatrixPlan>(join(dir, 'plan.json'));
    const log = (line: string): void => { process.stdout.write(`${line}\n`); };
    await receiveExport(dir, plan.tag, { port: int(flags.port), timeoutMs: int(flags['timeout-ms']), log });
    return 0;
  }
  if (command === 'report') {
    const dir = recordDir(flags);
    const { results, paths } = reportFromDir(dir);
    const summary: Record<string, unknown> = { results: paths.results, markdown: paths.markdown, cases: results.cases.map((c) => ({ caseId: c.caseId, result: c.result, failures: c.failures.length })) };
    if (flags.finish) {
      if (!flags.run) throw new Error('--finish needs --run RUN.json.');
      const state = readJson<RunRecord>(join(dir, 'run-state.json'));
      const slack = existsSync(join(dir, 'browser-export.json')) ? join(dir, 'browser-export.json')
        : join(dir, readdirSync(dir).filter((name) => /^browser-export\.part-\d+\.txt$/.test(name)).sort()[0] ?? 'browser-export.json');
      const extra = [paths.tailRuntime!, join(dir, 'run-state.json'), ...state.hooks.map((h) => h.log).filter((p): p is string => Boolean(p))];
      summary.recorded = finishAttempts(outsideGit(flags.run), state.attempts, results.cases, { results: paths.results!, markdown: paths.markdown!, slack, extra }, new Date());
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return results.cases.every((c) => c.result === 'pass') ? 0 : 1;
  }
  if (command === 'dry-run') {
    const dir = recordDir(flags);
    const plan = buildPlan(readSpec(), {
      lane: 'amber', tag: flags.tag ?? 'RM-DRYRUN', workspaceId: 'TFAKEWORKSPACE', worker: 'fake-worker', botUserId: 'UFAKEBOT01',
      channel: 'CFAKECHAN01', agents: { a: 'fake-agent-a', b: 'fake-agent-b' }, cases: parseCaseList(flags.cases),
    });
    writePlanFiles(dir, plan, 90_000);
    const fake = fakeScenario(plan);
    writeJson(join(dir, 'browser-export.json'), fake.data);
    writePrivate(join(dir, 'tail.json'), fake.tailText);
    writeJson(join(dir, 'run-state.json'), fake.run);
    const { results, paths } = reportFromDir(dir);
    process.stdout.write(`${JSON.stringify({ dryRun: true, markdown: paths.markdown, cases: results.cases.map((c) => `${c.caseId}: ${c.result}`) }, null, 2)}\n`);
    return results.cases.every((c) => c.result === 'pass') ? 0 : 1;
  }
  process.stdout.write(HELP);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`runner-matrix: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
