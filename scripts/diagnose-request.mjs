#!/usr/bin/env node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { outsideGit } from './lib/private-evidence.mjs';
import { readEnvironmentRegistry } from './lib/environment-registry.mjs';
import { cloudflareDiagnosticScript, localDiagnosticQuery, projectDiagnosticSession, resolveDiagnosticRequest } from './lib/request-diagnostics.mjs';

const HELP = `Usage: npm run diagnose -- <prepare|query> [options]

prepare --target amber|cobalt --account-id ID --admin-origin https://HOST
        --slack-url URL [--run-id ID] [--from UTC --to UTC] [--trace-id ID]
        [--output-root PRIVATE_DIRECTORY]
  Or use explicit --worker NAME --workspace ID for another resolved target.
  Local: --local --worker NAME --workspace ID --admin-origin http://127.0.0.1:PORT
  Run-ID-only requests require --from and --to (UTC ending Z, <=30 minutes).
  This only creates a private record. It does not contact Slack or the Worker.

query --record DIRECTORY --session PRIVATE_JSON_FILE
  Read the prepare command's Admin URL through an authenticated browser first.
  Saves a content-free snapshot and a bounded Cloudflare MCP script or Local
  Explorer query. It does not fetch credentials or execute the query itself.
  If Sessions is unavailable: --no-session (the gap stays in the evidence).
  Each attempt uses a new directory so the first failure cannot be overwritten.
`;

const readJson = (file) => {
  if (statSync(file).size > 5 * 1024 * 1024) throw new Error('Evidence input exceeds 5 MiB.');
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('Evidence input could not be read as JSON.'); }
};
function privateDirectory(root, prefix) {
  outsideGit(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(realpathSync(root), prefix));
  chmodSync(directory, 0o700);
  return directory;
}
function writePrivate(file, value) {
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

export async function runDiagnosticCli(argv, io = {}) {
  const output = io.stdout ?? ((value) => process.stdout.write(value));
  const error = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    const { values: flags, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      ...Object.fromEntries(['target', 'worker', 'workspace', 'account-id', 'admin-origin', 'slack-url',
        'run-id', 'from', 'to', 'trace-id', 'output-root', 'record', 'session'].map((name) => [name, { type: 'string' }])),
      local: { type: 'boolean' }, 'no-session': { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (flags.help) { output(HELP); return 0; }
    if (positionals.length !== 1) throw new Error('Choose prepare or query. Use --help for usage.');
    const command = positionals[0];
    let result;
    if (command === 'prepare') {
      if (flags.record || flags.session || flags['no-session']) throw new Error('Evidence inputs belong to query.');
      let registration;
      if (flags.target) {
        if (!['amber', 'cobalt'].includes(flags.target) || flags.local) throw new Error('Use a registered hosted target, or explicit local coordinates.');
        registration = (io.readRegistry ?? readEnvironmentRegistry)().targets[flags.target];
        if ((flags.worker && flags.worker !== registration.workerName) ||
          (flags.workspace && flags.workspace !== registration.workspaceId)) throw new Error('Coordinates disagree with the registered target.');
      }
      const request = resolveDiagnosticRequest({
        target: flags.target, workerName: registration?.workerName ?? flags.worker,
        workspaceId: registration?.workspaceId ?? flags.workspace, accountId: flags['account-id'],
        adminOrigin: flags['admin-origin'], slackUrl: flags['slack-url'], runId: flags['run-id'],
        from: flags.from, to: flags.to, traceId: flags['trace-id'], local: flags.local,
      });
      const record = privateDirectory(flags['output-root'] ?? join(homedir(), '.chickpea', 'diagnostics'), 'request-');
      writePrivate(join(record, 'request.json'), request);
      result = { record, runId: request.runId, adminUrl: request.adminUrl,
        next: 'Read adminUrl using existing authenticated Admin access, then run query --record DIRECTORY --session PRIVATE_JSON_FILE.' };
    } else if (command === 'query') {
      if (Object.keys(flags).some((name) => !['record', 'session', 'no-session'].includes(name))) throw new Error('Query uses the coordinates saved by prepare.');
      if (!flags.record || Boolean(flags.session) === Boolean(flags['no-session'])) throw new Error('Query needs --record and either --session or --no-session.');
      const record = outsideGit(flags.record);
      const saved = readJson(join(record, 'request.json'));
      // Revalidate record coordinates rather than trusting an arbitrary URL in a file.
      const request = resolveDiagnosticRequest({ ...saved, local: saved.runtime === 'local',
        adminOrigin: new URL(saved.adminUrl).origin, traceId: saved.suppliedTraceId,
        from: new Date(saved.timeframe.from).toISOString(), to: new Date(saved.timeframe.to).toISOString() });
      if (flags.session) outsideGit(flags.session);
      const session = flags.session ? projectDiagnosticSession(readJson(flags.session), request) : null;
      const attempt = privateDirectory(record, 'attempt-');
      writePrivate(join(attempt, 'session.json'), session);
      const local = request.runtime === 'local';
      const queryFile = join(attempt, local ? 'local-query.json' : 'cloudflare-query.js');
      writePrivate(queryFile, local ? localDiagnosticQuery(request, session) : cloudflareDiagnosticScript(request, session));
      writePrivate(join(attempt, 'evidence.json'), {
        createdAt: new Date().toISOString(), runId: request.runId, runtime: request.runtime,
        ledgerAvailable: session !== null, correlation: request.suppliedTraceId ? 'operator_supplied_trace' : 'requires_ledger_submission_bridge',
        queryFile, reportFile: join(attempt, 'report.json'),
        acceptance: 'unverified',
      });
      result = { attempt, queryFile, reportFile: join(attempt, 'report.json'),
        ...(local ? { url: request.explorerUrl } : { accountId: request.accountId }),
        next: local
          ? 'POST local-query.json to url; preserve the response as reportFile. Use the saved session timeline alongside it. No rows or a 300-row result means coverage is incomplete.'
          : 'Discover the current telemetry API schema with cloudflare-api search, then execute this script with the explicit accountId. Save its projected result as reportFile. Record Slack/provider acceptance separately.' };
    } else throw new Error('Choose prepare or query. Use --help for usage.');
    output(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (cause) {
    // Do not echo parser/input errors that can contain raw credentials or bodies.
    const message = cause instanceof Error && !cause.code?.startsWith('ERR_PARSE_ARGS') &&
      !cause.message.includes('\n') ? cause.message : 'Invalid diagnostic input. Use --help for usage.';
    error(`Diagnosis command failed: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runDiagnosticCli(process.argv.slice(2));
}
