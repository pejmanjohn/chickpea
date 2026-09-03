import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from '../qa/live/manifest.ts';
import {
  PHASE_ONE_SMOKE_VARIANTS,
  PHASE_ONE_TARGET_ALIASES,
} from '../qa/live/schema.ts';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import * as baselineModule from '../scripts/lib/environment-baseline.mjs';

const {
  BaselineDefinitionError,
  createPhaseOneBaselinePlan,
  describePhaseOneBaselineDryRun,
  diagnosePhaseOneBaseline,
  inspectPhaseOneBaseline,
  loadPhaseOneBaselineDefinitions,
  projectInfrastructureCleanup,
  projectProtectedProductInventory,
  validateDesiredState,
  validateWorkspaceRecipe,
} = baselineModule;

const RECIPE_PATH = new URL('../config/environments/qa/workspace-recipe.json', import.meta.url);
const DESIRED_STATE_PATH = new URL('../config/environments/qa/desired-state.json', import.meta.url);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rejects(code: string) {
  return (error: unknown) => error instanceof BaselineDefinitionError
    && (error as { code?: string }).code === code;
}

interface BaselineResource {
  key: string;
  resourceKind: string;
  scope: string;
  fixtureClass: string;
  capabilities?: string[];
  ownerKind?: string;
}

interface BaselineBinding {
  fixtureClass: string;
  kind: string;
  slot: string;
}

function healthyResource(request: { target: string; key: string; healthChecks: string[] }) {
  return {
    target: request.target, key: request.key, state: 'ready',
    checks: Object.fromEntries(request.healthChecks.map((key) => [key, true])),
  };
}
function inventoryProvider(kind: string) {
  return ['actor', 'slack_channel'].includes(kind) ? 'slack'
    : kind === 'provider_account' ? 'google' : 'chickpea';
}

test('portable baseline definitions contain no credentials or Slack coordinates', () => {
  const { recipe, desiredState } = loadPhaseOneBaselineDefinitions();
  assert.equal(recipe.schemaVersion, 'chickpea-environment-workspace-recipe/v1');
  assert.equal(desiredState.schemaVersion, 'chickpea-environment-desired-state/v1');

  const serialized = [RECIPE_PATH, DESIRED_STATE_PATH]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(serialized, /\b(?:xox[abprs]-|sk-|AKIA)[A-Za-z0-9_-]+/u);
  assert.doesNotMatch(serialized, /\bT[A-Z0-9]{8,}\b/u);
  assert.doesNotMatch(serialized, /\b(?:U|B|A)[A-Z0-9]{8,}\b/u);
  assert.doesNotMatch(serialized, /(?:password|clientSecret|signingSecret|accessToken|refreshToken|browserAlias|emailAddress)\s*"?\s*:/iu);
});

test('both active targets derive exactly the Phase 1 smoke inventory and reusable fixtures', () => {
  const manifestVariants = new Map(LIVE_MANIFEST.contracts.flatMap((contract) =>
    contract.variants.map((variant) => [variant.id, variant] as const)));

  for (const target of PHASE_ONE_TARGET_ALIASES) {
    const plan = createPhaseOneBaselinePlan(target);
    assert.deepEqual(plan.allowedSuites, ['case', 'smoke']);
    assert.deepEqual(plan.smokeVariants, [...PHASE_ONE_SMOKE_VARIANTS]);
    assert.deepEqual(Object.keys(plan.variantFixtureBindings), [...PHASE_ONE_SMOKE_VARIANTS]);
    assert.equal(plan.resources.every(({ fixtureClass }: BaselineResource) =>
      fixtureClass === 'immutable_baseline' || fixtureClass === 'resettable_fixture'), true);
    assert.deepEqual(
      plan.variantFixtureBindings['LC01-V1-create-welcome'].map(({ slot }: BaselineBinding) => slot),
      ['channel', 'owner'],
    );
    assert.deepEqual(
      plan.variantFixtureBindings['LC04-V1-personal-read'].map(({ slot }: BaselineBinding) => slot),
      ['agent', 'member', 'provider'],
    );
    for (const variantId of plan.smokeVariants) {
      assert.deepEqual(
        plan.variantFixtureBindings[variantId].map(({ fixtureClass, kind, slot }: BaselineBinding) =>
          ({ fixtureClass, kind, slot })),
        manifestVariants.get(variantId)?.fixtures,
      );
    }
  }
});

test('the minimal recipe keeps identities private and target product state local', () => {
  const amber = createPhaseOneBaselinePlan('amber');
  assert.deepEqual(
    amber.resources.map(({ key, scope, fixtureClass }: BaselineResource) => ({ key, scope, fixtureClass })),
    [
      { key: 'primary-actor', scope: 'shared', fixtureClass: 'immutable_baseline' },
      { key: 'qa-channel', scope: 'target', fixtureClass: 'immutable_baseline' },
      { key: 'smoke-agent', scope: 'target', fixtureClass: 'resettable_fixture' },
      { key: 'smoke-agent-channel-grant', scope: 'target', fixtureClass: 'resettable_fixture' },
      { key: 'synthetic-google-account', scope: 'shared', fixtureClass: 'immutable_baseline' },
      { key: 'google-sheets-personal-read-only', scope: 'target', fixtureClass: 'resettable_fixture' },
    ],
  );
  const sheets = amber.resources.find(({ key }: BaselineResource) => key === 'google-sheets-personal-read-only');
  assert.deepEqual(sheets?.capabilities, [
    'sheets.spreadsheets.search',
    'sheets.spreadsheets.metadata',
    'sheets.values.get',
    'sheets.tables.query',
  ]);
  assert.equal(sheets?.ownerKind, 'personal');
  assert.equal(JSON.stringify(amber).includes('browserAlias'), false);
  assert.equal(JSON.stringify(amber).includes('emailAddress'), false);
});

test('fresh-target inspection reports missing aliases and resources without returning values', async () => {
  const secretValue = 'T_PRIVATE_WORKSPACE_VALUE';
  const plan = createPhaseOneBaselinePlan('amber');
  const report = await inspectPhaseOneBaseline(plan, {
    resolveAlias: async (alias: string) => {
      if (alias.endsWith('-workspace')) return secretValue;
      throw new Error('not provisioned');
    },
    observeResource: async () => null,
  });

  assert.equal(report.ready, false);
  assert.equal(report.resolvedAliasCount, 1);
  assert.equal(report.missingPrerequisites.some(({ kind }: { kind: string }) => kind === 'alias'), true);
  assert.equal(report.missingPrerequisites.some(({ kind }: { kind: string }) => kind === 'resource'), true);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secretValue));
  assert.match(describePhaseOneBaselineDryRun(plan, report), /amber: baseline not ready/u);
  assert.match(describePhaseOneBaselineDryRun(plan, report), /missing alias env-amber-/u);
  assert.doesNotMatch(describePhaseOneBaselineDryRun(plan, report), new RegExp(secretValue));
});

test('inspection is drift-only and never invokes a supplied mutation seam', async () => {
  const plan = createPhaseOneBaselinePlan('cobalt');
  let mutations = 0;
  const report = await inspectPhaseOneBaseline(plan, {
    resolveAlias: async () => 'opaque-private-value',
    observeResource: async (request: Parameters<typeof healthyResource>[0]) => ({
      ...healthyResource(request),
      state: request.key === 'smoke-agent' ? 'drifted' : 'ready',
    }),
    mutateResource: async () => { mutations += 1; },
  });

  assert.equal(mutations, 0);
  assert.deepEqual(report.drift, [{ key: 'smoke-agent', state: 'drifted' }]);
  assert.equal(report.ready, false);
});

test('product resources are protected and absent from infrastructure cleanup projections', () => {
  const plan = createPhaseOneBaselinePlan('cobalt');
  const resolvedIds = Object.fromEntries(plan.resources.map(({ key }: BaselineResource) => [key, `id-${key}`]));
  assert.deepEqual(projectInfrastructureCleanup(plan), []);
  assert.deepEqual(projectProtectedProductInventory(plan, resolvedIds), {
    schemaVersion: 'chickpea-environment-protected-resource-inventory/v1',
    target: 'cobalt',
    baseline: plan.resources
      .filter(({ fixtureClass }: BaselineResource) => fixtureClass === 'immutable_baseline')
      .map(({ key, resourceKind }: BaselineResource) => ({
        provider: inventoryProvider(resourceKind), kind: resourceKind, id: `id-${key}`,
      })),
    productOwned: plan.resources
      .filter(({ fixtureClass }: BaselineResource) => fixtureClass === 'resettable_fixture')
      .map(({ key, resourceKind }: BaselineResource) => ({
        provider: inventoryProvider(resourceKind), kind: resourceKind, id: `id-${key}`,
      })),
  });
});

test('every target alias required by Phase 1 resolves through the read-only seam', async () => {
  for (const target of PHASE_ONE_TARGET_ALIASES) {
    const plan = createPhaseOneBaselinePlan(target);
    const seen: string[] = [];
    const report = await inspectPhaseOneBaseline(plan, {
      resolveAlias: async (alias: string) => { seen.push(alias); return `value-for-${alias}`; },
      observeResource: async (request: Parameters<typeof healthyResource>[0]) => healthyResource(request),
    });
    assert.equal(report.ready, true);
    assert.deepEqual(seen.sort(), [...plan.requiredEnvironmentAliases].sort());
  }
});

test('deep-only and undeclared fixture requests are rejected before planning', () => {
  assert.throws(
    () => createPhaseOneBaselinePlan('amber', { variantIds: ['LC02-V1-avatar-parity'] }),
    rejects('VARIANT_NOT_PHASE_ONE'),
  );
  assert.throws(
    () => createPhaseOneBaselinePlan('amber', { variantIds: ['LC99-V1-unknown'] }),
    rejects('UNKNOWN_VARIANT'),
  );
});

test('malformed definitions, unknown aliases, and unsupported fixture classes fail closed', () => {
  const { recipe, desiredState } = loadPhaseOneBaselineDefinitions();

  const badRecipe = clone(recipe);
  badRecipe.resources[0].fixtureClass = 'run_owned';
  assert.throws(() => validateWorkspaceRecipe(badRecipe), rejects('UNSUPPORTED_FIXTURE_CLASS'));

  const badState = clone(desiredState);
  badState.targets[0].requiredEnvironmentAliases.push('env-amber-unknown-field');
  assert.throws(() => validateDesiredState(badState), rejects('UNKNOWN_ENVIRONMENT_ALIAS'));

  const missingTarget = clone(desiredState);
  missingTarget.targets.pop();
  assert.throws(() => validateDesiredState(missingTarget), rejects('INVALID_TARGET_SET'));

  for (const privateValue of [
    'C12345678',
    'E12345678',
    'someone@example.com',
    'prefix xoxb-not-a-real-token',
  ]) {
    const leakedRecipe = clone(recipe);
    leakedRecipe.resources[0].description = privateValue;
    assert.throws(
      () => validateWorkspaceRecipe(leakedRecipe),
      rejects('PRIVATE_VALUE_IN_DEFINITION'),
    );
  }

  const secretField = clone(recipe);
  secretField.resources[0].client_secret = 'redacted';
  assert.throws(
    () => validateWorkspaceRecipe(secretField),
    rejects('PRIVATE_FIELD_IN_DEFINITION'),
  );
});

test('inspection rejects forged aliases and inconsistent reports', async () => {
  const plan = createPhaseOneBaselinePlan('amber');
  const forged = clone(plan);
  forged.requiredEnvironmentAliases[0] = 'env-amber-unregistered-private-value';
  await assert.rejects(
    inspectPhaseOneBaseline(forged, {
      resolveAlias: async () => 'should-not-be-read',
      observeResource: async () => ({ key: 'unused', state: 'ready' }),
    }),
    rejects('INVALID_BASELINE_PLAN'),
  );

  assert.throws(
    () => describePhaseOneBaselineDryRun(plan, {
      schemaVersion: 'chickpea-environment-baseline-inspection/v1',
      target: 'amber',
      ready: true,
      resolvedAliasCount: plan.requiredEnvironmentAliases.length,
      missingPrerequisites: [{ kind: 'resource', key: 'smoke-agent' }],
      drift: [],
    }),
    rejects('INVALID_INSPECTION_REPORT'),
  );
});

test('baseline readiness requires target-scoped resource checks and private fixture aliases', async () => {
  const plan = createPhaseOneBaselinePlan('amber');
  assert.ok(plan.requiredEnvironmentAliases.includes('env-amber-computer-use-profile'));
  assert.ok(plan.requiredEnvironmentAliases.includes('env-amber-model-provider'));
  assert.ok(plan.requiredEnvironmentAliases.includes('env-amber-agent-identity'));
  const missingChecks = await inspectPhaseOneBaseline(plan, {
    resolveAlias: async () => 'opaque-value',
    observeResource: async ({ key }: { key: string }) => ({ key, state: 'ready' }),
  });
  assert.equal(missingChecks.ready, false);
  const wrongTarget = await inspectPhaseOneBaseline(plan, {
    resolveAlias: async () => 'opaque-value',
    observeResource: async (request: { key: string; healthChecks: string[] }) => ({
      key: request.key, target: 'cobalt', state: 'ready',
      checks: Object.fromEntries(request.healthChecks.map((key) => [key, true])),
    }),
  });
  assert.equal(wrongTarget.ready, false);
});

test('mutated plan resources and unsafe inventory IDs cannot bypass recipe validation', async () => {
  const plan = createPhaseOneBaselinePlan('amber');
  const forged = clone(plan);
  forged.resources.find(({ key }: BaselineResource) => key === 'google-sheets-personal-read-only').access = 'write';
  await assert.rejects(inspectPhaseOneBaseline(forged, {
    resolveAlias: async () => 'opaque-value',
    observeResource: async () => null,
  }), rejects('INVALID_BASELINE_PLAN'));
  for (const invalid of ['*', 'id\nsecret', 'xoxb-not-a-real-token']) {
    const ids = Object.fromEntries(plan.resources.map(({ key }: BaselineResource) => [key, 'safe-id']));
    ids['smoke-agent'] = invalid;
    assert.throws(() => projectProtectedProductInventory(plan, ids), rejects('INVALID_RESOURCE_ID'));
  }
});

test('baseline inspection composes the actual verifier doctor without grading product behavior', async () => {
  for (const target of PHASE_ONE_TARGET_ALIASES) {
    const plan = createPhaseOneBaselinePlan(target);
    const snapshot = {
      schemaVersion: 'chickpea-live-doctor-snapshot/v1',
      manifestDigest: LIVE_MANIFEST_DIGEST,
      targetAlias: target, transport: 'events',
      targetFingerprint: `sha256:${'a'.repeat(64)}`,
      repositoryRevision: 'a'.repeat(40), servingVersion: 'version-fixture',
      computerUseSurfaces: {
        bridgeAvailable: true, windowCaptureAvailable: true, slackVisible: true, adminVisible: true,
      },
      missingActorAliases: [], workspaceMatches: true,
      evidenceRootSafe: true, targetMatches: true, lock: { status: 'clear' },
    };
    const ready = await inspectPhaseOneBaseline(plan, {
      resolveAlias: async () => 'opaque-private-value',
      observeResource: async (request: Parameters<typeof healthyResource>[0]) => healthyResource(request),
    });
    const doctor = diagnosePhaseOneBaseline(plan, ready, snapshot);
    assert.equal(doctor.kind, 'doctor');
    assert.equal(doctor.ready, true);
    assert.deepEqual(doctor.variantIds, [...PHASE_ONE_SMOKE_VARIANTS]);
    const missing = await inspectPhaseOneBaseline(plan, {
      resolveAlias: async (alias: string) => {
        if (alias.endsWith('-computer-use-profile')) throw new Error('private-error');
        return 'opaque-private-value';
      },
      observeResource: async (request: Parameters<typeof healthyResource>[0]) => healthyResource(request),
    });
    const blocked = diagnosePhaseOneBaseline(plan, missing, snapshot);
    assert.equal(blocked.ready, false);
    assert.ok(blocked.diagnostics.some(({ code }: { code: string }) => code === 'missing_actor'));
    assert.doesNotMatch(JSON.stringify(blocked), /private-error|opaque-private-value/);
    assert.equal(diagnosePhaseOneBaseline(plan, ready, {
      ...snapshot, computerUseSurfaces: { ...snapshot.computerUseSurfaces, windowCaptureAvailable: false },
    }).ready, false);
  }
});

test('baseline validation errors do not retain rejected input paths or values', () => {
  const { recipe } = loadPhaseOneBaselineDefinitions();
  const malformed = clone(recipe);
  const privateKey = 'client_secret_private-marker';
  malformed[privateKey] = 'private-value';
  assert.throws(() => validateWorkspaceRecipe(malformed), (error: unknown) => {
    assert.ok(error instanceof BaselineDefinitionError);
    assert.doesNotMatch(JSON.stringify(error), /private-marker|private-value/);
    return true;
  });
});

test('recipe dependencies must identify the exact Agent, channel, and provider account', () => {
  const { recipe } = loadPhaseOneBaselineDefinitions();
  for (const key of ['smoke-agent-channel-grant', 'google-sheets-personal-read-only']) {
    for (const dependencies of [undefined, ['primary-actor'], [key]]) {
      const malformed = clone(recipe);
      malformed.resources.find((resource: BaselineResource) => resource.key === key).dependsOn = dependencies;
      assert.throws(() => validateWorkspaceRecipe(malformed), rejects('INVALID_RESOURCE_DEPENDENCY'));
    }
  }
});

test('missing, false, nonboolean, or extra health checks cannot pass resource inspection', async () => {
  const plan = createPhaseOneBaselinePlan('amber');
  for (const checks of [
    undefined, {},
    { 'agent-resettable': false, 'model-provider-ready': true },
    { 'agent-resettable': 'true', 'model-provider-ready': true },
    { 'agent-resettable': true, 'model-provider-ready': true, unexpected: true },
  ]) {
    const report = await inspectPhaseOneBaseline(plan, {
      resolveAlias: () => 'opaque-value',
      observeResource: (request: Parameters<typeof healthyResource>[0]) => ({
        ...healthyResource(request), ...(request.key === 'smoke-agent' ? { checks } : {}),
      }),
    });
    assert.equal(report.ready, false);
    assert.deepEqual(report.drift, [{ key: 'smoke-agent', state: 'unavailable' }]);
    assert.match(describePhaseOneBaselineDryRun(plan, report), /drift smoke-agent: unavailable/);
  }
});

test('the public package lists only the two portable QA definitions explicitly', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.files.filter((file: string) => file.startsWith('config/')), [
    'config/environments/qa/desired-state.json',
    'config/environments/qa/workspace-recipe.json',
  ]);
});
