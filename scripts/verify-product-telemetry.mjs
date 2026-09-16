#!/usr/bin/env node

import { parseArgs } from 'node:util';

import {
  ProductTelemetryPreflightError,
  verifyProductTelemetry,
  writeProductTelemetryReceipt,
} from './lib/product-telemetry-preflight.mjs';

const usage = 'Usage: npm run verify:telemetry -- --worker <explicit-worker-name> [--account-id <cloudflare-account-id>] [--profile <wrangler-profile>] [--env <wrangler-environment>] [--output <private-json-path>]';

let outputPath;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      worker: { type: 'string' },
      'account-id': { type: 'string' },
      profile: { type: 'string' },
      env: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(`${usage}\nRead-only: inspects current deployment traffic and version binding metadata. The Worker name never defaults from wrangler.jsonc.`);
  } else {
    if (positionals.length !== 0 || typeof values.worker !== 'string') {
      throw new Error('INVALID_ARGUMENTS');
    }
    outputPath = values.output;
    const providerContext = [];
    if (values.profile !== undefined) providerContext.push('--profile', values.profile);
    if (values.env !== undefined) providerContext.push('--env', values.env);
    const receipt = await verifyProductTelemetry({
      worker: values.worker,
      ...(values['account-id'] ? { accountId: values['account-id'] } : {}),
      ...(providerContext.length > 0 ? { providerContext } : {}),
    });
    if (outputPath) writeProductTelemetryReceipt(outputPath, receipt);
    console.log(JSON.stringify(receipt, null, 2));
  }
} catch (error) {
  let message = `${usage}\nTelemetry preflight failed before it could inspect the selected Worker.`;
  if (error instanceof ProductTelemetryPreflightError) {
    message = error.message;
    console.log(JSON.stringify(error.receipt, null, 2));
    if (outputPath) {
      try {
        writeProductTelemetryReceipt(outputPath, error.receipt);
      } catch (writeError) {
        console.error(writeError instanceof Error
          ? writeError.message
          : 'Unable to write the private telemetry preflight receipt.');
      }
    }
  } else if (error instanceof Error && error.message.startsWith('Telemetry preflight output')) {
    message = error.message;
  }
  console.error(message);
  process.exitCode = 1;
}
