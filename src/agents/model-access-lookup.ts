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
 * before it starts, so a miss means the lookup broke or the run settled. The
 * coding worker has no persisted run of its own here. Standalone binds the
 * installation's current keys for it (today's live read); a deployment
 * serving many installations does not run coding workers.
 */
import type { FlueExecutionContext } from '@flue/runtime';

import { CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME, CHICKPEA_SLACK_AGENT_NAME } from './names.ts';
import { parseRoutineExecutionInitialData } from './routine-execution-data.ts';
import { assertRuntimePlanInstallation, type RuntimePlanV2 } from './runtime-plan.ts';
import { readStagedSlackTurnInput } from './turn-input.ts';
import {
  frozenModelAccessGrant,
  installationModelAccessGrant,
  installationModelAccessGrants,
  modelAccessInstallationId,
  providerSetupRequired,
} from '../config/installation-model-access.ts';
import { assertInstallationOwnership } from '../config/installation-scope.ts';
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

/** `agentEnv`: the attempt's own env (the agent object's scoped env on Cloudflare). */
export async function lookupAttemptModelAccess(
  context: FlueExecutionContext,
  agentEnv: () => Promise<PlatformEnv | undefined> = currentPlatformEnv,
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
  assertInstallationOwnership(plan.installation, env);
  const providerId = modelAccessProviderId(providerPrefix(plan.runtimeModel ?? plan.model));
  if (!providerId) return { env, deploymentLane: true };
  const credential = plan.modelCredential;
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
  return { env, grant };
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
