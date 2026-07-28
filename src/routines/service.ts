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
  type SaveRoutineInput,
  type RoutineStore,
  RoutineStateError,
} from './types.ts';
import { validateRoutineDefinition, validateRoutineScope } from './validation.ts';

interface RoutineRequestBase {
  actorId: string;
  actorClass?: 'member' | 'operator';
  workspaceId: string;
  channelId: string;
}

export type RoutineSaveRequest = RoutineRequestBase & (
  | {
      action: 'create';
      routineId?: string;
      definition: RoutineDefinitionContent;
      nextRunAt: number;
      projectedDailyStarts: number;
      reservations: RoutineScheduleReservation[];
    }
  | {
      action: 'edit';
      routineId: string;
      expectedVersion?: number;
      definition: RoutineDefinitionContent;
      nextRunAt: number;
      projectedDailyStarts: number;
      reservations: RoutineScheduleReservation[];
    }
);

export type RoutineDeletionRequest = RoutineRequestBase & {
  action: 'delete';
  routineId: string;
  expectedVersion?: number;
};

export type RoutineDraftRequest = RoutineSaveRequest | RoutineDeletionRequest;
type RoutineExistingRequest = Extract<RoutineSaveRequest, { action: 'edit' }> | RoutineDeletionRequest;

export interface RoutineConfirmationReceipt {
  confirmationId: string;
  token: string;
  previewHash: string;
  expiresAt: number;
  draft: Extract<RoutineConfirmationDraft, { action: 'delete' }>;
}

interface RoutineServiceDependencies {
  now?: () => number;
  routineId?: () => string;
  confirmationId?: () => string;
  token?: () => string;
}

/**
 * Deterministic routine-management boundary. Model output may populate a
 * RoutineDraftRequest, but only this service validates and persists it.
 * User-facing confirmation is reserved for irreversible deletion.
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

  async createConfirmation(request: RoutineDeletionRequest): Promise<RoutineConfirmationReceipt> {
    validateRoutineScope(request.workspaceId, request.channelId, request.actorId);
    const current = await this.requireCurrent(request);
    const draft = { action: 'delete' as const, routineId: current.id, expectedVersion: current.version };
    const token = this.token();
    const previewHash = hashRoutineValue(JSON.stringify(draft));
    const confirmationId = this.confirmationId();
    const expiresAt = this.now() + ROUTINE_LIMITS.confirmationTtlMs;
    await this.store.putConfirmation({
      confirmationId,
      tokenHash: hashRoutineValue(token),
      actorId: request.actorId,
      actorClass: request.actorClass ?? 'member',
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      draft,
      previewHash,
      expiresAt,
    });
    return { confirmationId, token, previewHash, expiresAt, draft };
  }

  /**
   * Apply a conversational create/edit in the same Slack turn. Validation,
   * optimistic versions, capacity, revision history, and audit remain atomic;
   * no confirmation token or intermediate artifact is created.
   */
  async save(
    request: RoutineSaveRequest,
    idempotencyKey: string,
  ): Promise<RoutineDefinition> {
    const draft = await this.buildSaveDraft(request);
    const input: SaveRoutineInput = {
      actorId: request.actorId,
      actorClass: request.actorClass ?? 'member',
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      draft,
      idempotencyKey,
    };
    return this.store.save(input);
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

  private async buildSaveDraft(
    request: RoutineSaveRequest,
  ): Promise<Exclude<RoutineConfirmationDraft, { action: 'delete' }>> {
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

  private async requireCurrent(request: RoutineExistingRequest): Promise<RoutineDefinition> {
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
