#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { outsideGit } from './lib/private-evidence.mjs';
import { sourceInputs } from './lib/verification-inputs.mjs';
import { templateSpec } from './lib/verification-spec.mjs';
import { appendEvent, createRun, preflight, readPrivateJson, readRun, renderReport, status, updateRun } from './lib/verification-record.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Usage: npm run verify:live:record -- COMMAND --run /private/path/run.json

template  --mode MODE [--area NAME] --output FILE  Create unresolved prerequisites
init      --spec /private/path/spec.json
preflight                         Show runnable cases, blockers, registry warnings
refresh   --spec FILE --reason TEXT  Refresh observed capabilities and context
begin     --case ID [--reason TEXT]  Record an attempt before the action
record    --event FILE               Record outcome, cleanup, repair, batch or candidate_transition
status                              Resume: open attempts, cleanup, repairs and next work
report    [--output FILE]            Generate Markdown from the record

All files must be outside Git. The record is private and never runs a browser,
claims/deploys a lane, retries an action, or cleans a resource. See
qa/live/operator/records.md for a spec and event examples. Use existing
verify:regression --record FILE [--reuse] for measured offline check receipts.
`;

export function runRecordCli(argv, root = ROOT, io = {}) {
  const output = io.stdout ?? ((value) => process.stdout.write(value));
  const error = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    const { values: flags, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      ...Object.fromEntries(['run', 'spec', 'reason', 'case', 'event', 'output', 'mode'].map((key) => [key, { type: 'string' }])),
      area: { type: 'string', multiple: true },
      help: { type: 'boolean' },
    } });
    if (flags.help) { output(HELP); return 0; }
    if (positionals.length !== 1) throw new Error('Choose one command. Use --help.');
    const command = positionals[0];
    const allowed = {
      template: ['mode', 'area', 'output'], init: ['run', 'spec'], preflight: ['run'], refresh: ['run', 'spec', 'reason'],
      begin: ['run', 'case', 'reason'], record: ['run', 'event'], status: ['run'], report: ['run', 'output'],
    }[command];
    if (!allowed || Object.keys(flags).some((key) => !allowed.includes(key))) throw new Error('Unknown command or inapplicable option.');
    if (command === 'template') {
      if (!flags.output) throw new Error('template needs --output.');
      const path = outsideGit(flags.output);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(templateSpec(flags.mode, flags.area), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      output(`${JSON.stringify({ output: path, next: 'Resolve observed capabilities, review selected scope, then init. Unavailable fixtures remain blockers.' })}\n`);
      return 0;
    }
    if (!flags.run) throw new Error('Pass --run.');
    let result, code = 0;
    if (command === 'init') {
      if (!flags.spec) throw new Error('init needs --spec.');
      result = createRun(flags.run, readPrivateJson(flags.spec), sourceInputs(root));
      result = { runId: result.id, preflight: preflight(result) };
    } else if (['refresh', 'begin', 'record'].includes(command)) {
      let event;
      if (command === 'record') {
        if (!flags.event) throw new Error('record needs --event.');
        event = readPrivateJson(flags.event);
      } else if (command === 'refresh') {
        if (!flags.spec) throw new Error('refresh needs --spec.');
        event = { type: 'refresh', spec: readPrivateJson(flags.spec), reason: flags.reason };
      } else event = { type: 'begin', caseId: flags.case, ...(flags.reason ? { reason: flags.reason } : {}) };
      const source = sourceInputs(root);
      result = updateRun(flags.run, (run) => appendEvent(run, event, source));
    } else {
      const run = readRun(flags.run);
      if (command === 'preflight') { result = preflight(run); code = result.ready ? 0 : 1; }
      else {
        const view = status(run, sourceInputs(root));
        if (command === 'status') result = view;
        else {
          const report = renderReport(view);
          if (!flags.output) { output(`${report}\n`); return 0; }
          const path = outsideGit(flags.output);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          // A report is disposable. Never replace the record or a retained evidence file.
          writeFileSync(path, report, { flag: 'wx', mode: 0o600 });
          result = { output: path, complete: view.complete };
        }
      }
    }
    output(`${JSON.stringify(result, null, 2)}\n`);
    return code;
  } catch (cause) {
    error(`Record command failed: ${cause instanceof Error && !cause.code?.startsWith('ERR_PARSE_ARGS') ? cause.message : 'Invalid arguments.'}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runRecordCli(process.argv.slice(2));
}
