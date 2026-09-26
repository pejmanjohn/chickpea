import { createHash } from 'node:crypto';

import type { AdmittedRuntimePlanData, RuntimePlanV2 } from '../../src/agents/runtime-plan.ts';

/**
 * The plan as v0.1.26 and earlier admitted it with an attached container:
 * `sandbox.mode: 'cloudflare'`, no coding-workspace capability, and that
 * release's harness revision. Mirrors v0.1.26 `computeHarnessRevision`; the
 * runtime-plan suite checks it against a plan that release compiled
 * (`fixtures/runtime-plan/v0.1.26-attached-container.json`).
 */
export function attachedContainerPlan(plan: RuntimePlanV2): AdmittedRuntimePlanData {
  const admitted: AdmittedRuntimePlanData = structuredClone(plan);
  delete admitted.codingWorkspace;
  admitted.sandbox = { mode: 'cloudflare' };
  admitted.harnessRevision = v0126HarnessRevision(admitted);
  return admitted;
}

function v0126HarnessRevision(plan: AdmittedRuntimePlanData): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: plan.schemaVersion,
    continuityPolicy: plan.continuityPolicy,
    agentId: plan.agentId,
    ...(plan.actorMembershipId ? { actorMembershipId: plan.actorMembershipId } : {}),
    ...(plan.connectionAccountIds !== undefined ? { connectionAccountIds: plan.connectionAccountIds } : {}),
    ...(plan.connectionSelections !== undefined ? { connectionSelections: plan.connectionSelections } : {}),
    ...(plan.connectionAuthorizations !== undefined
      ? { connectionAuthorizations: plan.connectionAuthorizations }
      : {}),
    ...(plan.connectionChoices !== undefined ? { connectionChoices: plan.connectionChoices } : {}),
    ...(plan.configurationRevision ? { configurationRevision: plan.configurationRevision } : {}),
    ...(plan.ownerIncarnation ? { ownerIncarnation: plan.ownerIncarnation } : {}),
    ...(plan.handoffContext?.length ? { handoffContext: plan.handoffContext } : {}),
    ...(plan.runtimeModel ? { runtimeModel: plan.runtimeModel } : {}),
    ...(plan.runtimeModelRoute ? { runtimeModelRoute: plan.runtimeModelRoute } : {}),
    model: plan.model,
    ...(plan.imageCapability ? { imageCapability: plan.imageCapability } : {}),
    ...(plan.browserCapability ? { browserCapability: plan.browserCapability } : {}),
    ...(plan.websiteLogins ? { websiteLogins: plan.websiteLogins } : {}),
    ...(plan.modelAttribution ? { modelAttribution: plan.modelAttribution } : {}),
    ...(plan.modelCredential ? { modelCredential: plan.modelCredential } : {}),
    instructions: plan.instructions,
    memoryEpoch: plan.memoryEpoch,
    skills: plan.skills,
    mcpConnections: plan.mcpConnections,
    apiConnections: plan.apiConnections,
    ...(plan.managedConnections !== undefined ? { managedConnections: plan.managedConnections } : {}),
    repositories: plan.repositories,
    sandbox: plan.sandbox,
    artifactDestinationKind: plan.artifactDestination.kind,
  })).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
