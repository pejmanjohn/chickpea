/**
 * The trusted lookup that binds each Flue attempt to its run's model access.
 *
 * The model-access interceptor (config/model-access.ts) calls it at every
 * top-level agent operation, before the attempt's first model call, with
 * only Flue's coordinates `(agentName, instanceId, submissionId)`. The run is
 * found in state the host persisted when it dispatched: a Slack turn through
 * its TurnJob (the `matchFlueObservation` match) and the plan staged beside
 * the thread's instance; a routine occurrence through its persisted dispatch.
 * Nothing model-visible or tool-supplied is consulted. The sandbox factory is
 * not a binding point: Flue runs it outside the agent operation when it
 * reconciles a resumed attempt.
 *
 * A Slack or routine attempt whose run is not found fails closed: every turn
 * is staged before its dispatch, and every occurrence persists its dispatch
 * before it starts, so a miss means the lookup broke or the run settled.
 *
 * The coding worker has no persisted run of its own; its requests belong to
 * the run that delegated the task. Before each dispatch the coordinator
 * stages that run in the worker's object under the submission the dispatch
 * runs as (coding-worker-staging.ts), and this lookup reads it back for the
 * attempt's own submission. On a deployment serving many installations the
 * coordinator also stages the worker's version 2 binding, carrying the
 * credential its plan froze for the coding model; a worker without one
 * fails closed. The binding decides whose key is used, so a submission
 * dispatched before its run was staged (one Flue re-drives across a deploy)
 * still runs, under its own submission. Standalone binds the installation's
 * current keys.
 *
 * Routine intent has no dispatch site and no persisted run. Standalone keeps
 * today's live keys for it; a deployment serving many installations refuses
 * it outright, so a future dispatcher fails loudly instead of running on an
 * installation's current key. Such a dispatcher would persist the attempt's
 * plan, with its frozen credential and installation, before `init`, and this
 * lookup would read it by instance as it does for routine execution.
 */
import type { FlueExecutionContext } from '@flue/runtime';

import {
  CHICKPEA_CODING_WORKER_AGENT_NAME,
  CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME,
  CHICKPEA_ROUTINE_INTENT_AGENT_NAME,
  CHICKPEA_SLACK_AGENT_NAME,
} from './names.ts';
import {
  readStagedCodingWorkerBinding,
  readStagedCodingWorkerRun,
  type StagedCodingWorkerRun,
} from './coding-worker-staging.ts';
import { parseRoutineExecutionInitialData } from './routine-execution-data.ts';
import {
  assertRuntimePlanInstallation,
  type RuntimePlanModelCredentialV3,
  type RuntimePlanV2,
} from './runtime-plan.ts';
import { readStagedSlackTurnInput } from './turn-input.ts';
import {
  codingWorkerInstallationId,
  codingWorkerInstanceId,
  type CodingWorkerBinding,
} from '../sandbox/coding-worker-binding.ts';
import {
  frozenModelAccessGrant,
  installationModelAccessGrant,
  installationModelAccessGrants,
  modelAccessInstallationId,
  providerSetupRequired,
} from '../config/installation-model-access.ts';
import {
  assertInstallationOwnership,
  deploymentServesManyInstallations,
  type InstallationOwnership,
} from '../config/installation-scope.ts';
import {
  ModelAccessError,
  createModelAccessInterceptor,
  modelAccessProviderId,
  providerPrefix,
  type AttemptModelAccess,
} from '../config/model-access.ts';
import {
  getRoutineStore,
  getSlackStateStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { currentFlueObservationContext } from '../work/model-invocation.ts';

export const modelAccessInterceptor = createModelAccessInterceptor({
  lookup: (context) => lookupAttemptModelAccess(context),
  installationGrants: installationModelAccessGrants,
});

/**
 * `agentEnv`: the attempt's own env (the agent object's scoped env on
 * Cloudflare).
 */
export async function lookupAttemptModelAccess(
  context: FlueExecutionContext,
  agentEnv: () => Promise<PlatformEnv | undefined> = currentPlatformEnv,
  stagedCodingWorkerBinding: (instanceId: string) => Promise<CodingWorkerBinding | undefined> =
    readStagedCodingWorkerBinding,
  stagedCodingWorkerRun: (submissionId: string) => Promise<StagedCodingWorkerRun | undefined> =
    readStagedCodingWorkerRun,
): Promise<AttemptModelAccess> {
  const env = await agentEnv();
  const { instanceId, submissionId } = context;
  let plan: RuntimePlanV2 | undefined;
  switch (context.agentName) {
    case CHICKPEA_SLACK_AGENT_NAME:
      if (instanceId && submissionId) plan = await slackTurnPlan(instanceId, submissionId, env);
      break;
    case CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME:
      if (instanceId) plan = await routineOccurrencePlan(instanceId, env);
      break;
    case CHICKPEA_CODING_WORKER_AGENT_NAME: {
      const staged = submissionId ? await stagedCodingWorkerRun(submissionId) : undefined;
      if (!deploymentServesManyInstallations(env)) return staged ? { env, ...staged } : { env };
      if (!instanceId) break;
      const access = await codingWorkerModelAccess(
        await stagedCodingWorkerBinding(instanceId),
        instanceId,
        staged?.runId ?? submissionId ?? instanceId,
        env,
      );
      if (!staged) console.warn('[chickpea] coding worker submission has no staged run', { submissionId });
      return access;
    }
    case CHICKPEA_ROUTINE_INTENT_AGENT_NAME:
      if (deploymentServesManyInstallations(env)) {
        throw new ModelAccessError(
          'provider_not_offered',
          'Routine intent is not offered on a deployment serving many installations.',
        );
      }
      return { env };
    default:
      return { env };
  }
  if (!plan || !instanceId) {
    throw new ModelAccessError('scope_missing', 'No persisted run binds model access for this attempt.');
  }
  return planModelAccess(plan, instanceId, submissionId ?? instanceId, env);
}

/** A plan's frozen credential as a grant, or the installation's current one when it froze none. */
async function planModelAccess(
  plan: RuntimePlanV2,
  instanceId: string,
  runId: string,
  env: PlatformEnv | undefined,
): Promise<AttemptModelAccess> {
  // The plan, its instance and this env name the same installation (standalone: none).
  assertRuntimePlanInstallation(plan, instanceId);
  return runModelAccess(
    {
      installation: plan.installation,
      runtimeModel: plan.runtimeModel ?? plan.model,
      credential: plan.modelCredential,
      agentId: plan.agentId,
    },
    runId,
    env,
  );
}

/**
 * An installation's coding worker runs on the credential its coordinator's
 * plan froze for the coding model. Its binding, its instance's name and this
 * env name the same installation; a version 1 binding names none, so it
 * never runs for an installation of many.
 */
async function codingWorkerModelAccess(
  binding: CodingWorkerBinding | undefined,
  instanceId: string,
  runId: string,
  env: PlatformEnv | undefined,
): Promise<AttemptModelAccess> {
  if (!binding) {
    throw new ModelAccessError('scope_missing', 'No staged binding binds model access for this coding worker.');
  }
  if (binding.schemaVersion !== 2 || codingWorkerInstanceId(binding) !== instanceId) {
    throw new ModelAccessError('scope_missing', 'The coding worker binding does not bind this instance.');
  }
  if (codingWorkerInstallationId(instanceId) !== binding.installation.installationId) {
    throw new ModelAccessError('installation_mismatch', 'The coding worker binding belongs to another installation.');
  }
  return runModelAccess(
    {
      installation: binding.installation,
      runtimeModel: binding.codingModel.runtimeModel,
      credential: binding.modelCredential,
      agentId: binding.agentId,
    },
    runId,
    env,
  );
}

async function runModelAccess(
  run: {
    installation: InstallationOwnership | undefined;
    runtimeModel: string;
    credential: RuntimePlanModelCredentialV3 | undefined;
    agentId: string;
  },
  runId: string,
  env: PlatformEnv | undefined,
): Promise<AttemptModelAccess> {
  assertInstallationOwnership(run.installation, env);
  const providerId = modelAccessProviderId(providerPrefix(run.runtimeModel));
  if (!providerId) return { env, deploymentLane: true, agentId: run.agentId, runId };
  const credential = run.credential;
  if (credential && credential.providerId !== providerId) {
    throw new ModelAccessError(
      'provider_mismatch',
      `The run's frozen model credential is for provider ${credential.providerId}, not ${providerId}.`,
    );
  }
  const grant = credential
    ? frozenModelAccessGrant(credential, modelAccessInstallationId(env), runId)
    : await installationModelAccessGrant(providerId, env, runId);
  if (!grant) throw providerSetupRequired(providerId);
  return { env, grant, agentId: run.agentId, runId };
}

/** The plan the host staged for this attempt's TurnJob, as the turn's render reads it. */
async function slackTurnPlan(
  instanceId: string,
  submissionId: string,
  env: PlatformEnv | undefined,
): Promise<RuntimePlanV2 | undefined> {
  // Reuses the work interceptor's TurnJob match for this attempt.
  const observed = currentFlueObservationContext();
  const target = observed?.target && observed.instanceId === instanceId && observed.submissionId === submissionId
    ? observed.target
    : await getSlackStateStore(env).matchFlueObservation?.(instanceId, submissionId);
  if (!target) return undefined;
  const staged = readStagedSlackTurnInput(
    target.turnJobId,
    isCloudflareTarget() ? undefined : (turnJobId) => getSlackStateStore(env).readTurnInputJson?.(turnJobId),
  );
  return staged?.instanceId === instanceId ? staged.runtimePlan : undefined;
}

/** The plan in the running occurrence's persisted dispatch, validated as the agent validates it. */
async function routineOccurrencePlan(
  instanceId: string,
  env: PlatformEnv | undefined,
): Promise<RuntimePlanV2 | undefined> {
  const envelope = await getRoutineStore(env).findRunningAgentDispatch(instanceId);
  return envelope ? parseRoutineExecutionInitialData(envelope.initialData).runtimePlan : undefined;
}

async function currentPlatformEnv(): Promise<PlatformEnv | undefined> {
  if (!isCloudflareTarget()) return undefined;
  const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
  return getCloudflareContext().env as PlatformEnv;
}
