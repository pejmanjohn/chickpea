import { frozenRuntimeModelRouteIdentity } from '../config/runtime-model.ts';
import {
  InstallationContextError,
  parseInstallationOwnership,
  scopedObjectName,
  splitInstallationObjectName,
  type InstallationOwnership,
} from '../config/installation-scope.ts';
import type { RepositoryGrant } from '../config/types.ts';
import {
  parseRepository,
  parseRuntimePlanCodingModelRoute,
  parseRuntimePlanModelCredential,
  type RuntimePlanCodingModelV1,
  type RuntimePlanModelCredentialV3,
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
 *
 * Version 1 is standalone's. Version 2 is an installation's of a deployment
 * serving many: it also names the installation, which names the worker's
 * instance, and the coding model's credential (reference and version, never
 * a secret) frozen with the coordinator's plan, which the worker's model
 * access binds (agents/model-access-lookup.ts).
 */
export type CodingWorkerBinding = CodingWorkerBindingV1 | CodingWorkerBindingV2;

export interface CodingWorkerBindingV1 {
  schemaVersion: 1;
  /** The workspace ID the worker's container lives in (sandbox/sandbox-object.ts names its Sandbox). */
  workspaceId: string;
  agentId: string;
  codingModel: CodingWorkerModel;
  repositories: RuntimePlanRepositoryV2[];
}

export interface CodingWorkerBindingV2 extends Omit<CodingWorkerBindingV1, 'schemaVersion'> {
  schemaVersion: 2;
  installation: InstallationOwnership;
  /** The coding model's frozen credential; absent when the coordinator's plan froze none. */
  modelCredential?: RuntimePlanModelCredentialV3;
}

export type CodingWorkerModel = Pick<RuntimePlanCodingModelV1, 'model' | 'runtimeModel' | 'runtimeModelRoute'>;

export function codingWorkerBindingForPlan(
  plan: Pick<
    RuntimePlanV2,
    'agentId' | 'model' | 'runtimeModel' | 'runtimeModelRoute' | 'codingWorkspace' | 'repositories' |
    'installation' | 'modelCredential'
  >,
  workspaceId: string,
): CodingWorkerBinding {
  // The coding model frozen for this turn, or the Agent's own route when the
  // plan carries none: a coding role that resolved to nothing falls back to
  // the Agent's model, never to "no model".
  const frozen = plan.codingWorkspace?.codingModel;
  const { model, runtimeModel = model, runtimeModelRoute } = frozen ?? plan;
  const binding: CodingWorkerBindingV1 = {
    schemaVersion: 1,
    workspaceId,
    agentId: plan.agentId,
    codingModel: { model, runtimeModel, ...(runtimeModelRoute ? { runtimeModelRoute } : {}) },
    repositories: plan.repositories.map((repository) => ({ ...repository })),
  };
  if (!plan.installation) return binding;
  // The coding model's own credential, else the Agent's when it runs on the Agent's model.
  const modelCredential = frozen?.modelCredential ??
    (frozen === undefined || frozen.model === plan.model ? plan.modelCredential : undefined);
  return {
    ...binding,
    schemaVersion: 2,
    installation: { version: 1, installationId: plan.installation.installationId },
    ...(modelCredential ? { modelCredential: { ...modelCredential } } : {}),
  };
}

/**
 * The worker instance for a binding. It is derived from the workspace id and
 * the whole binding, because Flue ignores `initialData` sent to an existing
 * instance: the only honest way to change the coding model or the grants is
 * to address a new worker. The workspace (its files, checkpoint, and egress
 * turn binding) stays keyed by `workspaceId` and is shared with the thin
 * workspace tools. A version 2 instance is named under its installation.
 */
export function codingWorkerInstanceId(binding: CodingWorkerBinding): string {
  const repositories = binding.repositories
    .map(({ id, fullName, allRepos, accountLogin }) => [id, fullName, allRepos === true, accountLogin ?? ''])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const identity: unknown[] = [
    binding.schemaVersion,
    binding.workspaceId,
    binding.agentId,
    binding.codingModel.model,
    binding.codingModel.runtimeModel,
    binding.codingModel.runtimeModelRoute
      ? frozenRuntimeModelRouteIdentity(binding.codingModel.runtimeModelRoute)
      : null,
    repositories,
  ];
  if (binding.schemaVersion === 1) return opaqueId('codingworker', JSON.stringify(identity));
  const credential = binding.modelCredential;
  identity.push(
    binding.installation.installationId,
    credential ? [credential.providerId, credential.credentialRefId, credential.version] : null,
  );
  return scopedObjectName(binding.installation, opaqueId('codingworker', JSON.stringify(identity)));
}

/** The installation a coding worker instance ID is named under, if any. */
export function codingWorkerInstallationId(instanceId: string): string | undefined {
  return splitInstallationObjectName(instanceId).scope?.installationId;
}

export function parseCodingWorkerBinding(value: unknown): CodingWorkerBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Coding worker binding must be an object.');
  }
  const record = value as Record<string, unknown>;
  const version = record.schemaVersion;
  if (version !== 1 && version !== 2) throw new Error('Coding worker binding schemaVersion must be 1 or 2.');
  const allowed = new Set(['schemaVersion', 'workspaceId', 'agentId', 'codingModel', 'repositories']);
  if (version === 2) {
    allowed.add('installation');
    allowed.add('modelCredential');
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Coding worker binding has an unknown field: ${key}.`);
  }
  const workspaceId = boundedId(record.workspaceId, 'workspaceId');
  const agentId = boundedId(record.agentId, 'agentId');
  if (!Array.isArray(record.repositories) || record.repositories.length > 200) {
    throw new Error('Coding worker binding repositories must be a bounded list.');
  }
  const repositories = record.repositories.map((entry, index) => parseRepository(entry, index));
  // Attribution stays with the coordinator's plan and footer.
  const codingModel = parseRuntimePlanCodingModelRoute(record.codingModel);
  const binding: CodingWorkerBindingV1 = { schemaVersion: 1, workspaceId, agentId, codingModel, repositories };
  if (version === 1) return binding;
  let installation: InstallationOwnership;
  try {
    installation = parseInstallationOwnership(record.installation);
  } catch {
    throw new InstallationContextError('installation_context_invalid', 'Coding worker binding installation is malformed.');
  }
  return {
    ...binding,
    schemaVersion: 2,
    installation,
    ...(record.modelCredential === undefined
      ? {}
      : { modelCredential: parseRuntimePlanModelCredential(record.modelCredential) }),
  };
}

/** Policy-only grants for the Repositories skill; the worker never sees a token. */
export function codingWorkerRepositoryGrants(binding: CodingWorkerBinding): RepositoryGrant[] {
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
