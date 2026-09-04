import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { ENVIRONMENT_PROTECTED_INVENTORY_SCHEMA } from './environment-preflight.mjs';
import { LIVE_MANIFEST } from '../../qa/live/manifest.ts';
import { diagnoseLiveTarget, parseDoctorSnapshot } from '../../qa/live/doctor.ts';
import {
  PHASE_ONE_SMOKE_VARIANTS,
  PHASE_ONE_TARGET_ALIASES,
} from '../../qa/live/schema.ts';

export const ENVIRONMENT_WORKSPACE_RECIPE_SCHEMA =
  'chickpea-environment-workspace-recipe/v2';
export const ENVIRONMENT_DESIRED_STATE_SCHEMA =
  'chickpea-environment-desired-state/v2';
export const ENVIRONMENT_BASELINE_PLAN_SCHEMA =
  'chickpea-environment-baseline-plan/v2';
export { ENVIRONMENT_PROTECTED_INVENTORY_SCHEMA };

const RECIPE_URL = new URL('../../config/environments/qa/workspace-recipe.json', import.meta.url);
const DESIRED_STATE_URL = new URL('../../config/environments/qa/desired-state.json', import.meta.url);
const PROVISIONABLE_FIXTURE_CLASSES = Object.freeze([
  'immutable_baseline',
  'resettable_fixture',
]);
const PHASE_ONE_RESOURCE_KEYS = Object.freeze([
  'primary-actor',
  'qa-channel',
  'smoke-agent',
  'connector-test-agent',
  'smoke-agent-channel-grant',
  'synthetic-google-account',
  'google-sheets-personal-standard',
]);
const PHASE_ONE_FIXTURE_SLOTS = Object.freeze([
  'owner',
  'member',
  'channel',
  'agent',
  'provider',
]);
const PHASE_ONE_HEALTH_CHECKS = Object.freeze([
  'actor-visible-in-workspace',
  'computer-use-profile-available',
  'channel-visible',
  'agent-resettable',
  'connector-agent-empty',
  'model-provider-ready',
  'agent-channel-grant-exact',
  'provider-account-readable',
  'google-sheets-binding-personal-standard',
]);
const ENVIRONMENT_ALIAS_FIELDS = Object.freeze([
  'worker',
  'workspace',
  'slack-app',
  'provider-project',
  'provider-auth-config',
  'evidence-root',
  'timezone',
  'auth-db',
  'tag-state',
]);
const PORTABILITY_FORBIDDEN_KEY = /(?:password|client[_-]?secret|signing[_-]?secret|access[_-]?token|refresh[_-]?token|credential|cookie|browser[_-]?(?:alias|profile)|email[_-]?address)/iu;
const SLACK_COORDINATE_VALUE = /\b[ETUWCBAX][A-Z0-9]{8,}\b/u;
const CREDENTIAL_OR_EMAIL_VALUE = /(?:\bxox[abprs]-[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{8,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;
const RECIPE_KEYS = Object.freeze(['schemaVersion', 'resources', 'slotBindings', 'variantSlotBindings', 'healthChecks']);
const VARIANT_SLOT_BINDINGS = Object.freeze({
  'LC04-V1-personal-read': Object.freeze({ agent: 'connector-test-agent' }),
});
const RESOURCE_KEYS = Object.freeze([
  'key', 'resourceKind', 'fixtureKind', 'fixtureClass', 'scope', 'ownership',
  'requiredBy', 'roles', 'privateRequirements', 'dependsOn', 'provider', 'toolkit',
  'ownerKind', 'access', 'exerciseAccess', 'capabilities', 'healthChecks',
]);
const RESOURCE_CHECKS = Object.freeze({
  'primary-actor': ['actor-visible-in-workspace', 'computer-use-profile-available'],
  'qa-channel': ['channel-visible'],
  'smoke-agent': ['agent-resettable', 'model-provider-ready'],
  'connector-test-agent': ['agent-resettable', 'connector-agent-empty', 'model-provider-ready'],
  'smoke-agent-channel-grant': ['agent-channel-grant-exact'],
  'synthetic-google-account': ['provider-account-readable'],
  'google-sheets-personal-standard': ['google-sheets-binding-personal-standard'],
});
const RESOURCE_ALIASES = Object.freeze({
  'primary-actor': ['actor-identity', 'computer-use-profile'],
  'qa-channel': ['channel-identity'],
  'smoke-agent': ['agent-identity', 'model-provider'],
  'connector-test-agent': ['connector-test-agent-identity', 'model-provider'],
  'smoke-agent-channel-grant': ['agent-channel-grant-identity'],
  'synthetic-google-account': ['synthetic-account-identity'],
  'google-sheets-personal-standard': ['sheets-binding-identity'],
});
const RESOURCE_DEPENDENCIES = Object.freeze({
  'smoke-agent-channel-grant': ['smoke-agent', 'qa-channel'],
  'google-sheets-personal-standard': ['smoke-agent', 'synthetic-google-account'],
});
const RESOURCE_CONTRACT = Object.freeze({
  'primary-actor': Object.freeze({ resourceKind: 'actor', fixtureKind: 'actor', fixtureClass: 'immutable_baseline', scope: 'shared' }),
  'qa-channel': Object.freeze({ resourceKind: 'slack_channel', fixtureKind: 'slack_channel', fixtureClass: 'immutable_baseline', scope: 'target' }),
  'smoke-agent': Object.freeze({ resourceKind: 'agent', fixtureKind: 'agent', fixtureClass: 'resettable_fixture', scope: 'target' }),
  'connector-test-agent': Object.freeze({ resourceKind: 'agent', fixtureKind: 'agent', fixtureClass: 'resettable_fixture', scope: 'target' }),
  'smoke-agent-channel-grant': Object.freeze({ resourceKind: 'agent_channel_grant', fixtureKind: undefined, fixtureClass: 'resettable_fixture', scope: 'target' }),
  'synthetic-google-account': Object.freeze({ resourceKind: 'provider_account', fixtureKind: 'provider_account', fixtureClass: 'immutable_baseline', scope: 'shared' }),
  'google-sheets-personal-standard': Object.freeze({ resourceKind: 'connection_binding', fixtureKind: undefined, fixtureClass: 'resettable_fixture', scope: 'target' }),
});

export class BaselineDefinitionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BaselineDefinitionError';
    this.code = code;
  }
}

export function loadPhaseOneBaselineDefinitions(options = {}) {
  const recipe = validateWorkspaceRecipe(readJson(options.recipeUrl ?? RECIPE_URL));
  const desiredState = validateDesiredState(readJson(options.desiredStateUrl ?? DESIRED_STATE_URL));
  return deepFreeze({ recipe, desiredState });
}

export function validateWorkspaceRecipe(input) {
  assertPortable(input);
  if (!isRecord(input)
    || !exactKeys(input, RECIPE_KEYS)
    || input.schemaVersion !== ENVIRONMENT_WORKSPACE_RECIPE_SCHEMA
    || !Array.isArray(input.resources)
    || input.resources.length === 0
    || !isRecord(input.slotBindings)
    || !sameStrings(input.healthChecks, PHASE_ONE_HEALTH_CHECKS)) {
    throw fail('INVALID_WORKSPACE_RECIPE');
  }

  const keys = new Set();
  for (const resource of input.resources) {
    if (!isRecord(resource)
      || !onlyKeys(resource, RESOURCE_KEYS)
      || !portableKey(resource.key)
      || !portableKey(resource.resourceKind)
      || !['shared', 'target'].includes(resource.scope)
      || resource.ownership !== 'product'
      || !stringArray(resource.requiredBy)
      || resource.requiredBy.length === 0
      || new Set(resource.requiredBy).size !== resource.requiredBy.length) {
      throw fail('INVALID_WORKSPACE_RECIPE');
    }
    if (!PROVISIONABLE_FIXTURE_CLASSES.includes(resource.fixtureClass)) {
      throw fail('UNSUPPORTED_FIXTURE_CLASS');
    }
    if (keys.has(resource.key)) throw fail('DUPLICATE_RESOURCE_KEY');
    keys.add(resource.key);
    if (resource.requiredBy.some((variantId) => !PHASE_ONE_SMOKE_VARIANTS.includes(variantId))) {
      throw fail('VARIANT_NOT_PHASE_ONE');
    }
    if (resource.fixtureKind !== undefined && !portableKey(resource.fixtureKind)) {
      throw fail('INVALID_WORKSPACE_RECIPE');
    }
    for (const field of ['roles', 'privateRequirements', 'capabilities']) {
      if (resource[field] !== undefined
        && (!stringArray(resource[field])
          || new Set(resource[field]).size !== resource[field].length)) {
        throw fail('INVALID_WORKSPACE_RECIPE');
      }
    }
    if (resource.dependsOn !== undefined
      && (!stringArray(resource.dependsOn)
        || resource.dependsOn.length === 0
        || new Set(resource.dependsOn).size !== resource.dependsOn.length)) {
      throw fail('INVALID_WORKSPACE_RECIPE');
    }
    for (const field of ['provider', 'toolkit', 'ownerKind', 'access', 'exerciseAccess']) {
      if (resource[field] !== undefined && !portableKey(resource[field])) {
        throw fail('INVALID_WORKSPACE_RECIPE');
      }
    }
    const expected = RESOURCE_CONTRACT[resource.key];
    if (!expected
      || resource.resourceKind !== expected.resourceKind
      || resource.fixtureKind !== expected.fixtureKind
      || resource.fixtureClass !== expected.fixtureClass
      || resource.scope !== expected.scope
      || !sameStrings(resource.privateRequirements, RESOURCE_ALIASES[resource.key])
      || !sameStrings(resource.healthChecks, RESOURCE_CHECKS[resource.key])) {
      throw fail('INVALID_RESOURCE_CONTRACT');
    }
  }
  if (!sameSet([...keys], PHASE_ONE_RESOURCE_KEYS)) {
    throw fail('INVALID_RESOURCE_SET');
  }
  for (const resource of input.resources) {
    if ((resource.dependsOn ?? []).some((key) => !keys.has(key))) {
      throw fail('UNKNOWN_RESOURCE_DEPENDENCY');
    }
    if (!sameStrings(resource.dependsOn ?? [], RESOURCE_DEPENDENCIES[resource.key] ?? [])) {
      throw fail('INVALID_RESOURCE_DEPENDENCY');
    }
  }
  for (const [slot, resourceKey] of Object.entries(input.slotBindings)) {
    if (!portableKey(slot) || !portableKey(resourceKey) || !keys.has(resourceKey)) {
      throw fail('INVALID_SLOT_BINDING');
    }
  }
  if (!sameSet(Object.keys(input.slotBindings), PHASE_ONE_FIXTURE_SLOTS)) {
    throw fail('INVALID_SLOT_BINDING');
  }
  if (!isDeepStrictEqual(input.variantSlotBindings, VARIANT_SLOT_BINDINGS)) {
    throw fail('INVALID_SLOT_BINDING');
  }
  const actor = input.resources.find(({ key }) => key === 'primary-actor');
  const provider = input.resources.find(({ key }) => key === 'synthetic-google-account');
  const sheets = input.resources.find(({ key }) => key === 'google-sheets-personal-standard');
  if (!sameStrings(actor?.roles, ['owner', 'member'])
    || provider?.provider !== 'google'
    || sheets?.provider !== 'google'
    || sheets?.toolkit !== 'googlesheets'
    || sheets?.ownerKind !== 'personal'
    || sheets?.access !== 'write'
    || sheets?.exerciseAccess !== 'read'
    || !sameStrings(sheets?.capabilities, [
      'sheets.spreadsheets.search',
      'sheets.spreadsheets.metadata',
      'sheets.values.get',
      'sheets.tables.query',
      'sheets.spreadsheets.create',
      'sheets.values.update',
      'sheets.values.append',
      'sheets.rows.upsert',
      'sheets.sheets.add',
    ])) {
    throw fail('INVALID_RESOURCE_CONTRACT');
  }
  return input;
}

export function validateDesiredState(input) {
  assertPortable(input);
  if (!isRecord(input)
    || !exactKeys(input, ['schemaVersion', 'targets'])
    || input.schemaVersion !== ENVIRONMENT_DESIRED_STATE_SCHEMA
    || !Array.isArray(input.targets)) {
    throw fail('INVALID_DESIRED_STATE');
  }
  const targetNames = input.targets.map((target) => target?.targetAlias);
  if (targetNames.length !== PHASE_ONE_TARGET_ALIASES.length
    || new Set(targetNames).size !== PHASE_ONE_TARGET_ALIASES.length
    || PHASE_ONE_TARGET_ALIASES.some((target) => !targetNames.includes(target))) {
    throw fail('INVALID_TARGET_SET');
  }

  for (const target of input.targets) {
    if (!isRecord(target)
      || !exactKeys(target, [
        'targetAlias', 'allowedSuites', 'smokeVariants', 'requiredEnvironmentAliases',
      ])
      || !PHASE_ONE_TARGET_ALIASES.includes(target.targetAlias)
      || !sameStrings(target.allowedSuites, ['case', 'smoke'])
      || !sameStrings(target.smokeVariants, PHASE_ONE_SMOKE_VARIANTS)
      || !stringArray(target.requiredEnvironmentAliases)) {
      throw fail('INVALID_DESIRED_STATE');
    }
    const expectedAliases = ENVIRONMENT_ALIAS_FIELDS.map((field) =>
      `env-${target.targetAlias}-${field}`);
    for (const alias of target.requiredEnvironmentAliases) {
      if (!expectedAliases.includes(alias)) {
        throw fail('UNKNOWN_ENVIRONMENT_ALIAS');
      }
    }
    if (!sameStrings(target.requiredEnvironmentAliases, expectedAliases)) {
      throw fail('INVALID_DESIRED_STATE');
    }
  }
  return input;
}

export function createPhaseOneBaselinePlan(target, options = {}) {
  if (!PHASE_ONE_TARGET_ALIASES.includes(target)) throw fail('INVALID_TARGET');
  const { recipe, desiredState } = loadPhaseOneBaselineDefinitions();
  const targetState = desiredState.targets.find((candidate) => candidate.targetAlias === target);
  if (!targetState) throw fail('INVALID_TARGET_SET');

  const allVariants = variantIndex(LIVE_MANIFEST);
  const selectedVariantIds = options.variantIds === undefined
    ? [...targetState.smokeVariants]
    : validateVariantSelection(options.variantIds, allVariants);
  for (const variantId of selectedVariantIds) {
    if (!targetState.smokeVariants.includes(variantId)) {
      throw fail('VARIANT_NOT_PHASE_ONE');
    }
  }
  if (!sameStrings(selectedVariantIds, PHASE_ONE_SMOKE_VARIANTS)) {
    throw fail('SMOKE_INVENTORY_MISMATCH');
  }

  const resourcesByKey = new Map(recipe.resources.map((resource) => [resource.key, resource]));
  const requiredResourceKeys = new Set();
  const variantFixtureBindings = {};
  for (const variantId of selectedVariantIds) {
    const variant = allVariants.get(variantId);
    if (!variant) throw fail('INVALID_VERIFIER_MANIFEST');
    const bindings = variant.fixtures.map((fixture) => {
      if (!PROVISIONABLE_FIXTURE_CLASSES.includes(fixture.fixtureClass)) {
        throw fail('UNSUPPORTED_FIXTURE_CLASS');
      }
      const resourceKey = recipe.variantSlotBindings[variantId]?.[fixture.slot] ?? recipe.slotBindings[fixture.slot];
      const resource = resourcesByKey.get(resourceKey);
      if (!resource
        || !resource.requiredBy.includes(variantId)
        || resource.fixtureKind !== fixture.kind
        || resource.fixtureClass !== fixture.fixtureClass) {
        throw fail('FIXTURE_BINDING_MISMATCH');
      }
      requiredResourceKeys.add(resourceKey);
      return Object.freeze({ ...fixture, resourceKey });
    });
    variantFixtureBindings[variantId] = Object.freeze(bindings);
  }
  for (const resource of recipe.resources) {
    if (resource.requiredBy.some((variantId) => selectedVariantIds.includes(variantId))) {
      requiredResourceKeys.add(resource.key);
    }
  }

  const resources = recipe.resources
    .filter((resource) => requiredResourceKeys.has(resource.key))
    .map((resource) => deepFreeze({ ...resource }));
  return deepFreeze({
    schemaVersion: ENVIRONMENT_BASELINE_PLAN_SCHEMA,
    target,
    allowedSuites: [...targetState.allowedSuites],
    smokeVariants: selectedVariantIds,
    requiredEnvironmentAliases: [...new Set([
      ...targetState.requiredEnvironmentAliases,
      ...resources.flatMap(({ privateRequirements }) => privateRequirements.map((field) =>
        `env-${target}-${field}`)),
    ])],
    resources,
    variantFixtureBindings,
    healthChecks: [...recipe.healthChecks],
  });
}

/** Read-only drift inspection. Resolved values and observer errors are never returned. */
export async function inspectPhaseOneBaseline(plan, readers = {}) {
  validateGeneratedPlan(plan);
  if (typeof readers.resolveAlias !== 'function' || typeof readers.observeResource !== 'function') {
    throw fail('READ_ONLY_INSPECTION_REQUIRED');
  }
  const missingPrerequisites = [];
  const drift = [];
  let resolvedAliasCount = 0;

  for (const alias of plan.requiredEnvironmentAliases) {
    try {
      const value = await readers.resolveAlias(alias);
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error('missing');
      resolvedAliasCount += 1;
    } catch {
      missingPrerequisites.push(Object.freeze({ kind: 'alias', key: alias }));
    }
  }
  for (const resource of plan.resources) {
    let observation;
    try {
      observation = await readers.observeResource(readOnlyResourceRequest(plan.target, resource));
    } catch {
      observation = null;
    }
    if (!isRecord(observation) || observation.key !== resource.key
      || observation.target !== plan.target) {
      missingPrerequisites.push(Object.freeze({ kind: 'resource', key: resource.key }));
      continue;
    }
    const checksPass = isRecord(observation.checks)
      && exactKeys(observation.checks, resource.healthChecks)
      && resource.healthChecks.every((check) => observation.checks[check] === true);
    if (observation.state !== 'ready' || !checksPass) {
      drift.push(Object.freeze({
        key: resource.key,
        state: observation.state === 'drifted' ? 'drifted' : 'unavailable',
      }));
    }
  }

  return deepFreeze({
    schemaVersion: 'chickpea-environment-baseline-inspection/v1',
    target: plan.target,
    ready: missingPrerequisites.length === 0 && drift.length === 0,
    resolvedAliasCount,
    missingPrerequisites,
    drift,
  });
}

/** Baseline prerequisites can block doctor readiness but never create product verdicts. */
export function diagnosePhaseOneBaseline(plan, report, snapshotInput) {
  describePhaseOneBaselineDryRun(plan, report);
  const snapshot = parseDoctorSnapshot(snapshotInput);
  const missingActors = report.missingPrerequisites
    .filter(({ key }) => key === 'primary-actor'
      || key === `env-${plan.target}-actor-identity`
      || key === `env-${plan.target}-computer-use-profile`)
    .map(({ key }) => key);
  if (report.drift.some(({ key }) => key === 'primary-actor')) missingActors.push('primary-actor');
  return diagnoseLiveTarget({
    policy: { targetAlias: plan.target, allowedSuites: plan.allowedSuites, allowedVariants: plan.smokeVariants },
    suite: 'smoke',
    source: { read: () => ({
      ...snapshot,
      targetMatches: snapshot.targetMatches && report.ready,
      missingActorAliases: [...new Set([...snapshot.missingActorAliases, ...missingActors])],
    }) },
  });
}

export function describePhaseOneBaselineDryRun(plan, report) {
  validateGeneratedPlan(plan);
  const resourceKeys = new Set(plan.resources.map(({ key }) => key));
  const missingKeys = Array.isArray(report?.missingPrerequisites)
    ? report.missingPrerequisites.map((item) => `${item?.kind}:${item?.key}`)
    : [];
  const driftKeys = Array.isArray(report?.drift)
    ? report.drift.map((item) => item?.key)
    : [];
  const missingAliasCount = Array.isArray(report?.missingPrerequisites)
    ? report.missingPrerequisites.filter((item) => item?.kind === 'alias').length
    : 0;
  if (!isRecord(report)
    || report.schemaVersion !== 'chickpea-environment-baseline-inspection/v1'
    || report.target !== plan.target
    || typeof report.ready !== 'boolean'
    || !Number.isSafeInteger(report.resolvedAliasCount)
    || report.resolvedAliasCount < 0
    || report.resolvedAliasCount > plan.requiredEnvironmentAliases.length
    || !Array.isArray(report.missingPrerequisites)
    || report.missingPrerequisites.some((item) => !isRecord(item)
      || !['alias', 'resource'].includes(item.kind)
      || typeof item.key !== 'string'
      || (item.kind === 'alias' && !plan.requiredEnvironmentAliases.includes(item.key))
      || (item.kind === 'resource' && !resourceKeys.has(item.key)))
    || !Array.isArray(report.drift)
    || report.drift.some((item) => !isRecord(item)
      || !resourceKeys.has(item.key)
      || !['drifted', 'unavailable'].includes(item.state))
    || new Set(missingKeys).size !== missingKeys.length
    || new Set(driftKeys).size !== driftKeys.length
    || report.resolvedAliasCount + missingAliasCount !== plan.requiredEnvironmentAliases.length
    || report.missingPrerequisites.some((item) => item.kind === 'resource'
      && driftKeys.includes(item.key))
    || report.ready !== (report.missingPrerequisites.length === 0 && report.drift.length === 0)) {
    throw fail('INVALID_INSPECTION_REPORT');
  }
  const lines = [
    `${plan.target}: baseline ${report.ready ? 'ready' : 'not ready'}`,
    `smoke variants: ${plan.smokeVariants.join(', ')}`,
  ];
  for (const item of report.missingPrerequisites) {
    lines.push(`missing ${item.kind} ${item.key}`);
  }
  for (const item of report.drift) lines.push(`drift ${item.key}: ${item.state}`);
  return `${lines.join('\n')}\n`;
}

/** U4 owns product fixtures only, so none are eligible for infrastructure cleanup. */
export function projectInfrastructureCleanup(plan) {
  validateGeneratedPlan(plan);
  return Object.freeze([]);
}

export function projectProtectedProductInventory(plan, resolvedIds) {
  validateGeneratedPlan(plan);
  if (!isRecord(resolvedIds)) throw fail('INVALID_RESOURCE_RESOLUTION');
  const protectedResources = plan.resources.map(({ key, resourceKind, fixtureClass }) => {
    const id = resolvedIds[key];
    if (typeof id !== 'string' || id.length === 0) {
      throw fail('MISSING_RESOURCE_ID');
    }
    if (id.length > 512 || /[\s*?\[\]]/u.test(id) || CREDENTIAL_OR_EMAIL_VALUE.test(id)) {
      throw fail('INVALID_RESOURCE_ID');
    }
    const provider = ['actor', 'slack_channel'].includes(resourceKind)
      ? 'slack' : resourceKind === 'provider_account' ? 'google' : 'chickpea';
    return Object.freeze({ fixtureClass, provider, kind: resourceKind, id });
  });
  return deepFreeze({
    schemaVersion: ENVIRONMENT_PROTECTED_INVENTORY_SCHEMA,
    target: plan.target,
    baseline: protectedResources
      .filter(({ fixtureClass }) => fixtureClass === 'immutable_baseline')
      .map(withoutFixtureClass),
    productOwned: protectedResources
      .filter(({ fixtureClass }) => fixtureClass === 'resettable_fixture')
      .map(withoutFixtureClass),
  });
}

function validateGeneratedPlan(plan) {
  if (!isRecord(plan) || !PHASE_ONE_TARGET_ALIASES.includes(plan.target)
    || !isDeepStrictEqual(plan, createPhaseOneBaselinePlan(plan.target))) {
    throw fail('INVALID_BASELINE_PLAN');
  }
  return plan;
}

function validateVariantSelection(input, allVariants) {
  if (!stringArray(input) || input.length === 0 || new Set(input).size !== input.length) {
    throw fail('INVALID_VARIANT_SELECTION');
  }
  for (const variantId of input) {
    if (!allVariants.has(variantId)) throw fail('UNKNOWN_VARIANT');
  }
  return [...input];
}

function variantIndex(manifest) {
  if (!isRecord(manifest) || !Array.isArray(manifest.contracts)) {
    throw fail('INVALID_VERIFIER_MANIFEST');
  }
  const variants = new Map();
  for (const contract of manifest.contracts) {
    if (!isRecord(contract) || !Array.isArray(contract.variants)) {
      throw fail('INVALID_VERIFIER_MANIFEST');
    }
    for (const variant of contract.variants) {
      if (!isRecord(variant)
        || typeof variant.id !== 'string'
        || !Array.isArray(variant.fixtures)
        || variant.fixtures.some((fixture) => !isRecord(fixture)
          || typeof fixture.slot !== 'string'
          || typeof fixture.kind !== 'string'
          || typeof fixture.fixtureClass !== 'string')
        || variants.has(variant.id)) {
        throw fail('INVALID_VERIFIER_MANIFEST');
      }
      variants.set(variant.id, variant);
    }
  }
  return variants;
}

function readOnlyResourceRequest(target, resource) {
  return deepFreeze({
    ...resource,
    target,
    privateAliases: resource.privateRequirements.map((field) => `env-${target}-${field}`),
  });
}

function withoutFixtureClass({ fixtureClass: _fixtureClass, ...resource }) {
  return Object.freeze(resource);
}

function assertPortable(value) {
  if (Array.isArray(value)) {
    value.forEach((item) => assertPortable(item));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === 'string'
      && (SLACK_COORDINATE_VALUE.test(value) || CREDENTIAL_OR_EMAIL_VALUE.test(value))) {
      throw fail('PRIVATE_VALUE_IN_DEFINITION');
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (PORTABILITY_FORBIDDEN_KEY.test(key)) {
      throw fail('PRIVATE_FIELD_IN_DEFINITION');
    }
    assertPortable(item);
  }
}

function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    throw fail('BASELINE_DEFINITION_UNAVAILABLE');
  }
}

function sameStrings(input, expected) {
  return stringArray(input)
    && input.length === expected.length
    && input.every((value, index) => value === expected[index]);
}

function sameSet(input, expected) {
  return input.length === expected.length
    && new Set(input).size === expected.length
    && expected.every((value) => input.includes(value));
}

function stringArray(input) {
  return Array.isArray(input) && input.every((value) => typeof value === 'string' && value.length > 0);
}

function portableKey(input) {
  return typeof input === 'string' && /^[a-z][a-z0-9_-]{0,95}$/u.test(input);
}

function isRecord(input) {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function onlyKeys(input, allowed) {
  const accepted = new Set(allowed);
  return Object.keys(input).every((key) => accepted.has(key));
}

function exactKeys(input, expected) {
  return Object.keys(input).length === expected.length && onlyKeys(input, expected);
}

function deepFreeze(input) {
  if (!input || typeof input !== 'object' || Object.isFrozen(input)) return input;
  Object.freeze(input);
  for (const value of Object.values(input)) deepFreeze(value);
  return input;
}

function fail(code) {
  return new BaselineDefinitionError(code);
}
