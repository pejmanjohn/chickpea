#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHostedCatalogDocument } from '../src/model-catalog/schema.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'catalog', 'source.json');
const currentPath = path.join(root, 'catalog', 'current.json');
const write = process.argv.includes('--write');

const source = parseSource(JSON.parse(await readFile(sourcePath, 'utf8')));
const runtime = parseHostedCatalogDocument({
  schemaVersion: 1,
  revision: source.revision,
  generatedAt: source.generatedAt,
  entries: source.entries.map(runtimeEntry),
});
const bytes = `${JSON.stringify(runtime, null, 2)}\n`;
const releasePath = path.join(root, 'catalog', 'releases', `revision-${runtime.revision}.json`);

if (write) {
  await writeFile(currentPath, bytes);
  await writeFile(releasePath, bytes, { flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(releasePath, 'utf8');
    if (existing !== bytes) {
      throw new Error(`Immutable release already exists with different bytes: ${releasePath}`);
    }
  });
  console.log(`Wrote catalog revision ${runtime.revision}.`);
} else {
  const [current, release] = await Promise.all([
    readFile(currentPath, 'utf8'),
    readFile(releasePath, 'utf8'),
  ]);
  if (current !== bytes) {
    throw new Error('catalog/current.json is not the deterministic output of catalog/source.json.');
  }
  if (release !== bytes) {
    throw new Error(`catalog/releases/revision-${runtime.revision}.json does not match current.json.`);
  }
  console.log(`Catalog revision ${runtime.revision} is deterministic and immutable.`);
}

function runtimeEntry(entry) {
  return {
    canonical: entry.canonical,
    ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    lanes: entry.lanes,
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
  };
}

function parseSource(value) {
  assertRecord(value, 'catalog source');
  assertExactKeys(value, ['sourceVersion', 'revision', 'generatedAt', 'entries'], 'catalog source');
  if (value.sourceVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error('Unsupported catalog source.');
  }
  for (const [index, entry] of value.entries.entries()) parseSourceEntry(entry, index);
  return value;
}

function parseSourceEntry(entry, index) {
  const label = `catalog source entry ${index}`;
  assertRecord(entry, label);
  assertExactKeys(
    entry,
    ['canonical', 'displayName', 'lanes', 'contextWindow', 'maxTokens', 'provenance', 'laneStatus'],
    label,
  );
  assertRecord(entry.provenance, `${label} provenance`);
  assertExactKeys(entry.provenance, ['sourceRefs', 'reviewedAt'], `${label} provenance`);
  if (
    !Array.isArray(entry.provenance.sourceRefs) ||
    entry.provenance.sourceRefs.length === 0 ||
    !entry.provenance.sourceRefs.every((ref) => typeof ref === 'string' && ref.length <= 256) ||
    typeof entry.provenance.reviewedAt !== 'string'
  ) {
    throw new Error(`${label} has invalid provenance.`);
  }
  assertRecord(entry.laneStatus, `${label} laneStatus`);
  assertRecord(entry.lanes, `${label} lanes`);
  assertExactKeys(entry.laneStatus, Object.keys(entry.lanes), `${label} laneStatus`);
  for (const [lane, status] of Object.entries(entry.laneStatus)) {
    assertRecord(status, `${label} ${lane} status`);
    assertExactKeys(status, ['state', 'nativeVerifiedAt', 'retainUntil'], `${label} ${lane} status`);
    if (!['backfill', 'native_candidate', 'native_verified', 'legacy_retained', 'removable', 'contract_owned'].includes(status.state)) {
      throw new Error(`${label} ${lane} has an unknown retirement state.`);
    }
    const datedState = ['native_verified', 'legacy_retained', 'removable'].includes(status.state);
    if (datedState) {
      if (!isIsoDate(status.nativeVerifiedAt) || !isIsoDate(status.retainUntil)) {
        throw new Error(`${label} ${lane} ${status.state} requires nativeVerifiedAt and retainUntil dates.`);
      }
      if (status.retainUntil < status.nativeVerifiedAt) {
        throw new Error(`${label} ${lane} retainUntil cannot precede nativeVerifiedAt.`);
      }
    } else if (status.nativeVerifiedAt !== undefined || status.retainUntil !== undefined) {
      throw new Error(`${label} ${lane} ${status.state} cannot carry retirement dates.`);
    }
  }
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}

function assertRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} has unexpected keys: ${unexpected.join(', ')}.`);
  }
}
