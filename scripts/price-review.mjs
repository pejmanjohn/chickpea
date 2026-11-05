#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  PriceReviewUsageError,
  PriceReviewWriteRefused,
  REPOSITORY_ROOT,
  parseAccepts,
  renderReport,
  reviewPrices,
  writeReviewCatalog,
} from './lib/price-review.ts';

const USAGE = `Usage: npm run prices:review -- [--write] [--accept <provider>/<model>[@YYYY-MM-DD]]... [--json <file>] [--now <ISO time>]

Compares every current price in src/usage/pricing/catalogs with its sources and prints a Markdown report.
  --write    write src/usage/pricing/catalogs/<day>-review.ts for every unchanged, changed or accepted price
  --accept   a price you checked by hand: renew the catalog's numbers, due on the date if given
  --json     also write the structured result to a file
  --now      review as of this instant instead of now (not with --write)
See docs/runbooks/price-review.md.`;

let options;
try {
  options = parseArgs({
    options: {
      write: { type: 'boolean', default: false },
      accept: { type: 'string', multiple: true, default: [] },
      json: { type: 'string' },
      now: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  }).values;
} catch (error) {
  usageError(error.message);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const at = options.now === undefined ? Date.now() : Date.parse(options.now);
if (Number.isNaN(at)) usageError(`--now ${options.now} is not a date`);
if (options.write && options.now !== undefined) usageError('--now is for dry runs; --write takes effect at the current time');

let result;
try {
  result = await reviewPrices({ at, accepts: parseAccepts(options.accept, at) });
} catch (error) {
  if (error instanceof PriceReviewUsageError) usageError(error.message);
  throw error;
}
process.stdout.write(renderReport(result));
if (options.json) await writeFile(options.json, `${JSON.stringify(result, null, 2)}\n`);

if (options.write) {
  try {
    const written = await writeReviewCatalog(result);
    console.error(written
      ? `Wrote ${path.relative(REPOSITORY_ROOT, written.file)} with ${written.versions.length} price versions, registered ${written.exportName} in src/usage/pricing/catalog.ts, and pinned their hashes.`
      : 'Nothing to write: no price is unchanged, changed or accepted.');
  } catch (error) {
    if (!(error instanceof PriceReviewWriteRefused)) throw error;
    console.error(`Refused to write: ${error.message}`);
    process.exit(1);
  }
}

function usageError(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}
