import { createHash } from 'node:crypto';

import { suitableCapability } from './verification-scope.mjs';
import { validateSpec } from './verification-record.mjs';

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODEL_SELECTOR = /^[A-Za-z0-9@][A-Za-z0-9._:@/-]{0,255}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const LIFECYCLES = ['reusable', 'reserved_user_trial', 'disposable', 'unavailable'];
const RESET_RIGHTS = ['none', 'restore', 'dispose'];

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function safePrivateData(value, path = '$') {
  if (typeof value === 'string') {
    if (/(?:xox[baprs]-|\bsk-[A-Za-z0-9]{12}|Bearer\s+|-----BEGIN .*PRIVATE KEY-----)/iu.test(value)) throw new Error(`Secret-like fixture value refused at ${path}.`);
    // Any absolute path is a filesystem coordinate, whatever the home directory
    // is called (/Users on macOS, /home or /root on Linux).
    if (/^(?:\/|[A-Za-z]:\\|~\/)/u.test(value)) throw new Error(`Absolute fixture value refused at ${path}.`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'credentialHandle' && /(?:password|credential|authorization|cookie|secret|accessToken|refreshToken)/iu.test(key)) throw new Error(`Secret-bearing fixture field refused at ${path}.${key}.`);
    safePrivateData(child, `${path}.${key}`);
  }
}

export function validateFixtureInventory(input) {
  safePrivateData(input);
  if (!exact(input, ['schemaVersion', 'observedAt', 'fixtures'])
    || input.schemaVersion !== 'chickpea-live-fixture-inventory/v1'
    || !Number.isFinite(Date.parse(input.observedAt))
    || !input.fixtures || typeof input.fixtures !== 'object' || Array.isArray(input.fixtures)) throw new Error('Invalid fixture inventory.');
  for (const [id, fixture] of Object.entries(input.fixtures)) {
    if (!ALIAS.test(id) || !exact(fixture, ['lifecycle', 'allowedOperations', 'resetRights', 'registeredModel',
      'credentialHandle', 'owner', 'expiresAt', 'supportedPairs', 'evidenceHash'])) throw new Error(`Invalid fixture entry ${id}.`);
    if (!LIFECYCLES.includes(fixture.lifecycle) || !RESET_RIGHTS.includes(fixture.resetRights)
      || !Array.isArray(fixture.allowedOperations) || new Set(fixture.allowedOperations).size !== fixture.allowedOperations.length
      || fixture.allowedOperations.some((item) => !ALIAS.test(item))
      || (fixture.registeredModel !== null && !MODEL_SELECTOR.test(fixture.registeredModel))
      || (fixture.credentialHandle !== null && !ALIAS.test(fixture.credentialHandle))
      || (fixture.owner !== null && !ALIAS.test(fixture.owner))
      || (fixture.expiresAt !== null && !Number.isFinite(Date.parse(fixture.expiresAt)))
      || !Array.isArray(fixture.supportedPairs) || fixture.supportedPairs.some((pair) =>
        !exact(pair, ['from', 'to']) || !ALIAS.test(pair.from) || !ALIAS.test(pair.to))
      || !DIGEST.test(fixture.evidenceHash)) throw new Error(`Invalid fixture entry ${id}.`);
    if (fixture.lifecycle === 'reserved_user_trial' && fixture.owner === null) throw new Error(`Reserved fixture ${id} needs an owner.`);
  }
  return input;
}

export function fixtureReadiness(spec, inventoryInput, options = {}, now = Date.now()) {
  const inventory = validateFixtureInventory(inventoryInput);
  validateSpec(spec);
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 7 * 24 * 60 * 60_000) throw new Error('Inventory max age must be 1ms..7d.');
  const inventoryTime = Date.parse(inventory.observedAt);
  const inventoryFreshness = inventoryTime > now ? 'future' : now - inventoryTime >= maxAgeMs ? 'stale' : 'fresh';
  const cases = spec.cases.map((selected) => {
    const blockers = [];
    const fixtureRefs = [];
    for (const capabilityId of selected.requires ?? []) {
      const capability = spec.capabilities[capabilityId];
      if (capability?.kind !== 'fixture') continue;
      if (!capability.available) blockers.push({ capabilityId, code: 'capability_unavailable' });
      if (Date.parse(capability.observedAt) > now || Date.parse(capability.expiresAt) <= now) {
        blockers.push({ capabilityId, code: 'capability_expired' });
      }
      const fixtureAlias = capability.identity ?? capabilityId;
      if (!ALIAS.test(fixtureAlias)) { blockers.push({ capabilityId, code: 'fixture_alias_invalid' }); continue; }
      const fixture = inventory.fixtures[fixtureAlias];
      if (!suitableCapability(capability, spec, selected)) blockers.push({ capabilityId, code: 'scope_mismatch' });
      if (!fixture) { blockers.push({ capabilityId, code: 'fixture_missing' }); continue; }
      fixtureRefs.push({ capabilityId, fixtureAlias, lifecycle: fixture.lifecycle,
        allowedOperations: [...fixture.allowedOperations], resetRights: fixture.resetRights,
        registeredModel: fixture.registeredModel, credentialHandle: fixture.credentialHandle,
        expiresAt: fixture.expiresAt, supportedPairs: fixture.supportedPairs.map((pair) => ({ ...pair })),
        evidenceHash: fixture.evidenceHash });
      if (fixture.lifecycle === 'unavailable') blockers.push({ capabilityId, code: 'fixture_unavailable' });
      if (fixture.lifecycle === 'reserved_user_trial') blockers.push({ capabilityId, code: 'fixture_reserved', owner: fixture.owner });
      if (fixture.expiresAt !== null && Date.parse(fixture.expiresAt) <= now) blockers.push({ capabilityId, code: 'fixture_expired' });
      const model = spec.contexts[selected.context]?.model;
      if (fixture.registeredModel !== null && fixture.registeredModel !== model) blockers.push({ capabilityId, code: 'model_mismatch' });
      if (options.operation && !fixture.allowedOperations.includes(options.operation)) blockers.push({ capabilityId, code: 'operation_not_allowed' });
      if (options.resetRights && fixture.resetRights !== options.resetRights) blockers.push({ capabilityId, code: 'reset_not_authorized' });
      if (options.fromRelease && options.toRelease && !fixture.supportedPairs.some((pair) =>
        pair.from === options.fromRelease && pair.to === options.toRelease)) blockers.push({ capabilityId, code: 'unsupported_pair' });
      if (inventoryFreshness !== 'fresh') blockers.push({ capabilityId, code: `inventory_${inventoryFreshness}` });
    }
    return { caseId: selected.id, ready: blockers.length === 0, fixtures: fixtureRefs, blockers };
  });
  return { schemaVersion: 'chickpea-live-fixture-readiness/v1', advisory: true,
    reservation: 'none', authorizationCreated: false,
    inventory: { observedAt: inventory.observedAt, freshness: inventoryFreshness,
      maxAgeMs, digest: digest(inventory) }, cases };
}
