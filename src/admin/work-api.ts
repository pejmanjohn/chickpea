import { createHash } from 'node:crypto';

import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import type { AuditEvent } from '../audit/types.ts';
import { requestPrincipal } from '../auth/service.ts';
import type { UsageOperationDetail, UsageStore } from '../usage/types.ts';
import {
  WorkStateError,
  type BindingId,
  type BindingRecord,
  type LedgerContentRef,
  type ListWorkRunsInput,
  type RunExecutionRecord,
  type RunId,
  type RunRecord,
  type WorkId,
  type WorkRecord,
  type WorkRunListItem,
  type WorkStore,
} from '../work/types.ts';

interface WorkAdminApiOptions {
  store: (c: Context) => WorkStore;
  usage?: (c: Context) => UsageStore;
  now?: () => number;
}

const runIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{7,127}$/));
const quarantineSchema = v.strictObject({
  confirm: v.literal(true),
  operatorLabel: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(80),
    v.regex(/^[^\u0000-\u001f\u007f]+$/),
  ),
  safeReasonCode: v.picklist([
    'effect_reconciled_externally',
    'delivery_reconciled_externally',
    'accepted_unknown',
  ]),
});
// Runtime ceilings allow 15-minute turns. Keep a full ceiling of margin so a
// lease-free legacy Run cannot become retire-eligible while still in budget.
const STALE_RUN_RETIRE_AFTER_MS = 30 * 60_000;

export function createWorkAdminApi(options: WorkAdminApiOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/sessions', async (c) => {
    try {
      const store = options.store(c);
      const page = await store.listRuns(parseListInput(c));
      return c.json({
        items: page.items.map(sessionSummary),
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      });
    } catch (error) {
      return workError(c, error);
    }
  });

  app.get('/sessions/:runId', async (c) => {
    try {
      const runId = parseRunId(c.req.param('runId'));
      const store = options.store(c);
      const run = await store.getRun(runId);
      if (!run) return c.json({ error: 'session_not_found' }, 404);
      const [work, binding, executions, events, config, usage] = await Promise.all([
        store.getWork(run.workId),
        store.getBinding(run.bindingId),
        store.listRunExecutions(run.id, 100),
        store.listAuditEvents(run.id, 500),
        store.getConfigRevision(run.configRevisionId),
        options.usage?.(c).getOperationByRunId(run.id),
      ]);
      if (!work || !binding || binding.workId !== work.id || run.workId !== work.id) {
        return c.json({ error: 'session_integrity_failed' }, 409);
      }
      if (!matchesDeepLink(c, work, binding)) {
        return c.json({ error: 'session_deep_link_mismatch' }, 409);
      }
      const context = { work, binding, run, executions, events, config, usage };
      if (binding.sourceVisibility !== 'public' || work.maximumSensitivity !== 'public') {
        return c.json(redactedSessionDetail(context));
      }
      return c.json(await publicSessionDetail(store, context, now()));
    } catch (error) {
      return workError(c, error);
    }
  });

  app.post('/sessions/:runId/quarantine', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(quarantineSchema, await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const runId = parseRunId(c.req.param('runId'));
      const credential = adminCredential(c);
      const requestId = `request_${sha256(`quarantine\0${idempotencyKey}`).slice(0, 32)}`;
      const run = await options.store(c).quarantineRun({
        runId,
        adminCredentialId: credential.id,
        operatorLabel: parsed.output.operatorLabel,
        authOrigin: credential.origin,
        safeReasonCode: parsed.output.safeReasonCode,
        requestId,
        idempotencyKey: `admin:session:quarantine:${idempotencyKey}`,
        resolvedAt: now(),
      });
      return c.json({
        runId: run.id,
        status: run.status,
        terminalDisposition: run.terminalDisposition,
        recovery: recoveryProjection(run),
        attribution: 'The operator label is claimed; the credential ID identifies the shared admin credential.',
      });
    } catch (error) {
      return workError(c, error);
    }
  });

  app.post('/sessions/:runId/retire-stale', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(quarantineSchema, await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const runId = parseRunId(c.req.param('runId'));
      const store = options.store(c);
      const run = await store.getRun(runId);
      if (!run) return c.json({ error: 'session_not_found' }, 404);

      const retiredAt = now();
      const identity = sha256(`retire-stale\0${idempotencyKey}`).slice(0, 32);
      if (run.status !== 'settled') {
        const resumesPartialRetirement =
          run.status === 'recovery_required' &&
          run.safeFailureCode === 'operator_retired_stale_run';
        if (run.status !== 'executing' && !resumesPartialRetirement) {
          return c.json({ error: 'session_not_executing' }, 409);
        }
        if (!resumesPartialRetirement) {
          if (
            retiredAt - run.updatedAt < STALE_RUN_RETIRE_AFTER_MS ||
            (run.leaseUntil !== null && run.leaseUntil >= retiredAt)
          ) {
            return c.json({ error: 'session_not_stale' }, 409);
          }
          await store.requireRecovery({
            runId,
            safeFailureCode: 'operator_retired_stale_run',
            at: retiredAt,
            auditEventId: `work:recovery:admin-retire:${identity}`,
            auditIdempotencyKey: `work:recovery:admin-retire:${identity}`,
          });
        }
      }

      const credential = adminCredential(c);
      const retired = await store.quarantineRun({
        runId,
        adminCredentialId: credential.id,
        operatorLabel: parsed.output.operatorLabel,
        authOrigin: credential.origin,
        safeReasonCode: parsed.output.safeReasonCode,
        requestId: `request_retire_${identity}`,
        idempotencyKey: `work:quarantine:admin-retire:${identity}`,
        resolvedAt: retiredAt,
      });
      return c.json({
        runId: retired.id,
        status: retired.status,
        terminalDisposition: retired.terminalDisposition,
        recovery: recoveryProjection(retired),
        attribution: 'The operator label is claimed; the credential ID identifies the shared admin credential.',
      });
    } catch (error) {
      return workError(c, error);
    }
  });

  return app;
}

interface SessionContext {
  work: WorkRecord;
  binding: BindingRecord;
  run: RunRecord;
  executions: RunExecutionRecord[];
  events: AuditEvent[];
  config: Awaited<ReturnType<WorkStore['getConfigRevision']>>;
  usage: UsageOperationDetail | undefined;
}

function sessionSummary(item: WorkRunListItem): Record<string, unknown> {
  const contentAccess = item.binding.sourceVisibility === 'public' &&
      item.work.maximumSensitivity === 'public'
    ? 'public'
    : item.binding.sourceVisibility === 'unknown'
      ? 'authorization_unknown'
      : 'private';
  return {
    runId: item.run.id,
    workId: item.work.id,
    bindingId: item.binding.id,
    bindingGeneration: item.binding.generation,
    adapterKind: item.binding.adapterKind,
    kind: item.run.kind,
    triggerKind: item.run.triggerKind,
    status: item.run.status,
    terminalDisposition: item.run.terminalDisposition,
    deliveryStatus: item.run.deliveryStatus,
    safeFailureCode: item.run.safeFailureCode,
    contentAccess,
    createdAt: item.run.createdAt,
    updatedAt: item.run.updatedAt,
    settledAt: item.run.settledAt,
  };
}

function commonSessionDetail(context: SessionContext): Record<string, unknown> {
  const events = chronologicalEvents(context.events);
  return {
    session: {
      ...sessionSummary(context),
      admissionSequence: context.run.admissionSequence,
      actorTrustTier: context.run.actorTrustTier,
      sourceContextWatermark: context.run.sourceContextWatermark,
      executionAuthority: context.run.executionAuthority,
      coordinatorKind: context.run.coordinatorKind,
      authorityEpoch: context.run.authorityEpoch,
      deliveryMethod: context.run.deliveryMethod,
      deliveryAttemptId: context.run.deliveryAttemptId,
      deliveryRef: context.run.deliveryRef,
      deliveryFinalizedAt: context.run.deliveryFinalizedAt,
      configRevisionId: context.run.configRevisionId,
      effectiveCapabilityDigest: context.run.effectiveCapabilityDigest,
    },
    work: {
      id: context.work.id,
      kind: context.work.kind,
      lifecycle: context.work.lifecycle,
      createdAt: context.work.createdAt,
      updatedAt: context.work.updatedAt,
    },
    binding: {
      id: context.binding.id,
      workId: context.binding.workId,
      adapterKind: context.binding.adapterKind,
      externalAccountId: context.binding.externalAccountId,
      externalConversationId: context.binding.externalConversationId,
      generation: context.binding.generation,
      lifecycle: context.binding.lifecycle,
      sourceVisibility: context.binding.sourceVisibility,
      configMode: context.binding.configMode,
      createdAt: context.binding.createdAt,
      expiredAt: context.binding.expiredAt,
    },
    executions: context.executions.map(safeExecution),
    timeline: events,
    actionIntegrity: actionIntegrity(events),
    config: context.config
      ? {
          revisionId: context.config.id,
          digest: context.config.digest,
          schemaVersion: context.config.schemaVersion,
          createdAt: context.config.createdAt,
        }
      : { revisionId: context.run.configRevisionId, state: 'unavailable' },
    usage: safeUsageCoverage(context.usage),
    recovery: recoveryProjection(context.run),
  };
}

function redactedSessionDetail(context: SessionContext): Record<string, unknown> {
  const access = context.binding.sourceVisibility === 'unknown'
    ? 'authorization_unknown'
    : 'private';
  return {
    projection: 'redacted',
    content: {
      state: access,
      message: access === 'private'
        ? 'Content is private and is not available in Sessions.'
        : 'Content authorization is unknown, so Sessions fails closed.',
    },
    ...commonSessionDetail(context),
  };
}

async function publicSessionDetail(
  store: WorkStore,
  context: SessionContext,
  at: number,
): Promise<Record<string, unknown>> {
  const [trigger, preparedInput, approvedOutput, renderedPayload] = await Promise.all([
    publicContent(store, context.run.triggerContentRef, at),
    publicContent(store, context.run.preparedInputRef, at),
    publicContent(store, context.run.policyApprovedOutputRef, at),
    publicContent(store, context.run.renderedPayloadRef, at),
  ]);
  return {
    projection: 'public',
    content: { trigger, preparedInput, approvedOutput, renderedPayload },
    ...commonSessionDetail(context),
  };
}

async function publicContent(
  store: WorkStore,
  ref: LedgerContentRef | null,
  at: number,
): Promise<Record<string, unknown>> {
  if (!ref) return { state: 'not_retained' };
  const content = await store.getContent(ref, at);
  if (!content) return { state: 'expired' };
  if (content.sensitivity !== 'public') return { state: 'private' };
  return {
    state: 'available',
    body: content.body,
    createdAt: content.createdAt,
    expiresAt: content.expiresAt,
    byteSize: content.byteSize,
  };
}

function safeExecution(execution: RunExecutionRecord): Record<string, unknown> {
  return {
    id: execution.id,
    attemptNumber: execution.attemptNumber,
    executorKind: execution.executorKind,
    agentId: execution.agentName,
    canonicalModel: execution.canonicalModel,
    providerAuthRoute: execution.providerAuthRoute,
    catalogSource: execution.catalogSource,
    catalogRevision: execution.catalogRevision,
    catalogDigest: execution.catalogDigest,
    compiledProfile: execution.compiledProfile,
    modelInvocationStatus: execution.modelInvocationStatus,
    outcome: execution.outcome,
    safeDisagreementCode: execution.safeDisagreementCode,
    safeFailureCode: execution.safeFailureCode,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
  };
}

function chronologicalEvents(events: AuditEvent[]): Record<string, unknown>[] {
  return [...events]
    .sort((left, right) => left.createdAt - right.createdAt ||
      left.eventId.localeCompare(right.eventId))
    .map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      outcome: event.outcome,
      actorClass: event.actorClass,
      createdAt: event.createdAt,
      reasonCode: event.reasonCode,
      metadata: parseMetadata(event.metadataJson),
    }));
}

function actionIntegrity(events: Record<string, unknown>[]): Record<string, unknown> {
  const started = new Set<string>();
  const settled = new Set<string>();
  for (const event of events) {
    const type = String(event.eventType ?? '');
    const metadata = event.metadata as Record<string, unknown> | undefined;
    const attemptId = typeof metadata?.actionAttemptId === 'string'
      ? metadata.actionAttemptId
      : undefined;
    if (!attemptId) continue;
    if (type === 'work.action_started') started.add(attemptId);
    if (['work.action_succeeded', 'work.action_failed', 'work.action_unknown'].includes(type)) {
      settled.add(attemptId);
    }
  }
  const missingOutcomeAttemptIds = [...started].filter((id) => !settled.has(id)).sort();
  const missingStartAttemptIds = [...settled].filter((id) => !started.has(id)).sort();
  return missingOutcomeAttemptIds.length > 0 || missingStartAttemptIds.length > 0
    ? {
        state: 'integrity_error',
        reason: missingOutcomeAttemptIds.length > 0
          ? 'missing_action_outcome'
          : 'missing_action_start',
        missingOutcomeAttemptIds,
        missingStartAttemptIds,
      }
    : { state: 'complete' };
}

function safeUsageCoverage(detail: UsageOperationDetail | undefined): Record<string, unknown> {
  if (!detail) return { state: 'not_reported' };
  return {
    state: detail.measurements.length > 0 ? 'reported' : 'incomplete',
    operationId: detail.operation.operationId,
    status: detail.operation.status,
    coverage: detail.operation.coverage,
    measurements: detail.measurements.map((measurement) => ({
      executionId: measurement.executionId,
      runExecutionId: measurement.runExecutionId ?? null,
      operationStatus: measurement.operationStatus,
      providerRoute: measurement.providerRoute,
      requestedProvider: measurement.requestedProvider,
      requestedModel: measurement.requestedModel,
      returnedProvider: measurement.returnedProvider,
      returnedModel: measurement.returnedModel,
      usageCompleteness: measurement.usageCompleteness,
      inputTokens: measurement.inputTokens,
      outputTokens: measurement.outputTokens,
      totalTokens: measurement.totalTokens,
      usageUnknownReason: measurement.usageUnknownReason,
      estimateCompleteness: measurement.estimateCompleteness,
      estimateAmountMicros: measurement.estimateAmountMicros,
      estimateCurrency: measurement.estimateCurrency,
      priceUnknownReason: measurement.priceUnknownReason,
    })),
  };
}

function recoveryProjection(run: RunRecord): Record<string, unknown> | null {
  if (!run.recoveryResolutionKind && run.status !== 'recovery_required') return null;
  return {
    state: run.status === 'recovery_required' ? 'required' : 'resolved',
    resolutionKind: run.recoveryResolutionKind,
    adminCredentialId: run.recoveryAdminCredentialId,
    claimedOperatorLabel: run.recoveryOperatorLabel,
    authOrigin: run.recoveryAuthOrigin,
    reasonCode: run.recoveryReasonCode,
    requestId: run.recoveryRequestId,
    resolvedAt: run.recoveryResolvedAt,
  };
}

function parseListInput(c: Context): ListWorkRunsInput {
  const limit = optionalInteger(c.req.query('limit'), 1, 100) ?? 50;
  const kind = c.req.query('kind');
  const status = c.req.query('status');
  const workId = optionalRunScopedId(c.req.query('workId')) as WorkId | undefined;
  const bindingId = optionalRunScopedId(c.req.query('bindingId')) as BindingId | undefined;
  if (kind && !['interactive', 'routine', 'operator'].includes(kind)) invalidQuery();
  if (status && ![
    'admitted', 'queued', 'preparing_input', 'input_ready', 'executing',
    'response_ready', 'settled', 'recovery_required',
  ].includes(status)) invalidQuery();
  const cursor = c.req.query('cursor');
  return {
    limit,
    ...(cursor ? { cursor: decodeCursor(cursor) } : {}),
    ...(kind ? { kind: kind as NonNullable<ListWorkRunsInput['kind']> } : {}),
    ...(status ? { status: status as NonNullable<ListWorkRunsInput['status']> } : {}),
    ...(workId ? { workId } : {}),
    ...(bindingId ? { bindingId } : {}),
  };
}

function matchesDeepLink(c: Context, work: WorkRecord, binding: BindingRecord): boolean {
  const workId = c.req.query('workId');
  const bindingId = c.req.query('bindingId');
  return (!workId || workId === work.id) && (!bindingId || bindingId === binding.id);
}

function encodeCursor(cursor: { createdAt: number; runId: RunId }): string {
  return `${cursor.createdAt}.${cursor.runId}`;
}

function decodeCursor(raw: string): { createdAt: number; runId: RunId } {
  const match = raw.match(/^(\d+)\.([a-z][a-z0-9_-]{7,127})$/);
  if (!match) invalidQuery();
  return { createdAt: Number(match![1]), runId: match![2] as RunId };
}

function optionalInteger(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) invalidQuery();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) invalidQuery();
  return value;
}

function optionalRunScopedId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return parseRunId(raw);
}

function parseRunId(raw: string): RunId {
  const parsed = v.safeParse(runIdSchema, raw);
  if (!parsed.success) invalidQuery();
  return parsed.output as RunId;
}

function invalidQuery(): never {
  throw new WorkStateError('work_query_invalid', 'Session query is invalid.');
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readIdempotencyKey(c: Context): string | undefined {
  const value = c.req.header('idempotency-key')?.trim();
  return value && value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : undefined;
}

function safeMutationRequest(c: Context): boolean {
  const principal = requestPrincipal(c.req.raw);
  if (principal?.machine) return principal.authenticatorKind === 'personal_token';
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return false;
  if (c.req.header('authorization')) return true;
  return Boolean(origin);
}

function adminCredential(c: Context): {
  id: string;
  origin: string;
} {
  const principal = requestPrincipal(c.req.raw);
  if (principal) {
    return {
      id: principal.credentialId,
      origin: principal.authenticatorKind,
    };
  }
  const credential = c.req.header('authorization') ?? c.req.header('cookie') ?? '';
  const host = new URL(c.req.url).hostname;
  return {
    id: `admin_${sha256(`admin-session\0${credential}`).slice(0, 20)}`,
    origin: host === 'localhost' || host === '127.0.0.1' ? 'local_admin' : 'admin_session',
  };
}

async function readJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { return undefined; }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function workError(c: Context, error: unknown): Response {
  if (error instanceof WorkStateError) {
    if (error.code === 'work_query_invalid' || error.code === 'work_recovery_invalid') {
      return c.json({ error: error.code }, 400);
    }
    if (error.code === 'work_transition_invalid') {
      return c.json({ error: error.code }, 409);
    }
    if (error.code.endsWith('_conflict')) return c.json({ error: error.code }, 409);
    return c.json({ error: error.code }, 409);
  }
  console.error('[chickpea] Sessions admin API failure');
  return c.json({ error: 'sessions_unavailable' }, 503);
}
