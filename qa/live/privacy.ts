import { validateGitHubSourceBinding, type GitHubSourceBinding } from './public-sources.ts';
import {
  FIXTURE_KINDS,
  alias,
  exactKeys,
  fail,
  record,
  type FixtureKind,
  type LiveManifest,
} from './schema.ts';

export { LiveContractValidationError } from './schema.ts';

const SECRET_FIELDS = new Set([
  'apitoken', 'apikey', 'secret', 'clientsecret', 'password', 'credential', 'credentials',
  'authorization', 'cookie', 'cookies', 'sessioncookie', 'browserstorage', 'headers',
]);
const EXECUTABLE_FIELDS = new Set([
  'command', 'commands', 'dynamicimport', 'module', 'modulepath', 'filesystempath', 'setupcapability',
  'executable', 'script', 'shell', 'adaptermodule',
]);
const RAW_CONTENT_FIELDS = new Set([
  'rawtranscript', 'transcript', 'screenshot', 'screenshots', 'rawbody', 'requestbody', 'responsebody', 'stack', 'stacktrace',
]);
const PRIVATE_COORDINATE_FIELDS = new Set([
  'workspaceid', 'teamid', 'channelid', 'userid', 'accountid', 'slackappid', 'customercontent', 'personalaccountlabel', 'workername',
]);
const SECRET_VALUES = [
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
];

export interface TargetFixture {
  kind: FixtureKind;
  resourceAlias: string;
  source?: GitHubSourceBinding;
}

export interface TargetVariantBinding {
  fixtures: Record<string, string>;
}

export interface LiveTargetOverlay {
  schemaVersion: 'chickpea-live-target/v1';
  targetAlias: string;
  workspaceAlias: string;
  slackAppAlias: string;
  workerAlias: string;
  providerProjectAlias: string;
  evidenceRootAlias: string;
  lockLocationAlias: string;
  fixtures: Record<string, TargetFixture>;
  bindings: Record<string, TargetVariantBinding>;
}

export function assertPublicData(input: unknown): void {
  inspectData(input, '$', new Set<object>());
}

export function validateTargetOverlay(manifest: LiveManifest, input: unknown): LiveTargetOverlay {
  assertPublicData(input);
  const value = record(input, '$');
  exactKeys(value, [
    'schemaVersion', 'targetAlias', 'workspaceAlias', 'slackAppAlias', 'workerAlias', 'providerProjectAlias',
    'evidenceRootAlias', 'lockLocationAlias', 'fixtures', 'bindings',
  ], '$');
  if (value.schemaVersion !== 'chickpea-live-target/v1') fail('INVALID_VALUE', '$.schemaVersion');
  const fixtures = validateTargetFixtures(value.fixtures);
  const bindingsValue = record(value.bindings, '$.bindings');
  const expectedVariantIds = [...manifest.requiredVariants.deep].sort();
  if (!same(Object.keys(bindingsValue).sort(), expectedVariantIds)) {
    fail('OVERLAY_VARIANT_MISMATCH', '$.bindings');
  }
  const requirementsByVariant = new Map(manifest.contracts.flatMap((contract) =>
    contract.variants.map((variant) => [variant.id, variant.fixtures] as const)
  ));
  const bindings: Record<string, TargetVariantBinding> = {};
  for (const variantId of expectedVariantIds) {
    const bindingPath = `$.bindings.${variantId}`;
    const binding = record(bindingsValue[variantId], bindingPath);
    exactKeys(binding, ['fixtures'], bindingPath);
    const fixtureBindings = record(binding.fixtures, `${bindingPath}.fixtures`);
    const requirements = requirementsByVariant.get(variantId) ?? [];
    if (!same(Object.keys(fixtureBindings).sort(), requirements.map((requirement) => requirement.slot).sort())) {
      fail('FIXTURE_MISMATCH', `${bindingPath}.fixtures`);
    }
    const resolved: Record<string, string> = {};
    for (const requirement of requirements) {
      const fixtureAlias = alias(fixtureBindings[requirement.slot], `${bindingPath}.fixtures.${requirement.slot}`);
      const fixture = fixtures[fixtureAlias];
      if (fixture === undefined || fixture.kind !== requirement.kind) {
        fail('FIXTURE_MISMATCH', `${bindingPath}.fixtures.${requirement.slot}`);
      }
      if (requirement.kind === 'source_fixture') {
        if (fixture.source === undefined || requirement.sourceDigest === undefined) {
          fail('FIXTURE_MISMATCH', `${bindingPath}.fixtures.${requirement.slot}`);
        }
        validateGitHubSourceBinding(fixture.source, requirement.sourceDigest);
      }
      resolved[requirement.slot] = fixtureAlias;
    }
    bindings[variantId] = { fixtures: resolved };
  }
  return {
    schemaVersion: value.schemaVersion,
    targetAlias: alias(value.targetAlias, '$.targetAlias'),
    workspaceAlias: alias(value.workspaceAlias, '$.workspaceAlias'),
    slackAppAlias: alias(value.slackAppAlias, '$.slackAppAlias'),
    workerAlias: alias(value.workerAlias, '$.workerAlias'),
    providerProjectAlias: alias(value.providerProjectAlias, '$.providerProjectAlias'),
    evidenceRootAlias: alias(value.evidenceRootAlias, '$.evidenceRootAlias'),
    lockLocationAlias: alias(value.lockLocationAlias, '$.lockLocationAlias'),
    fixtures,
    bindings,
  };
}

function validateTargetFixtures(input: unknown): Record<string, TargetFixture> {
  const value = record(input, '$.fixtures');
  const fixtures: Record<string, TargetFixture> = {};
  for (const [fixtureAliasValue, fixtureInput] of Object.entries(value)) {
    const fixtureAlias = alias(fixtureAliasValue, '$.fixtures');
    const path = `$.fixtures.${fixtureAlias}`;
    const fixture = record(fixtureInput, path);
    exactKeys(fixture, ['kind', 'resourceAlias', 'source'], path);
    if (typeof fixture.kind !== 'string' || !(FIXTURE_KINDS as readonly string[]).includes(fixture.kind)) {
      fail('INVALID_VALUE', `${path}.kind`);
    }
    const kind = fixture.kind as FixtureKind;
    const resourceAlias = alias(fixture.resourceAlias, `${path}.resourceAlias`);
    if (kind === 'source_fixture') {
      fixtures[fixtureAlias] = { kind, resourceAlias, source: validateGitHubSourceBinding(fixture.source) };
    } else {
      if (fixture.source !== undefined) fail('UNKNOWN_FIELD', path);
      fixtures[fixtureAlias] = { kind, resourceAlias };
    }
  }
  return fixtures;
}

function inspectData(input: unknown, path: string, seen: Set<object>): void {
  if (input === null || typeof input === 'boolean' || typeof input === 'number') return;
  if (typeof input === 'string') {
    if (SECRET_VALUES.some((pattern) => pattern.test(input))) fail('SECRET_VALUE', path);
    if (/^(?:\/Users\/|\/home\/|[A-Za-z]:\\|~\/)/.test(input)) fail('ABSOLUTE_PATH', path);
    if (/^https?:\/\//i.test(input)) fail('FREEFORM_URL', path);
    return;
  }
  if (typeof input !== 'object') fail('DATATYPE_NOT_ALLOWED', path);
  if (seen.has(input)) fail('DATATYPE_NOT_ALLOWED', path);
  seen.add(input);
  if (Array.isArray(input)) {
    input.forEach((child, index) => inspectData(child, `${path}[${index}]`, seen));
    seen.delete(input);
    return;
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) fail('DATATYPE_NOT_ALLOWED', path);
  for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SECRET_FIELDS.has(normalized) ||
        /(?:api|access|refresh|bot|oauth|provider|slack|auth)token$/.test(normalized) ||
        /(?:secret|password|credential|cookie|authorization)$/.test(normalized)) {
      fail('SECRET_FIELD', childPath);
    }
    if (EXECUTABLE_FIELDS.has(normalized)) fail('EXECUTABLE_FIELD', childPath);
    if (RAW_CONTENT_FIELDS.has(normalized)) fail('RAW_CONTENT_FIELD', childPath);
    if (PRIVATE_COORDINATE_FIELDS.has(normalized)) fail('PRIVATE_COORDINATE', childPath);
    inspectData(child, childPath, seen);
  }
  seen.delete(input);
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
