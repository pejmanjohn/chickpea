/**
 * Writes the fixtures tests/config-storage-contract.test.ts compares this
 * tree's config storage against.
 *
 *   npm run fixture:config-storage -- current
 *     Records what this tree's config store writes. Refuses while a stored
 *     value differs from the last record without its contract version rising.
 *   npm run fixture:config-storage -- release <checkout of the previous release>
 *     At a release cut: records the database that release writes, and what it
 *     reads back from it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigStorageScenario, writeConfigStorageScenario } from '../tests/helpers/config-storage-scenario.ts';
import {
  CONTRACT_FILE, CURRENT_FIXTURE, PREVIOUS_RELEASE_FIXTURE, atScenarioClock, entryName, maskedJson, readContract,
  scenarioDigest, snapshotStorage, storageChanges, storesOf, unbumped, viewStorage,
  type CurrentFixture, type ReleaseFixture,
} from '../tests/helpers/config-storage.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const contract = readContract(ROOT);
const write = (file: string, value: CurrentFixture | ReleaseFixture) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const [mode, source] = process.argv.slice(2);
if (mode === 'current') {
  const { kit, open } = await storesOf(ROOT);
  const db = open();
  atScenarioClock(() => writeConfigStorageScenario(kit, db));
  const view = viewStorage(db, contract);
  const recorded: CurrentFixture | undefined =
    existsSync(CURRENT_FIXTURE) ? JSON.parse(readFileSync(CURRENT_FIXTURE, 'utf8')) : undefined;
  const stale = recorded?.scenario === scenarioDigest()
    ? unbumped(storageChanges(recorded.view, view), recorded.contract, contract)
    : [];
  if (stale.length) {
    console.error(`Stored values changed without a version increase: ${stale.map(entryName).join(', ')}.\n` +
      `Increase each in ${CONTRACT_FILE}, then run this again.`);
    process.exit(1);
  }
  write(CURRENT_FIXTURE, { scenario: scenarioDigest(), contract, view });
} else if (mode === 'release' && source) {
  const root = resolve(source);
  const { kit, open } = await storesOf(root);
  const db = open();
  atScenarioClock(() => writeConfigStorageScenario(kit, db));
  const written = snapshotStorage(db, contract);
  write(PREVIOUS_RELEASE_FIXTURE, {
    release: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    scenario: scenarioDigest(),
    ...written,
    readback: maskedJson(await atScenarioClock(() => readConfigStorageScenario(kit, db))),
  });
} else {
  console.error('Usage: npm run fixture:config-storage -- current | release <checkout of the previous release>');
  process.exit(2);
}
