import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateUpgradeCompatibility,
  validateUpgradeManifest,
} from '../src/release/upgrade-compatibility.mjs';

const digest = (character: string) => character.repeat(64);
const migrations = (configuration = digest('e')) => ({
  d1: digest('a'),
  workerConfiguration: digest('b'),
  identity: digest('c'),
  configuration,
  work: digest('d'),
});
const manifest = (version: string, configuration?: string) => ({
  formatVersion: 1 as const,
  version,
  storageGeneration: 1,
  supportedOrigins: [] as string[],
  recovery: 'gateway-transport-then-previous-code' as const,
  migrations: migrations(configuration),
});

test('unchanged storage is supported only for a declared older origin', () => {
  const currentConfiguration = '8ebfe7655eab0d28792642d317162a4c5ef96f1c43f7cc389e32977c17084dc2';
  const before = manifest('0.1.17', currentConfiguration);
  const after = {
    ...manifest('0.1.18', currentConfiguration), supportedOrigins: ['0.1.17'],
  };
  assert.deepEqual(evaluateUpgradeCompatibility(before, after), {
    status: 'supported', reason: 'unchanged-storage',
  });
  assert.deepEqual(evaluateUpgradeCompatibility(before, { ...after, supportedOrigins: [] }), {
    status: 'unsupported', reason: 'origin-not-declared',
  });
  assert.deepEqual(evaluateUpgradeCompatibility(before, {
    ...after, version: '0.1.17', supportedOrigins: [],
  }), {
    status: 'unsupported', reason: 'destination-not-newer',
  });
});

test('only the exact reviewed v0.1.16 configuration transition is accepted', () => {
  const oldConfiguration = 'fa8728169c93d0a8ce86dad166d2779b0e8debcfdaaa4c791f96055e1db7b365';
  const newConfiguration = '8ebfe7655eab0d28792642d317162a4c5ef96f1c43f7cc389e32977c17084dc2';
  const before = manifest('0.1.16', oldConfiguration);
  const after = { ...manifest('0.1.18', newConfiguration), supportedOrigins: ['0.1.16'] };
  assert.deepEqual(evaluateUpgradeCompatibility(before, after), {
    status: 'supported', reason: 'reviewed-configuration-transition',
  });
  for (const [origin, destination] of [
    [{ ...before, version: '0.1.15' }, { ...after, supportedOrigins: ['0.1.15'] }],
    [before, { ...after, version: '0.1.19', supportedOrigins: ['0.1.16'] }],
    [before, { ...after, migrations: migrations(digest('f')) }],
  ]) {
    assert.deepEqual(evaluateUpgradeCompatibility(origin, destination), {
      status: 'unsupported', reason: 'migration-content-changed',
    });
  }
});

test('every other storage and migration change fails closed', () => {
  const before = manifest('0.1.17');
  const after = { ...manifest('0.1.18'), supportedOrigins: ['0.1.17'] };
  assert.deepEqual(evaluateUpgradeCompatibility(before, {
    ...after, storageGeneration: 2,
  }), { status: 'unsupported', reason: 'storage-generation-changed' });
  for (const key of ['d1', 'workerConfiguration', 'identity', 'work'] as const) {
    assert.deepEqual(evaluateUpgradeCompatibility(before, {
      ...after, migrations: { ...after.migrations, [key]: digest('f') },
    }), { status: 'unsupported', reason: 'migration-content-changed' });
  }
});

test('manifest validation rejects incomplete, malformed, and unknown contracts', () => {
  const valid = manifest('0.1.18');
  assert.equal(validateUpgradeManifest(valid), valid);
  for (const invalid of [
    { ...valid, formatVersion: 2 },
    { ...valid, version: 'v0.1.18' },
    { ...valid, supportedOrigins: ['0.1.18'] },
    { ...valid, supportedOrigins: ['0.1.17', '0.1.17'] },
    { ...valid, recovery: 'snapshot' },
    { ...valid, migrations: { ...valid.migrations, work: 'short' } },
    { ...valid, migrations: { ...valid.migrations, extra: digest('f') } },
  ]) assert.throws(() => validateUpgradeManifest(invalid), /Invalid release upgrade contract/);
});
