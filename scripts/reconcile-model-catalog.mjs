#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getModel } from '@earendil-works/pi-ai/compat';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(path.join(root, 'catalog', 'source.json'), 'utf8'));
const today = process.env.MODEL_CATALOG_RECONCILE_DATE ?? new Date().toISOString().slice(0, 10);
const rows = [];
let candidates = 0;

for (const entry of source.entries ?? []) {
  const [provider, ...modelParts] = String(entry.canonical).split('/');
  const modelId = modelParts.join('/');
  const native = provider === 'openai' || provider === 'anthropic'
    ? getModel(provider, modelId) !== undefined
    : false;
  for (const lane of Object.keys(entry.lanes ?? {})) {
    const recorded = entry.laneStatus?.[lane];
    let classification = recorded?.state ?? 'backfill';
    if (lane === 'apiKey' && native) {
      if (classification === 'backfill') {
        classification = 'native_candidate';
        candidates += 1;
      } else if (classification === 'native_verified') {
        classification = recorded.retainUntil && recorded.retainUntil <= today
          ? 'removable'
          : 'legacy_retained';
      }
    }
    rows.push({ canonical: entry.canonical, lane, native, classification });
  }
}

for (const row of rows) {
  console.log(
    `${row.classification.padEnd(18)} ${row.canonical} [${row.lane}] ` +
      `(Pi native: ${row.native ? 'yes' : 'no'})`,
  );
}
if (candidates > 0) {
  console.error(
    `${candidates} catalog lane(s) are now Pi-native candidates. Run native equivalence/live gates, ` +
      'then mark native_verified with a retainUntil date in catalog/source.json.',
  );
  process.exitCode = 2;
}
