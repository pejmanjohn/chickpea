import {
  createConfirmationId,
  createConfirmationToken,
  createRoutineId,
  hashRoutineValue,
  isOpaqueRoutineId,
} from './ids.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  type ConfirmRoutineInput,
  type ControlRoutineInput,
  type RoutineConfirmationDraft,
  type RoutineDefinition,
  type RoutineDefinitionContent,
  type RoutineScheduleReservation,
  type RoutineStore,
  RoutineStateError,
} from './types.ts';
import { validateRoutineDefinition, validateRoutineScope } from './validation.ts';

export interface RoutineDraftRequest {
  action: 'create' | 'edit' | 'delete';
  actorId: string;
  workspaceId: string;
  channelId: string;
  routineId?: string;
  expectedVersion?: number;
  definition?: RoutineDefinitionContent;
  nextRunAt?: number;
  projectedDailyStarts?: number;
  reservations?: RoutineScheduleReservation[];
}

export interface RoutineConfirmationReceipt {
  confirmationId: string;
  token: string;
  previewHash: string;
  expiresAt: number;
  draft: RoutineConfirmationDraft;
}

interface RoutineServiceDependencies {
  now?: () => number;
  routineId?: () => string;
  confirmationId?: () => string;
  token?: () => string;
}

/**
 * Deterministic routine-management boundary. Model output may populate a
 * RoutineDraftRequest, but only this service validates and persists a
 * one-time, actor/scope/version-bound confirmation artifact.
 */
export class RoutineService {
  private readonly now: () => number;
  private readonly routineId: () => string;
  private readonly confirmationId: () => string;
  private readonly token: () => string;

  constructor(
    private readonly store: RoutineStore,
    dependencies: RoutineServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.routineId = dependencies.routineId ?? createRoutineId;
    this.confirmationId = dependencies.confirmationId ?? createConfirmationId;
    this.token = dependencies.token ?? createConfirmationToken;
  }

  async createConfirmation(request: RoutineDraftRequest): Promise<RoutineConfirmationReceipt> {
    validateRoutineScope(request.workspaceId, request.channelId, request.actorId);
    const draft = await this.buildDraft(request);
    const token = this.token();
    const previewHash = hashRoutineValue(JSON.stringify(draft));
    const confirmationId = this.confirmationId();
    const expiresAt = this.now() + ROUTINE_LIMITS.confirmationTtlMs;
    await this.store.putConfirmation({
      confirmationId,
      tokenHash: hashRoutineValue(token),
      actorId: request.actorId,
      actorClass: 'member',
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      draft,
      previewHash,
      expiresAt,
    });
    return { confirmationId, token, previewHash, expiresAt, draft };
  }

  async confirm(input: Omit<ConfirmRoutineInput, 'tokenHash'> & { token: string }): Promise<RoutineDefinition> {
    return this.store.confirm({
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      previewHash: input.previewHash,
      idempotencyKey: input.idempotencyKey,
      tokenHash: hashRoutineValue(input.token),
    });
  }

  async control(input: ControlRoutineInput): Promise<RoutineDefinition> {
    if (!isOpaqueRoutineId(input.routineId) || !isOpaqueRoutineId(input.actorId)) {
      throw new RoutineStateError('routine_control_invalid', 'Routine control is invalid.');
    }
    return this.store.control(input);
  }

  private async buildDraft(request: RoutineDraftRequest): Promise<RoutineConfirmationDraft> {
    if (request.action === 'delete') {
      const current = await this.requireCurrent(request);
      return { action: 'delete', routineId: current.id, expectedVersion: current.version };
    }
    const definition = validateRoutineDefinition(request.definition);
    const nextRunAt = requiredInteger(request.nextRunAt, 'Routine next occurrence is required.');
    const projectedDailyStarts = requiredInteger(
      request.projectedDailyStarts,
      'Routine capacity projection is required.',
    );
    const reservations = request.reservations;
    if (!Array.isArray(reservations) || reservations.length === 0) {
      throw new RoutineStateError(
        'routine_draft_invalid',
        'Routine schedule reservations are required.',
      );
    }
    if (request.action === 'create') {
      return {
        action: 'create',
        routineId: request.routineId ?? this.routineId(),
        definition,
        nextRunAt,
        projectedDailyStarts,
        reservations,
      };
    }
    const current = await this.requireCurrent(request);
    return {
      action: 'edit',
      routineId: current.id,
      expectedVersion: current.version,
      definition,
      nextRunAt,
      projectedDailyStarts,
      reservations,
    };
  }

  private async requireCurrent(request: RoutineDraftRequest): Promise<RoutineDefinition> {
    if (!request.routineId) {
      throw new RoutineStateError('routine_draft_invalid', 'Routine ID is required.');
    }
    const current = await this.store.getRoutine(request.routineId);
    if (
      !current ||
      current.deletedAt !== null ||
      current.workspaceId !== request.workspaceId ||
      current.channelId !== request.channelId
    ) {
      throw new RoutineStateError('routine_not_found', 'Routine was not found.');
    }
    if (request.expectedVersion !== undefined && request.expectedVersion !== current.version) {
      throw new RoutineStateError('routine_version_conflict', 'Routine changed. Refresh and try again.', {
        routineId: current.id,
        currentVersion: String(current.version),
      });
    }
    return current;
  }
}

function requiredInteger(value: number | undefined, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RoutineStateError('routine_draft_invalid', message);
  }
  return Number(value);
}
