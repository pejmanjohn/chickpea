#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const commands = [
  ['--import', 'tsx', 'scripts/build-model-catalog.mjs'],
  [
    '--test', '--import', 'tsx',
    'tests/model-catalog.test.ts',
    'tests/model-catalog-refresh.test.ts',
    'tests/model-catalog-concurrency.test.ts',
    'tests/model-catalog-routing.test.ts',
    'tests/model-compat-provider.test.ts',
    'tests/openai-subscription-model-catalog.test.ts',
    'tests/openai-subscription-provider.test.ts',
  ],
];

for (const args of commands) {
  const result = spawnSync(node, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
