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
    evidence: '@flue/runtime dispatch() returns a durable DispatchReceipt with submissionId, acceptedAt, and uid.',
    releaseDecision: 'persist_receipt_when_returned',
  }),
  Object.freeze({
    id: 'caller_submission_idempotency',
    status: 'proven',
    evidence: 'AgentDispatchRequest accepts an idempotencyKey and exact keyed replays adopt the original submission.',
    releaseDecision: 'redispatch_identical_key_after_ambiguous_admission',
  }),
  Object.freeze({
    id: 'same_instance_ordering',
    status: 'proven',
    evidence: 'The exact SQLite submission store exposes only each session head and orders heads by sequence.',
    releaseDecision: 'retain_binding_order_above_flue',
  }),
  Object.freeze({
    id: 'post_admission_lookup',
    status: 'proven',
    evidence: 'A keyed replay recovers a lost receipt; AgentInstanceHandle.read() reattaches from any process after receipt persistence.',
    releaseDecision: 'recover_receipt_then_reattach_read',
  }),
  Object.freeze({
    id: 'safe_detailed_history',
    status: 'absent',
    evidence: 'AgentInstanceHandle exposes dispatch, read, and abort but no public detailed-history projection.',
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
    evidence: 'Flue instrumentation supplies instanceId and submissionId; Chickpea matches them to model-invisible TurnJob state before marking invocation.',
    releaseDecision: 'mark_after_agent_policy_before_provider',
  }),
  Object.freeze({
    id: 'workflow_execution_descriptor',
    status: 'absent',
    evidence: 'Flue 2 removes workflows; Chickpea occurrence state owns routine scheduling, checkpoints, and correlation.',
    releaseDecision: 'keep_routine_occurrence_authority_in_chickpea',
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
  Object.freeze({
    id: 'non_slack_adapter_conformance',
    status: 'proven',
    evidence: 'The conformance adapter admits, executes, renders, delivers, and recovers without Slack types or coordinates.',
    releaseDecision: 'reuse_submit_run_and_persisted_output_boundary',
  }),
  Object.freeze({
    id: 'interactive_ledger_authority',
    status: 'canary_only',
    evidence: 'The exact-channel selector assigns immutable authority and the durable driver fences execution and payload redelivery.',
    releaseDecision: 'default_empty_and_promote_by_evidence',
  }),
]);

const FOCUSED_TESTS = [
  'tests/flue-run-contract.test.ts',
  'tests/flue-v2-runtime-regressions.test.ts',
  'tests/agent-dispatch.test.ts',
  'tests/routine-runtime-seams.test.ts',
  'tests/routine-admission.test.ts',
  'tests/usage/interactive-capture.test.ts',
  'tests/usage/routine-capture.test.ts',
  'tests/openai-subscription-routing.test.ts',
  'tests/model-catalog-routing.test.ts',
  'tests/provider-auth-audit.test.ts',
  'tests/runtime-model-route-evidence.test.ts',
  'tests/execution-authority.test.ts',
  'tests/submit-run.test.ts',
  'tests/work-store.test.ts',
  'tests/work-retention.test.ts',
  'tests/work-state-rpc.test.ts',
  'tests/work-admission.test.ts',
  'tests/work-lifecycle.test.ts',
  'tests/run-driver.test.ts',
  'tests/run-ordering.test.ts',
  'tests/run-recovery.test.ts',
  'tests/node-turn-relay.test.ts',
  'tests/work-model-invocation.test.ts',
  'tests/non-slack-adapter-contract.test.ts',
  'tests/turn-jobs.test.ts',
  'tests/status-relay.test.ts',
  'tests/slack-thread-context.test.ts',
  'tests/web-client-presenter.test.ts',
  'tests/routine-store.test.ts',
  'tests/usage-store-contract.test.ts',
  'tests/admin-work-routes.test.ts',
  'tests/admin-scheduled-work-routes.test.ts',
  'tests/admin-usage-routes.test.ts',
  'tests/deploy-with-epilogue.test.ts',
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
    run('run foundation focused contract tests', process.execPath, [
      '--test',
      '--import',
      'tsx',
      ...FOCUSED_TESTS,
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
