#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { outsideGit } from './lib/private-evidence.mjs';
import { digest, sourceInputs } from './lib/verification-inputs.mjs';
import { assertNodeVersion } from './lib/node-version.mjs';
import { deterministicScheduleEvaluation, frozenNow, sampleScheduleModel, scheduleContract, scheduleContractDigest, summarizeModelSamples } from './lib/schedule-contract-evaluation.mjs';

const { values: flags } = parseArgs({ options: { live: { type: 'boolean' }, help: { type: 'boolean' },
  model: { type: 'string', multiple: true }, case: { type: 'string', multiple: true },
  'max-calls': { type: 'string' }, repeats: { type: 'string' }, output: { type: 'string' } } });
if (flags.help) {
  console.log('Usage: npm run evaluate:schedule-contract -- [--case ID] [--output PRIVATE_FILE]\nOptional model-only generation: --live --model PROVIDER/MODEL --max-calls N --output PRIVATE_FILE [--repeats 1..3]\nModels/cases may repeat as options. Maximum 24 calls, zero retries, 60 seconds and 2048 output tokens per call. Uses configured provider credentials; no tool actions execute.');
} else {
  assertNodeVersion();
  const corpus = JSON.parse(readFileSync(new URL('../evals/schedule-contract/cases.json', import.meta.url), 'utf8'));
  if (flags.case?.some((id) => !corpus.cases.some((entry) => entry.id === id))) throw new Error('Unknown case');
  corpus.cases = corpus.cases.filter((entry) => !flags.case || flags.case.includes(entry.id));
  const deterministic = await deterministicScheduleEvaluation(corpus);
  const report = { kind: 'synthetic schedule contract; no persisted actions or due-time/delivery proof',
    corpusDigest: digest(corpus), contractDigest: scheduleContractDigest, contract: scheduleContract, deterministic, samples: [] };
  const output = flags.output ? outsideGit(flags.output) : undefined;
  if (!flags.live && (flags.model || flags['max-calls'] || flags.repeats)) throw new Error('Model options require --live');
  let models, selected, repeats;
  if (flags.live) {
    const budget = Number(flags['max-calls']); repeats = Number(flags.repeats ?? 1);
    if (!output || !flags.model?.length || new Set(flags.model).size !== flags.model.length || !Number.isInteger(budget) || budget < 1 || budget > 24
      || !Number.isInteger(repeats) || repeats < 1 || repeats > 3 || corpus.cases.length * flags.model.length * repeats > budget) throw new Error('Live generation needs exact unique models, private output and a sufficient explicit 1..24 call budget; repeats 1..3.');
    if (!deterministic.passed) throw new Error('Fix deterministic product-contract failures before another model attempt');
    models = builtinModels();
    selected = flags.model.map((name) => {
      const split = name.indexOf('/');
      const model = models.getModel(name.slice(0, split), name.slice(split + 1));
      if (split < 1 || !model) throw new Error(`Exact model unavailable: ${name}. No substitution.`);
      return { name, model };
    });
    report.settings = { maxCalls: budget, repeats, maxRetries: 0, reasoningEffort: 'medium', maxTokens: 2048, timeoutMs: 60000 };
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const checkout = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (flags.live && checkout.status !== 0) throw new Error('Model comparison requires a Git checkout for the full source fingerprint.');
  report.source = checkout.status === 0 ? sourceInputs(root) : { kind: 'source archive', head: null, tree: null };
  report.measurements = { usageCost: 'unverified adapter registry estimate; not billing', verifiedPriceDate: null, billedUsd: null,
    tokens: 'input is uncached; cacheRead and cacheWrite are separate; reasoning is a subset of output', routeIdentity: 'adapter identity may echo the request; routedModel needs independent evidence' };
  if (output) writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  const save = () => {
    report.comparison = summarizeModelSamples(report.samples);
    report.counts = { attempted: report.samples.length, evaluable: report.samples.filter((s) => s.evaluable).length,
      passed: report.samples.filter((s) => s.passed).length, transportFailures: report.samples.filter((s) => s.category === 'transport').length };
    const temporary = `${output}.${randomUUID()}.pending`;
    writeFileSync(temporary, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 }); renameSync(temporary, output);
  };
  if (flags.live) {
    for (let repetition = 0; repetition < repeats; repetition++) for (const [index, entry] of corpus.cases.entries()) {
      // Rotate first model across identical case/repetition settings.
      const offset = (index + repetition) % selected.length;
      for (const { name, model } of [...selected.slice(offset), ...selected.slice(0, offset)]) {
        const prompt = { systemPrompt: `Synthetic Slack evaluation. Current time: ${new Date(frozenNow).toISOString()}. Conversation: ${entry.conversationKind}. ${scheduleContract.instruction}`,
          messages: [{ role: 'user', content: entry.request, timestamp: frozenNow }], tools: [scheduleContract.tool] };
        const sample = { index: report.samples.length + 1, caseId: entry.id, repetition, configuredModel: name, promptDigest: digest(prompt), request: entry.request, startedAt: new Date().toISOString(), state: 'attempted' };
        report.samples.push(sample); save(); // Preserve interrupted first attempts before transport.
        Object.assign(sample, await sampleScheduleModel(entry, () => models.complete(model, prompt, {
          reasoningEffort: 'medium', maxTokens: 2048, maxRetries: 0, signal: AbortSignal.timeout(60000),
        })), { state: 'finished' });
        save();
      }
    }
  }
  console.log(JSON.stringify({ output, deterministicPassed: deterministic.passed, counts: report.counts, results: deterministic.results }, null, 2));
  process.exitCode = deterministic.passed && report.samples.every((s) => s.passed) ? 0 : 1;
}
