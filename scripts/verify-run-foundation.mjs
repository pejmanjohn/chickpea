#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { REPO_ROOT, assertNodeVersion } from './lib/offline-harness.mjs';

/**
 * U1 proof matrix for the exact Flue/runtime boundary. Later foundation units
 * extend the verifier with storage, lifecycle, privacy, crash, and budget
 * evidence; they must preserve these release decisions unless the pinned
 * runtime contract changes and this matrix is deliberately re-proven.
 */
export const RUN_FOUNDATION_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'direct_submission_receipt',
    status: 'proven',
    evidence: '@flue/sdk AgentSendResult returns a server-generated submissionId and offset.',
    releaseDecision: 'persist_receipt_when_returned',
  }),
  Object.freeze({
    id: 'caller_submission_idempotency',
    status: 'absent',
    evidence: 'AgentPromptOptions has no caller submission id; direct admission generates crypto.randomUUID().',
    releaseDecision: 'do_not_resubmit_after_ambiguous_admission',
  }),
  Object.freeze({
    id: 'same_instance_ordering',
    status: 'proven',
    evidence: 'The exact SQLite submission store exposes only each session head and orders heads by sequence.',
    releaseDecision: 'retain_binding_order_above_flue',
  }),
  Object.freeze({
    id: 'post_admission_lookup',
    status: 'unstable',
    evidence: 'History/observe can find settlement after a known receipt, but no public API discovers a receipt lost before the 202 response.',
    releaseDecision: 'receipt_known_observe_else_recovery_required',
  }),
  Object.freeze({
    id: 'safe_detailed_history',
    status: 'absent',
    evidence: 'The public history projection includes reasoning and dynamic-tool input/output bodies.',
    releaseDecision: 'omit_detailed_flue_activity',
  }),
  Object.freeze({
    id: 'instance_abort',
    status: 'proven',
    evidence: 'The SDK records durable abort intent for all unsettled work on one agent instance.',
    releaseDecision: 'abort_is_control_not_recovery_evidence',
  }),
  Object.freeze({
    id: 'instance_list_delete',
    status: 'absent',
    evidence: 'The public direct-agent SDK exposes prompt/send/wait/abort/history/observe, not instance listing or deletion.',
    releaseDecision: 'retain_opaque_generations_without_cleanup_api',
  }),
  Object.freeze({
    id: 'interactive_execution_descriptor',
    status: 'proven',
    evidence: 'Direct submissions persist traceCarrier and restore it on the outer agent execution interceptor.',
    releaseDecision: 'opaque_trace_key_to_durable_mapping',
  }),
  Object.freeze({
    id: 'workflow_execution_descriptor',
    status: 'proven',
    evidence: 'Workflow input is durable run-scoped data and the runtime exposes the opaque runId to initialization.',
    releaseDecision: 'carry_coordinator_descriptor_in_workflow_input',
  }),
  Object.freeze({
    id: 'tool_action_interception',
    status: 'proven',
    evidence: 'The exact artifact wraps model, MCP, framework, adapter, shell, and action tool execution through FlueExecutionInterceptor.',
    releaseDecision: 'enforce_with_chickpea_interceptor',
  }),
  Object.freeze({
    id: 'finite_action_attempt_ceiling',
    status: 'absent',
    evidence: 'Flue durability bounds attempts and wall time but declares no finite tool/action-call ceiling.',
    releaseDecision: 'disable_side_effects_until_bounded',
  }),
  Object.freeze({
    id: 'node_foreign_keys',
    status: 'proven',
    evidence: 'Node 24 node:sqlite enables foreign keys on the Work ledger connection, rejects orphans, and supports foreign_key_check.',
    releaseDecision: 'check_every_workstore_connection',
  }),
  Object.freeze({
    id: 'workerd_foreign_keys',
    status: 'proven',
    evidence: 'The isolated workerd seam rejects an orphan child row and returns an empty foreign_key_check.',
    releaseDecision: 'verify_on_every_release_artifact',
  }),
  Object.freeze({
    id: 'provider_route_snapshot',
    status: 'proven',
    evidence: 'The active catalog route yields canonical model, lane, source, revision, digest, and compiled profile while internal aliases remain separate.',
    releaseDecision: 'compose_once_before_first_model_call',
  }),
]);

const FOCUSED_TESTS = [
  'tests/flue-run-contract.test.ts',
  'tests/flue-runtime-patch.test.ts',
  'tests/agent-dispatch.test.ts',
  'tests/routine-runtime-seams.test.ts',
  'tests/routine-admission.test.ts',
  'tests/usage/interactive-capture.test.ts',
  'tests/usage/routine-capture.test.ts',
  'tests/openai-subscription-routing.test.ts',
  'tests/model-catalog-routing.test.ts',
  'tests/provider-auth-audit.test.ts',
  'tests/work-store.test.ts',
  'tests/work-retention.test.ts',
  'tests/work-state-rpc.test.ts',
  'tests/routine-store.test.ts',
  'tests/usage-store-contract.test.ts',
];

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status ?? 'unknown'}):\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
}

function printMatrix() {
  console.log('\nrun foundation capability matrix');
  for (const capability of RUN_FOUNDATION_CAPABILITIES) {
    console.log(
      `  [${capability.status}] ${capability.id}: ${capability.releaseDecision}`,
    );
  }
}

async function main() {
  console.log(`run foundation verifier (${assertNodeVersion()})`);
  const matrixOnly = process.argv.includes('--matrix');
  if (!matrixOnly) {
    run('Flue patch verification', process.execPath, ['scripts/patch-flue-runtime.mjs']);
    run('run foundation focused contract tests', process.execPath, [
      '--test',
      '--import',
      'tsx',
      ...FOCUSED_TESTS,
    ]);
    run('isolated workerd contract', process.execPath, [
      'scripts/verify-routines-runtime-spike.mjs',
    ]);
  }
  printMatrix();
  console.log(matrixOnly ? 'run foundation matrix printed' : 'run foundation verifier passed');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
