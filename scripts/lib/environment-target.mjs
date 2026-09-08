import {
  validateCloudflareDeploymentTargetIdentity,
} from '../cloudflare-deployment-profile.mjs';
import { LIVE_MANIFEST, validateTargetSuitePolicy } from '../../qa/live/manifest.ts';
import { validateTargetOverlay } from '../../qa/live/privacy.ts';
import { createPhaseOneBaselinePlan } from './environment-baseline.mjs';
import { validatePrivateConfig } from '../../qa/live/private-config.ts';
import {
  EnvironmentRegistryError,
  activeEnvironmentTargets,
  assertLiveEnvironmentClaim,
} from './environment-registry.mjs';

export const LIVE_TARGET_SCHEMA = 'chickpea-live-target/v1';

export function targetEnvironment(target, options = {}) {
  const { registry, registration } = assertLiveEnvironmentClaim(target, options);
  return createVerifierTargetInputs(target, registration, Object.values(registry.targets));
}

export function createVerifierTargetInputs(target, registration, registrations = [registration]) {
  if (!activeEnvironmentTargets.includes(target)) {
    throw new EnvironmentRegistryError('INACTIVE_TARGET');
  }
  if (registration?.target !== target || registration?.role !== 'branch') {
    throw new EnvironmentRegistryError('INVALID_TARGET_ROLE');
  }
  validateCloudflareDeploymentTargetIdentity(
    deploymentIdentity(registration),
    registrations.map(deploymentIdentity),
  );
  const baseline = createPhaseOneBaselinePlan(target);
  const allowedVariants = [...baseline.smokeVariants];
  const policy = validateTargetSuitePolicy({
    targetAlias: target,
    allowedSuites: ['case', 'smoke'],
    allowedVariants,
  });
  const aliases = aliasesFor(target);
  const sharedTarget = Object.freeze({
    targetAlias: target,
    transport: registration.transport,
    workerAlias: aliases.worker,
    workspaceAlias: aliases.workspace,
    slackAppAlias: aliases.slackApp,
    providerProjectAlias: aliases.providerProject,
    evidenceRootAlias: aliases.evidenceRoot,
    allowedSuites: policy.allowedSuites,
    allowedVariants: policy.allowedVariants,
  });
  const fixtureResourceKeys = new Set(Object.values(baseline.variantFixtureBindings)
    .flatMap((requirements) => requirements.map(({ resourceKey }) => resourceKey)));
  const fixtures = Object.fromEntries(baseline.resources
    .filter(({ key }) => fixtureResourceKeys.has(key)).map((resource) => [
    `env-${target}-${resource.key}`,
    { kind: resource.fixtureKind, resourceAlias: `env-${target}-${resource.key}` },
    ]));
  const bindings = Object.fromEntries(Object.entries(baseline.variantFixtureBindings)
    .map(([variantId, requirements]) => [variantId, { fixtures: Object.fromEntries(
      requirements.map(({ slot, resourceKey }) => [slot, `env-${target}-${resourceKey}`]),
    ) }]));
  const targetOverlay = Object.freeze(validateTargetOverlay(LIVE_MANIFEST, {
    schemaVersion: LIVE_TARGET_SCHEMA,
    ...sharedTarget,
    fixtures,
    bindings,
  }));
  const privateTarget = Object.freeze({
    ...sharedTarget,
    timezoneAlias: aliases.timezone,
    providerAuthConfigAlias: aliases.providerAuthConfig,
    bindingAliases: Object.freeze({
      AUTH_DB: aliases.authDb,
      TAG_STATE: aliases.tagState,
    }),
  });
  const privateConfig = Object.freeze({
    schemaVersion: 'chickpea-live-private-config/v2',
    qaTargetAllowlist: Object.freeze([target]),
    targets: Object.freeze({ [target]: privateTarget }),
  });
  validatePrivateConfig(privateConfig);
  return Object.freeze({ targetOverlay, privateConfig });
}

function aliasesFor(target) {
  return Object.freeze({
    worker: `env-${target}-worker`,
    workspace: `env-${target}-workspace`,
    slackApp: `env-${target}-slack-app`,
    providerProject: `env-${target}-provider-project`,
    evidenceRoot: `env-${target}-evidence-root`,
    timezone: `env-${target}-timezone`,
    providerAuthConfig: `env-${target}-provider-auth-config`,
    authDb: `env-${target}-auth-db`,
    tagState: `env-${target}-tag-state`,
  });
}

function deploymentIdentity(registration) {
  return {
    target: registration.target,
    workerName: registration.workerName,
    authDatabaseBinding: registration.authDatabaseBinding,
    authDatabaseName: registration.authDatabaseName,
    authDatabaseId: registration.authDatabaseId,
  };
}
