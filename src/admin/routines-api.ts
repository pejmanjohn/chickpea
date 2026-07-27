import { createHash, randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { isCloudflareTarget, type PlatformEnv } from '../config/state-backend.ts';
import { RoutineService } from '../routines/service.ts';
import { routineOperatorLimits } from '../routines/limits.ts';
import {
  resolveRoutineCapability,
  type RoutineCapability,
} from '../routines/scheduler-adapter.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineRun,
  type RoutineStore,
} from '../routines/types.ts';

interface RoutineAdminApiOptions {
  store: (c: Context) => RoutineStore;
  now?: () => number;
  id?: () => string;
  capability?: (c: Context) => RoutineCapability;
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

  app.get('/audit/scheduled_work/routines', async (c) => {
    try {
      const workspaceId = optionalId(c.req.query('workspaceId'));
      const channelId = optionalId(c.req.query('channelId'));
      const state = c.req.query('state');
      if (state && !['active', 'paused', 'disabled', 'deleted'].includes(state)) return invalid(c);
      const status = c.req.query('status');
      const limit = parseLimit(c.req.query('limit'));
      const offset = parseCursor(c.req.query('cursor'));
      let routines = await options.store(c).listRoutines(workspaceId, channelId);
      if (state) {
        routines = routines.filter((routine) =>
          state === 'deleted' ? routine.deletedAt !== null : routine.deletedAt === null && routine.state === state,
        );
      }
      if (status) {
        if (!['queued', 'admitting', 'running', 'succeeded', 'no_op', 'failed', 'skipped', 'cancelled', 'superseded'].includes(status)) {
          return invalid(c);
        }
        const matching = new Set(
          (await options.store(c).listRuns({ statuses: [status as RoutineRun['status']], limit: 500 }))
            .map((run) => run.routineId),
        );
        routines = routines.filter((routine) => matching.has(routine.id));
      }
      const page = routines.slice(offset, offset + limit);
      return c.json({
        routines: page.map(routineSummary),
        nextCursor: offset + limit < routines.length ? String(offset + limit) : null,
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
      return c.json({ events: events.map(safeAuditEvent) });
    } catch (error) {
      return routineError(c, error);
    }
  });

  app.get('/audit/scheduled_work/routines/:routineId', async (c) => {
    try {
      const routineId = parseId(c.req.param('routineId'));
      const state = options.store(c);
      const routine = await state.getRoutine(routineId);
      if (!routine) return c.json({ error: 'routine_not_found' }, 404);
      const [runs, revisions] = await Promise.all([
        state.listRuns({ routineId, limit: 100 }),
        state.listRevisions(routineId),
      ]);
      const events = await state.listAuditEvents({
        subjectIds: [routineId, ...runs.map((run) => run.id)],
        limit: 500,
      });
      return c.json({
        routine: routineDetail(routine),
        runs: runs.map(runDetail),
        revisions: revisions.map((revision) => ({
          routineId: revision.routineId,
          version: revision.version,
          definition: revision.definition,
          definitionHash: revision.definitionHash,
          actorId: revision.actorId,
          actorClass: revision.actorClass,
          createdAt: revision.createdAt,
        })),
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
      return c.json({ run: runDetail(run) });
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
      if (!routine || routine.deletedAt !== null) return c.json({ error: 'routine_not_found' }, 404);
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
        return c.json({ routine: routineDetail(deleted), irreversible: true });
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
      return c.json({ routine: routineDetail(updated) });
    } catch (error) {
      return routineError(c, error);
    }
  });

  return app;
}

function routineSummary(routine: RoutineDefinition): Record<string, unknown> {
  return {
    id: routine.id,
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    creatorUserId: routine.creatorUserId,
    name: routine.name,
    description: routine.description,
    state: routine.deletedAt !== null ? 'deleted' : routine.state,
    version: routine.version,
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

function routineDetail(routine: RoutineDefinition): Record<string, unknown> {
  return {
    ...routineSummary(routine),
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

function runDetail(run: RoutineRun): Record<string, unknown> {
  return {
    id: run.id,
    routineId: run.routineId,
    routineVersion: run.routineVersion,
    scheduledFor: run.scheduledFor,
    triggerSource: run.triggerSource,
    requestedBy: run.requestedBy,
    status: run.status,
    failureClass: run.failureClass,
    publicError: run.publicError,
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
  const env = c.env as PlatformEnv | undefined;
  const flag = env?.TAG_ROUTINES_ENABLED;
  return resolveRoutineCapability({
    cloudflare: isCloudflareTarget(),
    ...(typeof flag === 'string' ? { enabledFlag: flag } : {}),
  });
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

function readIdempotencyKey(c: Context): string | undefined {
  const key = c.req.header('idempotency-key')?.trim();
  return key && key.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key) ? key : undefined;
}

function safeMutationRequest(c: Context): boolean {
  if (c.req.header('authorization')) return true;
  const origin = c.req.header('origin');
  return Boolean(origin && origin === new URL(c.req.url).origin);
}

function adminActor(c: Context): string {
  const credential = c.req.header('authorization') ?? c.req.header('cookie') ?? '';
  return `admin_${createHash('sha256').update(`admin-session\0${credential}`).digest('hex').slice(0, 20)}`;
}

async function readJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { return undefined; }
}

function invalid(c: Context): Response {
  return c.json({ error: 'invalid_request' }, 400);
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
