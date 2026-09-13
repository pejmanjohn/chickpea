const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MIGRATION_KEYS = Object.freeze([
  'd1',
  'workerConfiguration',
  'identity',
  'configuration',
  'work',
]);
const UNCHANGED_MIGRATION_KEYS = MIGRATION_KEYS.filter(
  (key) => key !== 'configuration',
);
const RECOVERY_POLICIES = new Set([
  'previous-code-only',
  'gateway-transport-then-previous-code',
]);

// v0.1.17 moved the existing gateway-installation writes into one transaction.
// It added no schema, migration, or stored-data shape. Keep the exception tied
// to both immutable release identities and both exact conservative source
// digests; any further edit fails closed and needs its own review.
const REVIEWED_CONFIGURATION_TRANSITIONS = new Set([
  [
    '0.1.16',
    'fa8728169c93d0a8ce86dad166d2779b0e8debcfdaaa4c791f96055e1db7b365',
    '0.1.18',
    '8ebfe7655eab0d28792642d317162a4c5ef96f1c43f7cc389e32977c17084dc2',
  ].join(':'),
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function invalid(code = 'invalid-release-contract') {
  const error = new Error('Invalid release upgrade contract.');
  error.code = code;
  throw error;
}

/** Validate only the release fields needed to make a shared upgrade decision. */
export function validateUpgradeManifest(value) {
  if (!record(value) || value.formatVersion !== 1 ||
      !STABLE_VERSION.test(value.version) ||
      !Number.isSafeInteger(value.storageGeneration) || value.storageGeneration < 1 ||
      !Array.isArray(value.supportedOrigins) ||
      new Set(value.supportedOrigins).size !== value.supportedOrigins.length ||
      value.supportedOrigins.some((origin) =>
        typeof origin !== 'string' || !STABLE_VERSION.test(origin) ||
        compareVersions(origin, value.version) >= 0) ||
      !record(value.migrations) ||
      Object.keys(value.migrations).length !== MIGRATION_KEYS.length ||
      MIGRATION_KEYS.some((key) => !DIGEST.test(value.migrations[key]))) {
    invalid();
  }
  if (!RECOVERY_POLICIES.has(value.recovery)) invalid('recovery-policy-unsupported');
  return value;
}

/**
 * Make the same fail-closed transition decision in the Worker and updater.
 * Source provenance and current serving identity are verified by their callers.
 */
export function evaluateUpgradeCompatibility(beforeValue, afterValue) {
  const before = validateUpgradeManifest(beforeValue);
  const after = validateUpgradeManifest(afterValue);
  if (compareVersions(before.version, after.version) >= 0) {
    return { status: 'unsupported', reason: 'destination-not-newer' };
  }
  if (!after.supportedOrigins.includes(before.version)) {
    return { status: 'unsupported', reason: 'origin-not-declared' };
  }
  if (before.storageGeneration !== after.storageGeneration) {
    return { status: 'unsupported', reason: 'storage-generation-changed' };
  }
  if (UNCHANGED_MIGRATION_KEYS.some(
    (key) => before.migrations[key] !== after.migrations[key],
  )) {
    return { status: 'unsupported', reason: 'migration-content-changed' };
  }
  if (before.migrations.configuration === after.migrations.configuration) {
    return { status: 'supported', reason: 'unchanged-storage' };
  }
  const reviewed = [
    before.version,
    before.migrations.configuration,
    after.version,
    after.migrations.configuration,
  ].join(':');
  return REVIEWED_CONFIGURATION_TRANSITIONS.has(reviewed)
    ? { status: 'supported', reason: 'reviewed-configuration-transition' }
    : { status: 'unsupported', reason: 'migration-content-changed' };
}
