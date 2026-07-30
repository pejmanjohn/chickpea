import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  AgentPromptOptions,
  AgentSendResult,
  FlueClient,
  FlueConversationPart,
} from '@flue/sdk';

import { resolveActiveCatalogRoute } from '../src/model-catalog/catalog.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
// The verifier stays directly executable JavaScript; this test pins its small
// exported matrix to an explicit compile-time shape.
// @ts-expect-error The executable .mjs intentionally has no declaration file.
import { RUN_FOUNDATION_CAPABILITIES as RAW_CAPABILITIES } from '../scripts/verify-run-foundation.mjs';

interface RunFoundationCapability {
  id: string;
  status: 'proven' | 'absent' | 'unstable';
  evidence: string;
  releaseDecision: string;
}

const RUN_FOUNDATION_CAPABILITIES =
  RAW_CAPABILITIES as readonly RunFoundationCapability[];

type PromptAcceptsCallerSubmissionId =
  'submissionId' extends keyof AgentPromptOptions ? true : false;
type SendReturnsSubmissionId =
  'submissionId' extends keyof AgentSendResult ? true : false;
type ClientCanLookupSubmission =
  'getSubmission' extends keyof FlueClient['agents'] ? true : false;
type ClientCanAbortSubmission =
  'abortSubmission' extends keyof FlueClient['agents'] ? true : false;
type HistoryIncludesReasoning =
  Extract<FlueConversationPart, { type: 'reasoning' }> extends never ? false : true;
type HistoryIncludesToolBodies =
  Extract<FlueConversationPart, { type: 'dynamic-tool' }> extends never ? false : true;

const PROMPT_ACCEPTS_CALLER_SUBMISSION_ID: PromptAcceptsCallerSubmissionId = false;
const SEND_RETURNS_SUBMISSION_ID: SendReturnsSubmissionId = true;
const CLIENT_CAN_LOOKUP_SUBMISSION: ClientCanLookupSubmission = false;
const CLIENT_CAN_ABORT_SUBMISSION: ClientCanAbortSubmission = false;
const HISTORY_INCLUDES_REASONING: HistoryIncludesReasoning = true;
const HISTORY_INCLUDES_TOOL_BODIES: HistoryIncludesToolBodies = true;

const FLUE_ROOT = fileURLToPath(new URL('../node_modules/@flue/runtime/', import.meta.url));
const FLUE_DIST = fileURLToPath(new URL('../node_modules/@flue/runtime/dist/', import.meta.url));

async function readDistPrefix(prefix: string): Promise<string> {
  const matches = (await readdir(FLUE_DIST)).filter((name) =>
    name.startsWith(prefix) && name.endsWith('.mjs'),
  );
  assert.equal(matches.length, 1, `expected one compiled Flue ${prefix} module`);
  return readFile(`${FLUE_DIST}${matches[0]}`, 'utf8');
}

test('the pinned Flue client exposes a receipt but no caller-owned direct idempotency key', async () => {
  const packageJson = JSON.parse(
    await readFile(`${FLUE_ROOT}package.json`, 'utf8'),
  ) as { version?: unknown };

  assert.equal(packageJson.version, '1.0.0-beta.8');
  assert.equal(PROMPT_ACCEPTS_CALLER_SUBMISSION_ID, false);
  assert.equal(SEND_RETURNS_SUBMISSION_ID, true);
  assert.equal(CLIENT_CAN_LOOKUP_SUBMISSION, false);
  assert.equal(CLIENT_CAN_ABORT_SUBMISSION, false);

  const runtime = await readDistPrefix('conversation-stream-store-');
  const directInput = runtime.slice(
    runtime.indexOf('function createDirectAgentSubmissionInput'),
    runtime.indexOf('async function materializeAgentSubmissionSession'),
  );
  assert.match(directInput, /submissionId: crypto\.randomUUID\(\)/);
  assert.match(directInput, /traceCarrier/);
});

test('same-instance submissions are ordered, but receipt loss remains application-ambiguous', async () => {
  const store = await readDistPrefix('sql-run-store-');

  assert.match(store, /earlier\.session_key = current\.session_key/);
  assert.match(store, /earlier\.sequence < current\.sequence/);
  assert.match(store, /ORDER BY current\.sequence ASC/);
  assert.match(store, /Idempotent admission keyed by dispatch id|admitDispatch/);

  const directCapability = RUN_FOUNDATION_CAPABILITIES.find(
    (capability) => capability.id === 'caller_submission_idempotency',
  );
  assert.deepEqual(
    directCapability && {
      status: directCapability.status,
      releaseDecision: directCapability.releaseDecision,
    },
    {
      status: 'absent',
      releaseDecision: 'do_not_resubmit_after_ambiguous_admission',
    },
  );
});

test('Flue history is stable but not a safe Sessions detail projection', () => {
  assert.equal(HISTORY_INCLUDES_REASONING, true);
  assert.equal(HISTORY_INCLUDES_TOOL_BODIES, true);

  const capability = RUN_FOUNDATION_CAPABILITIES.find(
    (candidate) => candidate.id === 'safe_detailed_history',
  );
  assert.equal(capability?.status, 'absent');
  assert.equal(capability?.releaseDecision, 'omit_detailed_flue_activity');
});

test('the exact patched artifact wraps model tools with a pre/post execution interceptor', async () => {
  const runtime = await readDistPrefix('conversation-stream-store-');
  const wrapper = runtime.slice(
    runtime.indexOf('wrapModelTool(tool'),
    runtime.indexOf('createCustomTools(tools)'),
  );
  const start = wrapper.indexOf('type: "tool_start"');
  const intercept = wrapper.indexOf('const result = await interceptExecution({');
  const underlyingCall = wrapper.indexOf('}, this.executionContext(), prepared.run)');

  assert.ok(start >= 0, 'tool start is observable before execution');
  assert.ok(intercept > start, 'the execution interceptor runs after tool start');
  assert.ok(underlyingCall > intercept, 'the interceptor owns the underlying tool call');

  const capability = RUN_FOUNDATION_CAPABILITIES.find(
    (candidate) => candidate.id === 'tool_action_interception',
  );
  assert.equal(capability?.status, 'proven');
  assert.equal(capability?.releaseDecision, 'enforce_with_chickpea_interceptor');
});

test('Flue has no finite tool-attempt ceiling, so side effects stay disabled until Chickpea supplies one', async () => {
  const types = await readFile(`${FLUE_DIST}types-USSZhfC6.d.mts`, 'utf8');
  const durability = types.slice(
    types.indexOf('interface DurabilityConfig'),
    types.indexOf('interface AgentConfig'),
  );

  assert.match(durability, /maxAttempts\?: number/);
  assert.match(durability, /timeoutMs\?: number/);
  assert.doesNotMatch(durability, /maxTool|maxAction|maxTurn/i);

  const capability = RUN_FOUNDATION_CAPABILITIES.find(
    (candidate) => candidate.id === 'finite_action_attempt_ceiling',
  );
  assert.equal(capability?.status, 'absent');
  assert.equal(capability?.releaseDecision, 'disable_side_effects_until_bounded');
});

test('trace carrier survives into execution context for model-boundary invocation evidence', async () => {
  const runtime = await readDistPrefix('conversation-stream-store-');
  const execution = runtime.slice(
    runtime.indexOf('const run = () => interceptExecution({'),
    runtime.indexOf('result = opts.wrapExecution'),
  );

  assert.match(execution, /submissionId: submission\.submissionId/);
  assert.match(execution, /traceCarrier: input\.traceCarrier/);

  const capability = RUN_FOUNDATION_CAPABILITIES.find(
    (candidate) => candidate.id === 'interactive_execution_descriptor',
  );
  assert.equal(capability?.status, 'proven');
  assert.equal(capability?.releaseDecision, 'mark_after_agent_policy_before_provider');
});

test('catalog routing can derive an immutable allowlisted attempt snapshot without internal aliases', () => {
  const route = resolveActiveCatalogRoute(
    'openai/gpt-5.6-sol',
    'openai_subscription',
  );
  assert.ok(route);
  const entry = route.snapshot.entries.find((candidate) =>
    candidate.id === route.canonicalModel,
  );
  const safeEvidence = Object.freeze({
    canonicalModel: route.canonicalModel,
    providerAuthRoute: route.lane,
    catalogSource: route.snapshot.source,
    catalogRevision: route.snapshot.revision,
    catalogDigest: route.snapshot.sha256,
    compiledProfile: entry?.lanes[route.lane] ?? null,
  });

  assert.equal(Object.isFrozen(safeEvidence), true);
  assert.equal(safeEvidence.canonicalModel, 'openai/gpt-5.6-sol');
  assert.equal(safeEvidence.providerAuthRoute, 'openai_subscription');
  assert.ok(safeEvidence.compiledProfile);
  assert.doesNotMatch(
    JSON.stringify(safeEvidence),
    /chickpea-openai-subscription|transport|token|account|apiKey/i,
  );
  assert.ok(
    route.modelSpecifier !== safeEvidence.canonicalModel,
    'the internal transport alias is deliberately excluded from product evidence',
  );
});

test('Node 24 SQLite enforces foreign keys for the Work ledger connection', () => {
  const db = openStateDb(':memory:');
  try {
    assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
    db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE child (parent_id TEXT REFERENCES parent(id))');
    assert.throws(
      () => db.run('INSERT INTO child (parent_id) VALUES (?)', 'missing'),
      /FOREIGN KEY constraint failed/,
    );
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('the proof matrix has one explicit release decision for every runtime dependency', () => {
  const ids = RUN_FOUNDATION_CAPABILITIES.map((capability) => capability.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    'direct_submission_receipt',
    'caller_submission_idempotency',
    'same_instance_ordering',
    'post_admission_lookup',
    'safe_detailed_history',
    'instance_abort',
    'instance_list_delete',
    'interactive_execution_descriptor',
    'workflow_execution_descriptor',
    'tool_action_interception',
    'finite_action_attempt_ceiling',
    'node_foreign_keys',
    'workerd_foreign_keys',
    'provider_route_snapshot',
    'non_slack_adapter_conformance',
    'interactive_ledger_authority',
  ]);
  for (const capability of RUN_FOUNDATION_CAPABILITIES) {
    assert.match(capability.status, /^(proven|absent|unstable|canary_only)$/);
    assert.ok(capability.evidence.length > 0, capability.id);
    assert.ok(capability.releaseDecision.length > 0, capability.id);
  }
});
