import type { RepositoryGrant } from '../config/types.ts';
import {
  parseRuntimePlanCodingModelRoute,
  parseRuntimePlanRepository,
  type RuntimePlanCodingModelV1,
  type RuntimePlanRepositoryV2,
  type RuntimePlanV2,
} from '../agents/runtime-plan.ts';
import { opaqueId } from '../work/admission.ts';

/**
 * What a coding worker is created with: the workspace it works in, the Agent
 * it works for, the coding model it runs on, and the repositories it may
 * reach. Ids and a model route only; no credential ever rides on it.
 *
 * Flue records this as the worker's `initialData` on first contact and never
 * changes it afterwards, so everything here is also part of the worker's
 * instance id: a changed coding model or grant list addresses a new worker.
 */
export interface CodingWorkerBindingV1 {
  schemaVersion: 1;
  /** The Sandbox Durable Object id the worker's container lives in. */
  workspaceId: string;
  agentId: string;
  codingModel: CodingWorkerModel;
  repositories: RuntimePlanRepositoryV2[];
}

export type CodingWorkerModel = Pick<RuntimePlanCodingModelV1, 'model' | 'runtimeModel' | 'runtimeModelRoute'>;

/**
 * The coding model frozen for this turn, or the Agent's own route when the
 * plan carries none (a coding role that resolved to nothing falls back to the
 * Agent's model, never to "no model").
 */
export function codingWorkerModelForPlan(
  plan: Pick<RuntimePlanV2, 'model' | 'runtimeModel' | 'runtimeModelRoute' | 'codingWorkspace'>,
): CodingWorkerModel {
  const frozen = plan.codingWorkspace?.codingModel;
  if (frozen) {
    return {
      model: frozen.model,
      runtimeModel: frozen.runtimeModel,
      ...(frozen.runtimeModelRoute ? { runtimeModelRoute: frozen.runtimeModelRoute } : {}),
    };
  }
  return {
    model: plan.model,
    runtimeModel: plan.runtimeModel ?? plan.model,
    ...(plan.runtimeModelRoute ? { runtimeModelRoute: plan.runtimeModelRoute } : {}),
  };
}

export function codingWorkerBindingForPlan(
  plan: Pick<RuntimePlanV2, 'agentId' | 'model' | 'runtimeModel' | 'runtimeModelRoute' | 'codingWorkspace' | 'repositories'>,
  workspaceId: string,
): CodingWorkerBindingV1 {
  return {
    schemaVersion: 1,
    workspaceId,
    agentId: plan.agentId,
    codingModel: codingWorkerModelForPlan(plan),
    repositories: plan.repositories.map((repository) => ({ ...repository })),
  };
}

/**
 * The worker instance for a binding. It is derived from the workspace id and
 * the whole binding, because Flue ignores `initialData` sent to an existing
 * instance: the only honest way to change the coding model or the grants is
 * to address a new worker. The workspace (its files, checkpoint, and egress
 * turn binding) stays keyed by `workspaceId` and is shared with the thin
 * workspace tools.
 */
export function codingWorkerInstanceId(binding: CodingWorkerBindingV1): string {
  const repositories = binding.repositories
    .map(({ id, fullName, allRepos, accountLogin }) => [id, fullName, allRepos === true, accountLogin ?? ''])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return opaqueId('codingworker', JSON.stringify([
    binding.schemaVersion,
    binding.workspaceId,
    binding.agentId,
    binding.codingModel.model,
    binding.codingModel.runtimeModel,
    binding.codingModel.runtimeModelRoute ?? null,
    repositories,
  ]));
}

export function parseCodingWorkerBinding(value: unknown): CodingWorkerBindingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Coding worker binding must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'workspaceId', 'agentId', 'codingModel', 'repositories']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Coding worker binding has an unknown field: ${key}.`);
  }
  if (record.schemaVersion !== 1) throw new Error('Coding worker binding schemaVersion must be 1.');
  const workspaceId = boundedId(record.workspaceId, 'workspaceId');
  const agentId = boundedId(record.agentId, 'agentId');
  if (!Array.isArray(record.repositories) || record.repositories.length > 200) {
    throw new Error('Coding worker binding repositories must be a bounded list.');
  }
  const repositories = record.repositories.map((entry, index) => parseRuntimePlanRepository(entry, index));
  // Attribution stays with the coordinator's plan and footer.
  const codingModel = parseRuntimePlanCodingModelRoute(record.codingModel);
  return { schemaVersion: 1, workspaceId, agentId, codingModel, repositories };
}

/** Policy-only grants for the Repositories skill; the worker never sees a token. */
export function codingWorkerRepositoryGrants(binding: CodingWorkerBindingV1): RepositoryGrant[] {
  return binding.repositories.map((repository) => ({
    id: repository.id,
    installationId: null,
    accountLogin: repository.accountLogin ??
      (repository.fullName.split('/', 1)[0] || repository.fullName),
    fullName: repository.fullName,
    ...(repository.allRepos ? { allRepos: true } : {}),
    enabled: true,
  }));
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new Error(`Coding worker binding ${label} must be a string of 1 to 256 characters.`);
  }
  return value;
}
