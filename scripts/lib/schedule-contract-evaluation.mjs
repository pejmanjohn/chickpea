// Synthetic evaluation only. No platform bindings, credentials, stores or tool execution.
import { createRequire } from 'node:module';
import * as v from 'valibot';
import { scheduleActionInputSchema, scheduleActionDescription, slackManagementInstruction, scheduleToolOperation } from '../../src/management/slack-tools.ts';
import { invokeSlackScheduleAction } from '../../src/management/slack-schedule-actions.ts';
import { scheduleActionRpcResult } from '../../src/management/slack-schedule-rpc.ts';
import { ManagementError } from '../../src/management/types.ts';
import { digest } from './verification-inputs.mjs';

// Reuse Flue's installed schema converter, with the same options as its tool path.
const { toJsonSchema } = createRequire(import.meta.resolve('@flue/runtime'))('@valibot/to-json-schema');
const { $schema, ...parameters } = toJsonSchema(scheduleActionInputSchema, { errorMode: 'ignore' });
export const scheduleContract = {
  tool: { name: 'manage_scheduled_work', description: scheduleActionDescription, parameters },
  instruction: slackManagementInstruction('agent_synthetic'),
};
export const scheduleContractDigest = digest(scheduleContract);
export const frozenNow = Date.parse('2030-06-10T12:00:00Z');

export function summarizeModelSamples(samples) {
  return [...new Set(samples.map((s) => s.configuredModel))].map((model) => {
    const selected = samples.filter((s) => s.configuredModel === model);
    const evaluable = selected.filter((s) => s.evaluable);
    const latency = evaluable.map((s) => s.elapsedMs).sort((a, b) => a - b);
    const tokens = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((key) => [key, {
      reported: selected.reduce((sum, s) => sum + (Number.isFinite(s.usage?.[key]) ? s.usage[key] : 0), 0),
      unmeasuredSamples: selected.filter((s) => !Number.isFinite(s.usage?.[key])).length,
    }]));
    const middle = Math.floor(latency.length / 2);
    return { model, attempted: selected.length, evaluable: evaluable.length, passed: selected.filter((s) => s.passed).length,
      transportFailures: selected.filter((s) => s.category === 'transport').length,
      unfinished: selected.filter((s) => s.state !== 'finished').length,
      evaluableLatencyMs: { count: latency.length, median: latency.length ? (latency[middle] + latency[Math.floor((latency.length - 1) / 2)]) / 2 : null, max: latency.at(-1) ?? null }, tokens };
  });
}

export async function evaluateScheduleArguments(entry, args) {
  const result = { schema: 'not_run', admission: 'not_run', persistence: 'not_run', dueDelivery: 'not_run' };
  const parsed = v.safeParse(scheduleActionInputSchema, args);
  if (!parsed.success) return { ...result, schema: 'rejected', branch: 'tool_schema' };
  result.schema = 'accepted';
  const signal = { agentId: 'agent_synthetic', workspaceId: 'T_SYNTHETIC', channelId: entry.conversationKind === 'im' ? 'D_SYNTHETIC' : 'C_SYNTHETIC',
    conversationKind: entry.conversationKind, threadTs: '1907323200.000001', messageTs: '1907323200.000001', slackUserId: 'U_SYNTHETIC', eventId: 'Ev_synthetic', turnJobId: 'turn_synthetic', requesterText: entry.request };
  let stage = 'converter', admitted;
  const stop = new Error('evaluation_before_reservation');
  const forbidden = new Proxy({}, { get(_target, property) { throw new Error(`Evaluation attempted unavailable dependency: ${String(property)}`); } });
  try {
    const operation = scheduleToolOperation(signal, parsed.output);
    stage = 'pre_admission';
    const typedResult = await scheduleActionRpcResult(() => invokeSlackScheduleAction({ signal,
      context: { organizationId: 'org_synthetic', userId: 'user_synthetic', membershipId: 'member_synthetic', origin: { kind: 'slack', ...signal } }, operation,
      dependencies: { now: () => frozenNow, service: forbidden,
        routines: new Proxy({ getRoutine: async () => undefined, listRoutines: async () => [] }, { get(target, key) { return key in target ? target[key] : forbidden[key]; } }),
        management: new Proxy({ reserveRequest: async (input) => { admitted = input.operations[0]; throw stop; } }, { get(target, key) { return key in target ? target[key] : forbidden[key]; } }),
      },
    }));
    if (typedResult.outcome !== 'failed') throw new Error('Unexpected completion beyond admission');
    return { ...result, admission: 'rejected', branch: stage, typedResult };
  } catch (error) {
    if (error === stop) return { ...result, admission: 'accepted', branch: 'before_reservation', operation: admitted };
    if (error instanceof ManagementError) return { ...result, admission: 'rejected', branch: stage, typedResult: { outcome: 'failed', code: error.code, message: error.message } };
    throw error; // Infrastructure/programming failures never count as expected rejection.
  }
}

export async function deterministicScheduleEvaluation(corpus) {
  const results = [];
  for (const entry of corpus.cases) for (const variant of entry.variants) {
    const result = await evaluateScheduleArguments(entry, { ...entry.arguments, ...variant.arguments });
    results.push({ caseId: entry.id, variant: variant.id, ...result,
      passed: result.schema === (variant.schema ?? 'accepted') && result.admission === variant.admission
        && (!variant.message || result.typedResult?.message === variant.message) });
  }
  return { contractDigest: scheduleContractDigest, frozenNow, results, passed: results.every((r) => r.passed) };
}

export async function sampleScheduleModel(entry, complete) {
  const started = performance.now();
  let response;
  try { response = await complete(); }
  catch (error) { return { evaluable: false, category: 'transport', errorName: error.name, elapsedMs: performance.now() - started }; }
  const elapsedMs = performance.now() - started;
  const identity = { adapterReportedModel: response.model ?? null, routedModel: null };
  if (['error', 'aborted'].includes(response.stopReason) || !Array.isArray(response.content)) return { ...identity, elapsedMs, evaluable: false, category: 'transport', stopReason: response.stopReason, usage: response.usage ?? null };
  const calls = response.content.filter((part) => part.type === 'toolCall');
  const evaluated = [];
  for (const call of calls) evaluated.push({ name: call.name, arguments: call.arguments,
    result: call.name === scheduleContract.tool.name ? await evaluateScheduleArguments(entry, call.arguments) : null });
  return { ...identity, elapsedMs, evaluable: true, category: 'model', stopReason: response.stopReason, usage: response.usage ?? null,
    calls: evaluated, passed: evaluated.length === 1 && evaluated[0].result?.admission === 'accepted' };
}
