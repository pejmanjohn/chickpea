#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { admitQaCandidate } from './lib/qa-candidate.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    remote: { type: 'string' }, 'release-tag': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log('Usage: npm run verify:live:candidate -- [--remote origin] [--release-tag vX.Y.Z]\nRead-only admission against the declared repository remote main. Does not fetch, alter refs, claim, build or deploy. --release-tag admits HEAD when it is exactly that published tag on main.');
  else {
    if (positionals.length) throw new Error('Unexpected positional arguments.');
    const { 'release-tag': releaseTag, ...rest } = values;
    console.log(JSON.stringify(admitQaCandidate(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { ...rest, ...(releaseTag ? { releaseTag } : {}) }), null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'QA source admission failed.');
  process.exitCode = 2;
}
