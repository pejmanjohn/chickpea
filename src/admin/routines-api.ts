import { randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { isCloudflareTarget } from '../config/state-backend.ts';
import {
  adminActor,
  invalidRequest as invalid,
  readIdempotencyKey,
  readJson,
  safeMutationRequest,
} from './api-support.ts';
import { RoutineService } from '../routines/service.ts';
import { routineOperatorLimits } from '../routines/limits.ts';
import {
  requireRoutineScheduling,
  resolveRoutineCapability,
  type RoutineCapability,
} from '../routines/scheduler-adapter.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineRun,
  type RoutineStore,
} from '../routines/types.ts';
import type { UsageStore } from '../usage/types.ts';
import type { WorkStore } from '../work/types.ts';
import {
  RoutineContentAccessResolver,
  routineContentReadable,
  type RoutineContentAccess,
} from './routine-content-access.ts';

interface RoutineAdminApiOptions {
  store: (c: Context) => RoutineStore;
  now?: () => number;
  id?: () => string;
  capability?: (c: Context) => RoutineCapability;
  usage?: (c: Context) => UsageStore;
  work?: (c: Context) => WorkStore;
  contentAccess?: (c: Context) => RoutineContentAccessResolver;
}

const opaqueId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,200}$/));
const controlSchema = v.strictObject({
  action: v.picklist(['pause', 'resume', 'disable', 'delete']),
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  acknowledgeIrreversible: v.optional(v.boolean()),
});

export function createRoutineAdminApi(options: RoutineAdminApiOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const fallbackAccess = new WeakMap<object, RoutineContentAccessResolver>();
  const accessFor = (c: Context): RoutineContentAccessResolver => {
    if (options.contentAccess) return options.contentAccess(c);
    const current = fallbackAccess.get(c);
    if (current) return current;
    const created = new RoutineContentAccessResolver({ work: options.work?.(c) });
    fallbackAccess.set(c, created);
    return created;
  };

  app.get('/audit/scheduled_work/routines', async (c) => {
    try {
      const workspaceId = optionalId(c.req.query('workspaceId'));
      const channelId = optionalId(c.req.query('channelId'));
      const state = c.req.query('state');
      if (state && !['active', 'paused', 'disabled', 'completed', 'current', 'all', 'deleted'].includes(state)) return invalid(c);
      const status = c.req.query('status');
      const limit = parseLimit(c.req.query('limit'));
      const offset = parseCursor(c.req.query('cursor'));
      if (status && !['queued', 'admitting', 'running', 'succeeded', 'no_op', 'failed', 'skipped', 'cancelled', 'superseded'].includes(status)) {
        return invalid(c);
      }
      const page = await options.store(c).listAdminRoutinePage({
        ...(workspaceId ? { workspaceId } : {}),
        ...(channelId ? { channelId } : {}),
        ...(state ? { state: state as RoutineDefinition['state'] | 'current' | 'all' | 'deleted' } : {}),
        ...(status ? { runStatus: status as RoutineRun['status'] } : {}),
        destinationKind: 'channel',
        cursor: offset,
        limit,
      });
      return c.json({
        routines: await Promise.all(page.routines.map(async (routine) => {
          const access = await accessFor(c).resolve(routine);
          return routineContentReadable(access)
            ? readableRoutineSummary(routine, access)
            : redactedRoutineSummary(routine, access);
        })),
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
        capability: capabilityFor(c, options),
        limits: routineOperatorLimits(),
      });
    } catch (error) {
      return routineError(c, error);
    }
  });

  app.get('/audit/scheduled_work/events', async (c) => {
    try {
      const subjectId = optionalId(c.req.query('subjectId'));
      const channelId = optionalId(c.req.query('channelId'));
      const workspaceId = optionalId(c.req.query('workspaceId'));
      const limit = parseLimit(c.req.query('limit'));
      let events = await options.store(c).listAuditEvents({
        ...(subjectId ? { subjectId } : {}),
        ...(channelId ? { channelId } : {}),
        limit,
      });
      if (workspaceId) events = events.filter((event) => event.workspaceId === workspaceId);
      const state = options.store(c);
      const visible = [];
      for (const event of events) {
        if (!await directRoutineAuditSubject(state, event.subjectId)) visible.push(event);
      }
      return c.json({ events: visible.map(safeAuditEvent) });
    } catch (error) {
      return routineError(c, error);
    }
  });

  app.get('/audit/scheduled_work/routines/:routineId', async (c) => {
    try {
      const routineId = parseId(c.req.param('routineId'));
      const state = options.store(c);
      const routine = await state.getRoutine(routineId);
      if (!routine || routine.destination.kind === 'direct_thread') {
        return c.json({ error: 'routine_not_found' }, 404);
      }
      const [runs, revisions] = await Promise.all([
        state.listRuns({ routineId, limit: 100 }),
        state.listRevisions(routineId),
      ]);
      const events = await state.listAuditEvents({
        subjectIds: [routineId, ...runs.map((run) => run.id)],
        limit: 500,
      });
      const usage = options.usage?.(c);
      const access = await accessFor(c).resolve(routine);
      const isReadable = routineContentReadable(access);
      return c.json({
        projection: isReadable ? access : 'redacted',
        routine: isReadable ? readableRoutineDetail(routine, access) : redactedRoutineDetail(routine, access),
        runs: await Promise.all(runs.map((run) => runDetail(run, usage, isReadable))),
        revisions: revisions.map((revision) => isReadable
          ? readableRoutineRevision(revision)
          : redactedRoutineRevision(revision)),
        events: events.map(safeAuditEvent),
        capability: capabilityFor(c, options),
        limits: routineOperatorLimits(),
      });
    } catch (error) {
      return routineError(c, error);
    }
  });

  app.get('/audit/scheduled_work/runs/:runId', async (c) => {
    try {
      const run = await options.store(c).getRun(parseId(c.req.param('runId')));
      if (!run) return c.json({ error: 'routine_run_not_found' }, 404);
      const routine = await options.store(c).getRoutine(run.routineId);
      if (routine?.destination.kind === 'direct_thread') {
        return c.json({ error: 'routine_run_not_found' }, 404);
      }
      const access = routine
        ? await accessFor(c).resolve(routine)
        : 'authorization_unknown';
      const isReadable = routineContentReadable(access);
      return c.json({
        projection: isReadable ? access : 'redacted',
        run: await runDetail(run, options.usage?.(c), isReadable),
      });
    } catch (error) {
      return routineError(c, error);
    }
  });

  app.post('/audit/scheduled_work/routines/:routineId/control', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(controlSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const routineId = parseId(c.req.param('routineId'));
      const state = options.store(c);
      const routine = await state.getRoutine(routineId);
      if (!routine || routine.deletedAt !== null || routine.destination.kind === 'direct_thread') {
        return c.json({ error: 'routine_not_found' }, 404);
      }
      const actorId = adminActor(c);
      const service = new RoutineService(state, {
        now,
        confirmationId: () => `rconfirm_admin_${id().replaceAll('-', '')}`,
        token: () => id().replaceAll('-', ''),
      });
      if (parsed.output.action === 'delete') {
        if (parsed.output.acknowledgeIrreversible !== true) return invalid(c);
        const confirmation = await service.createConfirmation({
          action: 'delete',
          actorId,
          actorClass: 'operator',
          workspaceId: routine.workspaceId,
          channelId: routine.channelId,
          routineId,
          expectedVersion: parsed.output.expectedVersion,
        });
        const deleted = await service.confirm({
          token: confirmation.token,
          actorId,
          workspaceId: routine.workspaceId,
          channelId: routine.channelId,
          previewHash: confirmation.previewHash,
          idempotencyKey: `admin:routine:delete:${idempotencyKey}`,
        });
        const access = await accessFor(c).resolve(deleted);
        const isReadable = routineContentReadable(access);
        return c.json({
          projection: isReadable ? access : 'redacted',
          routine: isReadable ? readableRoutineDetail(deleted, access) : redactedRoutineDetail(deleted, access),
          irreversible: true,
        });
      }
      if (parsed.output.action === 'resume') {
        requireRoutineScheduling(capabilityFor(c, options));
      }
      const updated = await service.control({
        routineId,
        expectedVersion: parsed.output.expectedVersion,
        action: parsed.output.action,
        actorId,
        actorClass: 'operator',
        reasonCode: 'admin_control',
        idempotencyKey: `admin:routine:${parsed.output.action}:${idempotencyKey}`,
      });
      const access = await accessFor(c).resolve(updated);
      const isReadable = routineContentReadable(access);
      return c.json({
        projection: isReadable ? access : 'redacted',
        routine: isReadable ? readableRoutineDetail(updated, access) : redactedRoutineDetail(updated, access),
      });
    } catch (error) {
      return routineError(c, error);
    }
  });

  return app;
}

async function directRoutineAuditSubject(
  store: RoutineStore,
  subjectId: string | null,
): Promise<boolean> {
  if (!subjectId) return false;
  const routine = await store.getRoutine(subjectId);
  if (routine) return routine.destination.kind === 'direct_thread';
  const run = await store.getRun(subjectId);
  if (!run) return false;
  return (await store.getRoutine(run.routineId))?.destination.kind === 'direct_thread';
}

function routineSafeIdentity(routine: RoutineDefinition): Record<string, unknown> {
  return {
    id: routine.id,
    workId: routine.workId ?? null,
    bindingId: routine.bindingId ?? null,
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    creatorUserId: routine.creatorUserId,
    state: routine.deletedAt !== null ? 'deleted' : routine.state,
    version: routine.version,
    triggerKind: routine.triggerKind,
    scheduleInput: routine.scheduleInput,
    timezone: routine.timezone,
    outputPolicy: routine.outputPolicy,
    nextRunAt: routine.nextRunAt,
    lastScheduledAt: routine.lastScheduledAt,
    lastFinishedAt: routine.lastFinishedAt,
    consecutiveFailures: routine.consecutiveFailures,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  };
}

function readableRoutineSummary(
  routine: RoutineDefinition,
  access: Extract<RoutineContentAccess, 'public' | 'private_member'>,
): Record<string, unknown> {
  return {
    ...routineSafeIdentity(routine),
    name: routine.name,
    description: routine.description,
    contentAccess: access,
  };
}

function redactedRoutineSummary(
  routine: RoutineDefinition,
  access: Extract<RoutineContentAccess, 'private_nonmember' | 'authorization_unknown'>,
): Record<string, unknown> {
  return {
    ...routineSafeIdentity(routine),
    name: null,
    description: null,
    contentAccess: access,
  };
}

function readableRoutineDetail(
  routine: RoutineDefinition,
  access: Extract<RoutineContentAccess, 'public' | 'private_member'>,
): Record<string, unknown> {
  return {
    ...readableRoutineSummary(routine, access),
    taskText: routine.deletedAt === null ? routine.taskText : null,
    triggerKind: routine.triggerKind,
    scheduleJson: routine.scheduleJson,
    authorityMode: routine.authorityMode,
    projectedDailyStarts: routine.projectedDailyStarts,
    pausedAt: routine.pausedAt,
    pausedReason: routine.pausedReason,
    disabledAt: routine.disabledAt,
    disabledReason: routine.disabledReason,
    deletedAt: routine.deletedAt,
  };
}

function redactedRoutineDetail(
  routine: RoutineDefinition,
  access: Extract<RoutineContentAccess, 'private_nonmember' | 'authorization_unknown'>,
): Record<string, unknown> {
  return {
    ...redactedRoutineSummary(routine, access),
    taskText: null,
    scheduleJson: routine.scheduleJson,
    authorityMode: routine.authorityMode,
    projectedDailyStarts: routine.projectedDailyStarts,
    pausedAt: routine.pausedAt,
    pausedReason: routine.pausedReason,
    disabledAt: routine.disabledAt,
    disabledReason: routine.disabledReason,
    deletedAt: routine.deletedAt,
  };
}

function readableRoutineRevision(
  revision: Awaited<ReturnType<RoutineStore['listRevisions']>>[number],
): Record<string, unknown> {
  return {
    routineId: revision.routineId,
    version: revision.version,
    definition: revision.definition,
    definitionHash: revision.definitionHash,
    actorId: revision.actorId,
    actorClass: revision.actorClass,
    provenance: revision.provenance,
    createdAt: revision.createdAt,
  };
}

function redactedRoutineRevision(
  revision: Awaited<ReturnType<RoutineStore['listRevisions']>>[number],
): Record<string, unknown> {
  return {
    routineId: revision.routineId,
    version: revision.version,
    definition: null,
    definitionHash: revision.definitionHash,
    actorId: revision.actorId,
    actorClass: revision.actorClass,
    provenance: null,
    createdAt: revision.createdAt,
  };
}

async function runDetail(
  run: RoutineRun,
  usageStore?: UsageStore,
  publicContent = false,
): Promise<Record<string, unknown>> {
  const operationId = run.usageLedgerOperationId ?? null;
  const ledger = operationId && usageStore
    ? await usageStore.getOperation(operationId)
    : undefined;
  return {
    id: run.id,
    canonicalRunId: run.canonicalRunId ?? null,
    routineId: run.routineId,
    routineVersion: run.routineVersion,
    scheduledFor: run.scheduledFor,
    triggerSource: run.triggerSource,
    requestedBy: run.requestedBy,
    status: run.status,
    failureClass: run.failureClass,
    publicError: publicContent ? run.publicError : null,
    queuedAt: run.queuedAt,
    admittedAt: run.admittedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    resolvedAccessHash: run.resolvedAccessHash,
    resolvedAgentId: run.resolvedAgentId,
    model: run.model,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    costEstimate: run.costEstimate,
    costUnit: run.costUnit,
    usageLedgerOperationId: operationId,
    usageProvenance: run.usageProvenance ?? 'legacy_routine',
    usageCompleteness: run.usageCompleteness ?? (
      run.inputTokens !== null || run.outputTokens !== null ? 'partial' : 'not_reported'
    ),
    usage: ledger
      ? { source: 'usage_ledger', available: true, ...safeRoutineUsage(ledger, publicContent) }
      : operationId
        ? {
            source: 'usage_ledger',
            available: false,
            operationId,
            reason: 'ledger_record_unavailable',
          }
        : {
            source: 'legacy_routine',
            available: run.inputTokens !== null || run.outputTokens !== null,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            costEstimate: run.costEstimate,
            costUnit: run.costUnit,
            limitation: 'No provider or credential attribution is available for this historical row.',
          },
    toolCallCount: run.toolCallCount,
    deliveryStatus: run.deliveryStatus,
    deliveryChannelId: run.deliveryChannelId,
    deliveryMessageTs: run.deliveryMessageTs,
    suppressedAsNoOp: run.suppressedAsNoOp,
    missedSlotCount: run.missedSlotCount,
    skipReason: run.skipReason,
    flueRunId: run.flueRunId,
    traceId: run.traceId,
  };
}

function safeRoutineUsage(
  detail: NonNullable<Awaited<ReturnType<UsageStore['getOperation']>>>,
  publicLabels: boolean,
): Record<string, unknown> {
  const operation = detail.operation;
  return {
    operation: {
      operationId: operation.operationId,
      runId: operation.runId ?? null,
      operationKind: operation.operationKind,
      sourceId: operation.sourceId,
      status: operation.status,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
      installationId: operation.installationId,
      workspaceId: operation.workspaceId,
      agentId: operation.agentId,
      agentLabel: publicLabels ? operation.agentLabel : null,
      channelId: operation.channelId,
      channelLabel: publicLabels ? operation.channelLabel : null,
      conversationKind: operation.conversationKind,
      routineId: operation.routineId,
      routineLabel: publicLabels ? operation.routineLabel : null,
      routineRunId: operation.routineRunId,
      requestedProvider: operation.requestedProvider,
      requestedModel: operation.requestedModel,
      coverage: operation.coverage,
      telemetrySchemaVersion: operation.telemetrySchemaVersion,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    },
    measurements: detail.measurements.map((measurement) => ({
      executionId: measurement.executionId,
      runExecutionId: measurement.runExecutionId ?? null,
      operationId: measurement.operationId,
      operationStatus: measurement.operationStatus,
      observedAt: measurement.observedAt,
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
      priceVersionId: measurement.priceVersionId,
      priceUnknownReason: measurement.priceUnknownReason,
      recordedAt: measurement.recordedAt,
    })),
  };
}

function safeAuditEvent(event: Awaited<ReturnType<RoutineStore['listAuditEvents']>>[number]): Record<string, unknown> {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    outcome: event.outcome,
    actorClass: event.actorClass,
    actorId: event.actorId,
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    subjectId: event.subjectId,
    subjectVersion: event.subjectVersion,
    createdAt: event.createdAt,
    reasonCode: event.reasonCode,
    beforeHash: event.beforeHash,
    afterHash: event.afterHash,
    metadata: parseSafeMetadata(event.metadataJson),
  };
}

function capabilityFor(c: Context, options: RoutineAdminApiOptions): RoutineCapability {
  if (options.capability) return options.capability(c);
  return resolveRoutineCapability({ cloudflare: isCloudflareTarget() });
}

function parseSafeMetadata(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseId(value: string): string {
  const parsed = v.safeParse(opaqueId, value);
  if (!parsed.success) throw new RoutineStateError('routine_invalid_id', 'Routine identifier is invalid.');
  return parsed.output;
}

function optionalId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parseId(value);
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new RoutineStateError('routine_invalid_filter', 'Routine filter is invalid.');
  }
  return parsed;
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) {
    throw new RoutineStateError('routine_invalid_filter', 'Routine filter is invalid.');
  }
  return parsed;
}

function routineError(c: Context, error: unknown): Response {
  if (error instanceof RoutineStateError) {
    if (error.code === 'routine_not_found') return c.json({ error: error.code }, 404);
    if (error.code === 'routine_version_conflict') {
      return c.json({ error: error.code, ...error.details }, 409);
    }
    return c.json({ error: error.code, message: error.message }, 400);
  }
  console.error('[chickpea] scheduled-work admin API failure');
  return c.json({ error: 'scheduled_work_unavailable' }, 500);
}
