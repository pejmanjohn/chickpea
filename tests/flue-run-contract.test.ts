import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  AgentDispatchRequest,
  AgentInstanceHandle,
  AgentReadOptions,
  AgentReply,
  ConversationStreamChunk,
  DispatchReceipt,
} from '@flue/runtime';

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

type DispatchAcceptsIdempotencyKey =
  'idempotencyKey' extends keyof AgentDispatchRequest ? true : false;
type ReceiptReturnsSubmissionId =
  'submissionId' extends keyof DispatchReceipt ? true : false;
type ReceiptMarksDeduplication =
  'deduplicated' extends keyof DispatchReceipt ? true : false;
type HandleCanRead = 'read' extends keyof AgentInstanceHandle ? true : false;
type HandleCanAbort = 'abort' extends keyof AgentInstanceHandle ? true : false;
type HandleHasHistory = 'history' extends keyof AgentInstanceHandle ? true : false;
type ReplyHasNamedData = 'data' extends keyof AgentReply ? true : false;
type ReadHasEventCallback = 'onEvent' extends keyof AgentReadOptions ? true : false;
type ReadHasLocalSignal = 'signal' extends keyof AgentReadOptions ? true : false;
type EventCallbackReturnsVoid = ReturnType<
  NonNullable<AgentReadOptions['onEvent']>
> extends void ? true : false;
type ChunkHasDurablePosition = ConversationStreamChunk['position'] extends {
  batch: number;
  index: number;
} ? true : false;
type DeltaKinds = Extract<ConversationStreamChunk, { type: 'message-delta' }>['kind'];
type ChunkHasNoDirectSubagentEvent = Extract<
  ConversationStreamChunk,
  { type: 'subagent-started' }
> extends never ? true : false;
type AbortArgumentCount = Parameters<AgentInstanceHandle['abort']>['length'];

const DISPATCH_ACCEPTS_IDEMPOTENCY_KEY: DispatchAcceptsIdempotencyKey = true;
const RECEIPT_RETURNS_SUBMISSION_ID: ReceiptReturnsSubmissionId = true;
const RECEIPT_MARKS_DEDUPLICATION: ReceiptMarksDeduplication = true;
const HANDLE_CAN_READ: HandleCanRead = true;
const HANDLE_CAN_ABORT: HandleCanAbort = true;
const HANDLE_HAS_HISTORY: HandleHasHistory = false;
const REPLY_HAS_NAMED_DATA: ReplyHasNamedData = true;
const READ_HAS_EVENT_CALLBACK: ReadHasEventCallback = true;
const READ_HAS_LOCAL_SIGNAL: ReadHasLocalSignal = true;
const EVENT_CALLBACK_RETURNS_VOID: EventCallbackReturnsVoid = true;
const CHUNK_HAS_DURABLE_POSITION: ChunkHasDurablePosition = true;
const DELTA_KINDS: ReadonlySet<DeltaKinds> = new Set(['text', 'reasoning']);
const CHUNK_HAS_NO_DIRECT_SUBAGENT_EVENT: ChunkHasNoDirectSubagentEvent = true;
const ABORT_ARGUMENT_COUNT: AbortArgumentCount = 0;

const FLUE_ROOT = fileURLToPath(new URL('../node_modules/@flue/runtime/', import.meta.url));
const FLUE_DIST = fileURLToPath(new URL('../node_modules/@flue/runtime/dist/', import.meta.url));

async function readDistPrefix(prefix: string): Promise<string> {
  const matches = (await readdir(FLUE_DIST)).filter((name) =>
    name.startsWith(prefix) && name.endsWith('.mjs'),
  );
  assert.equal(matches.length, 1, `expected one compiled Flue ${prefix} module`);
  return readFile(`${FLUE_DIST}${matches[0]}`, 'utf8');
}

async function readDistContaining(needle: string): Promise<string> {
  const files = (await readdir(FLUE_DIST)).filter((name) => name.endsWith('.mjs'));
  const matches: string[] = [];
  for (const name of files) {
    const source = await readFile(`${FLUE_DIST}${name}`, 'utf8');
    if (source.includes(needle)) matches.push(source);
  }
  assert.ok(matches.length >= 1, `expected compiled Flue source containing ${needle}`);
  return matches[0]!;
}

async function readDistDeclarationContaining(needle: string): Promise<string> {
  const files = (await readdir(FLUE_DIST)).filter((name) => name.endsWith('.d.mts'));
  for (const name of files) {
    const source = await readFile(`${FLUE_DIST}${name}`, 'utf8');
    if (source.includes(needle)) return source;
  }
  assert.fail(`expected compiled Flue declaration containing ${needle}`);
}

test('the pinned Flue 2 handle exposes keyed admission, receipts, and reattachable reads', async () => {
  const packageJson = JSON.parse(
    await readFile(`${FLUE_ROOT}package.json`, 'utf8'),
  ) as { version?: unknown };

  assert.equal(packageJson.version, '2.0.0');
  assert.equal(DISPATCH_ACCEPTS_IDEMPOTENCY_KEY, true);
  assert.equal(RECEIPT_RETURNS_SUBMISSION_ID, true);
  assert.equal(RECEIPT_MARKS_DEDUPLICATION, true);
  assert.equal(HANDLE_CAN_READ, true);
  assert.equal(HANDLE_CAN_ABORT, true);
  assert.equal(READ_HAS_EVENT_CALLBACK, true);
  assert.equal(READ_HAS_LOCAL_SIGNAL, true);
  assert.equal(EVENT_CALLBACK_RETURNS_VOID, true);
  assert.equal(CHUNK_HAS_DURABLE_POSITION, true);
  assert.deepEqual([...DELTA_KINDS], ['text', 'reasoning']);
  assert.equal(CHUNK_HAS_NO_DIRECT_SUBAGENT_EVENT, true);
  assert.equal(ABORT_ARGUMENT_COUNT, 0, 'abort remains instance-wide, not receipt-scoped');

  const runtime = await readDistContaining('async function adoptKeyedSubmissionReplay');
  const directInput = runtime.slice(
    runtime.indexOf('function createDirectAgentSubmissionInput'),
    runtime.indexOf('function isInstanceContactRejection'),
  );
  assert.match(directInput, /deriveKeyedSubmissionId/);
  assert.match(runtime, /deep-equal `message`/);
  assert.match(await readDistContaining('deduplicated: true'), /deduplicated: true/);
});

test('same-instance submissions are ordered and exact keyed replay recovers receipt loss', async () => {
  const store = await readDistPrefix('sql-agent-execution-store-');

  assert.match(store, /earlier\.session_key = current\.session_key/);
  assert.match(store, /earlier\.sequence < current\.sequence/);
  assert.match(store, /ORDER BY current\.sequence ASC/);

  const directCapability = RUN_FOUNDATION_CAPABILITIES.find(
    (capability) => capability.id === 'caller_submission_idempotency',
  );
  assert.deepEqual(
    directCapability && {
      status: directCapability.status,
      releaseDecision: directCapability.releaseDecision,
    },
    {
      status: 'proven',
      releaseDecision: 'redispatch_identical_key_after_ambiguous_admission',
    },
  );
});

test('Flue replies expose named data but no public detailed-history projection', () => {
  assert.equal(REPLY_HAS_NAMED_DATA, true);
  assert.equal(HANDLE_HAS_HISTORY, false);

  const capability = RUN_FOUNDATION_CAPABILITIES.find(
    (candidate) => candidate.id === 'safe_detailed_history',
  );
  assert.equal(capability?.status, 'absent');
  assert.equal(capability?.releaseDecision, 'omit_detailed_flue_activity');
});

test('the exact patched artifact wraps model tools with a pre/post execution interceptor', async () => {
  const runtime = await readDistContaining('wrapModelTool(tool');
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

test('Flue bounds submission attempts but not model-selected tool calls', async () => {
  const types = await readDistDeclarationContaining('interface DurabilityConfig');
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

test('instrumentation supplies model-invisible instance and submission coordinates', async () => {
  const runtime = await readDistContaining('const run = () => interceptExecution({');
  const execution = runtime.slice(
    runtime.indexOf('const run = () => interceptExecution({'),
    runtime.indexOf('result = opts.wrapExecution'),
  );

  assert.match(execution, /instanceId: input\.id/);
  assert.match(execution, /submissionId: submission\.submissionId/);

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
