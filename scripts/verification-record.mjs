#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { outsideGit } from './lib/private-evidence.mjs';
import { sourceInputs } from './lib/verification-inputs.mjs';
import { templateSpec } from './lib/verification-spec.mjs';
import { appendEvent, createRun, currentSpec, preflight, readPrivateJson, readRun, renderReport, status, updateRun, validateSpec } from './lib/verification-record.mjs';
import { buildCase, buildCleanup, buildOutcome, buildResource } from './lib/verification-record-builders.mjs';
import { familyStatus, readRunFamily, renderFamilyReport } from './lib/verification-record-family.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Usage: npm run verify:live:record -- COMMAND --run /private/path/run.json

template  --mode MODE [--purpose PURPOSE] [--area NAME] --output FILE
case-add  --spec FILE --output FILE --case ID --title TEXT --context ID --area AREA --require CAP --proof SURFACE
init      --spec FILE [--parent-run FILE] [--original-case CHILD=PARENT]
preflight                         Show runnable cases, blockers, registry warnings
refresh   --spec FILE --reason TEXT  Refresh observed capabilities and context
begin     --case ID [--reason TEXT]  Record an attempt before the action
record    --event FILE               Record outcome, cleanup, repair, batch or candidate_transition
resource  --case ID --provider ID --kind ID --resource-id ID --ownership TYPE --cleanup-preset PRESET|--expected-file FILE --evidence FILE
finish|resolve --attempt ID --result RESULT --summary TEXT --evidence FILE --proof SURFACE=FILE [--completed-at ISO] [--observed-at ISO] [--timing-observation-ms MS]
cleanup   --resource ID --outcome OUTCOME [--observed-file FILE] --evidence FILE
phase-start --phase NAME [--case ID] [--attempt ID]
phase-stop --phase-id ID
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
      ...Object.fromEntries(['run', 'spec', 'reason', 'case', 'event', 'output', 'mode', 'purpose', 'title', 'context', 'max-attempts', 'max-wait-ms', 'min-observation-ms', 'original-request', 'expected-outcome', 'variant', 'cleanup-contract', 'provider', 'kind', 'resource-id', 'ownership', 'cleanup-preset', 'expected-file', 'attempt', 'result', 'summary', 'category', 'completed-at', 'observed-at', 'timing-observation-ms', 'cost-usd', 'resource', 'outcome', 'observed-file', 'phase', 'phase-id', 'parent-run'].map((key) => [key, { type: 'string' }])),
      area: { type: 'string', multiple: true }, require: { type: 'string', multiple: true }, proof: { type: 'string', multiple: true }, evidence: { type: 'string', multiple: true }, 'original-case': { type: 'string', multiple: true },
      'stop-at': { type: 'string' }, 'max-occurrences': { type: 'string' }, family: { type: 'boolean' },
      help: { type: 'boolean' },
    } });
    if (flags.help) { output(HELP); return 0; }
    if (positionals.length !== 1) throw new Error('Choose one command. Use --help.');
    const command = positionals[0];
    const allowed = {
      template: ['mode', 'purpose', 'area', 'output'],
      'case-add': ['spec', 'output', 'case', 'title', 'context', 'area', 'require', 'proof', 'max-attempts', 'max-wait-ms', 'min-observation-ms', 'original-request', 'expected-outcome', 'variant', 'cleanup-contract'],
      init: ['run', 'spec', 'parent-run', 'original-case'], preflight: ['run'], refresh: ['run', 'spec', 'reason'],
      begin: ['run', 'case', 'reason'], record: ['run', 'event'], status: ['run'], report: ['run', 'output', 'family'],
      resource: ['run', 'case', 'provider', 'kind', 'resource-id', 'ownership', 'cleanup-preset', 'expected-file', 'evidence', 'stop-at', 'max-occurrences'],
      finish: ['run', 'attempt', 'result', 'summary', 'category', 'evidence', 'proof', 'completed-at', 'observed-at', 'timing-observation-ms', 'cost-usd'],
      resolve: ['run', 'attempt', 'result', 'summary', 'category', 'evidence', 'proof', 'completed-at', 'observed-at', 'timing-observation-ms', 'cost-usd'],
      cleanup: ['run', 'resource', 'outcome', 'observed-file', 'evidence'],
      'phase-start': ['run', 'phase', 'case', 'attempt'], 'phase-stop': ['run', 'phase-id'],
    }[command];
    if (!allowed || Object.keys(flags).some((key) => !allowed.includes(key))) throw new Error('Unknown command or inapplicable option.');
    if (command === 'template') {
      if (!flags.output) throw new Error('template needs --output.');
      const path = outsideGit(flags.output);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(templateSpec(flags.mode, flags.area, Date.now(), flags.purpose), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      output(`${JSON.stringify({ output: path, next: 'Resolve observed capabilities, review selected scope, then init. Unavailable fixtures remain blockers.' })}\n`);
      return 0;
    }
    if (command === 'case-add') {
      if (!flags.spec || !flags.output) throw new Error('case-add needs --spec and a distinct --output.');
      const input = outsideGit(flags.spec), path = outsideGit(flags.output);
      if (input === path) throw new Error('case-add output must differ from its input spec.');
      const spec = structuredClone(readPrivateJson(input));
      const named = { case: flags.case, title: flags.title, context: flags.context, area: flags.area, require: flags.require, proof: flags.proof,
        maxAttempts: flags['max-attempts'], maxWaitMs: flags['max-wait-ms'], minObservationMs: flags['min-observation-ms'],
        originalRequest: flags['original-request'], expectedOutcome: flags['expected-outcome'], variant: flags.variant, cleanup: flags['cleanup-contract'] };
      spec.cases.push(buildCase(spec, named)); validateSpec(spec);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      output(`${JSON.stringify({ output: path, caseId: flags.case })}\n`); return 0;
    }
    if (!flags.run) throw new Error('Pass --run.');
    let result, code = 0;
    if (command === 'init') {
      if (!flags.spec) throw new Error('init needs --spec.');
      let lineage;
      if (flags['parent-run']) {
        const parentPath = outsideGit(flags['parent-run']), parent = readRun(parentPath);
        const family = readRunFamily(parentPath, sourceInputs(root));
        if (family.missingAncestor) throw new Error('Parent run family has a missing ancestor.');
        const originalCases = {};
        for (const mapping of flags['original-case'] ?? []) {
          const [child, original, extra] = mapping.split('=');
          if (!child || !original || extra !== undefined) throw new Error('Original case must use CHILD=PARENT.');
          if (!currentSpec(parent).cases.some((entry) => entry.id === original)) throw new Error('Original parent case was not found in its current spec.');
          originalCases[child] = { runId: parent.id, caseId: original };
        }
        const spec = readPrivateJson(flags.spec);
        if (Object.keys(originalCases).some((child) => !spec.cases.some((entry) => entry.id === child))) throw new Error('Original-case child was not found in the new spec.');
        lineage = { parent: { path: parentPath, runId: parent.id }, originalCases };
      } else if (flags['original-case']?.length) throw new Error('--original-case needs --parent-run.');
      result = createRun(flags.run, readPrivateJson(flags.spec), sourceInputs(root), Date.now(), lineage);
      result = { runId: result.id, preflight: preflight(result) };
    } else if (['refresh', 'begin', 'record', 'resource', 'finish', 'resolve', 'cleanup', 'phase-start', 'phase-stop'].includes(command)) {
      let event;
      if (command === 'record') {
        if (!flags.event) throw new Error('record needs --event.');
        event = readPrivateJson(flags.event);
      } else if (command === 'refresh') {
        if (!flags.spec) throw new Error('refresh needs --spec.');
        event = { type: 'refresh', spec: readPrivateJson(flags.spec), reason: flags.reason };
      } else if (command === 'begin') event = { type: 'begin', caseId: flags.case, ...(flags.reason ? { reason: flags.reason } : {}) };
      else if (command !== 'resource') {
        const named = { ...flags, completedAt: flags['completed-at'], observedAt: flags['observed-at'], timingObservationMs: flags['timing-observation-ms'], costUsd: flags['cost-usd'], observedFile: flags['observed-file'], phaseId: flags['phase-id'] };
        if (command === 'finish' || command === 'resolve') event = buildOutcome(command, named);
        else if (command === 'cleanup') event = buildCleanup(named, readPrivateJson);
        else if (command === 'phase-start') event = { type: 'phase_start', phase: flags.phase, ...(flags.case ? { caseId: flags.case } : {}), ...(flags.attempt ? { attemptId: flags.attempt } : {}) };
        else event = { type: 'phase_finish', phaseId: flags['phase-id'] };
      }
      const source = sourceInputs(root);
      result = updateRun(flags.run, (run) => {
        const input = command === 'resource' ? buildResource(run, { ...flags, resourceId: flags['resource-id'], cleanupPreset: flags['cleanup-preset'], expectedFile: flags['expected-file'], stopAt: flags['stop-at'], maxOccurrences: flags['max-occurrences'] }, readPrivateJson) : event;
        return appendEvent(run, input, source);
      });
    } else {
      const run = readRun(flags.run);
      if (command === 'preflight') { result = preflight(run); code = result.ready ? 0 : 1; }
      else {
        const view = status(run, sourceInputs(root));
        if (command === 'status') result = view;
        else {
          const report = flags.family ? renderFamilyReport(familyStatus(readRunFamily(flags.run, sourceInputs(root))), renderReport) : renderReport(view);
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
