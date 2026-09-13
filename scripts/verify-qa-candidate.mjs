#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { admitQaCandidate } from './lib/qa-candidate.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    remote: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log('Usage: npm run verify:live:candidate -- [--remote origin]\nRead-only admission against the declared repository remote main. Does not fetch, alter refs, claim, build or deploy.');
  else {
    if (positionals.length) throw new Error('Unexpected positional arguments.');
    console.log(JSON.stringify(admitQaCandidate(resolve(dirname(fileURLToPath(import.meta.url)), '..'), values), null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'QA source admission failed.');
  process.exitCode = 2;
}
