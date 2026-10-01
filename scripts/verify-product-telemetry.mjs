#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  ProductTelemetryPreflightError,
  verifyProductTelemetry,
  writeProductTelemetryReceipt,
} from './lib/product-telemetry-preflight.mjs';

const usage = 'Usage: npm run verify:telemetry -- (--target <amber|cobalt|violet> | --worker <explicit-worker-name>) [--account-id <cloudflare-account-id>] [--profile <wrangler-profile>] [--env <wrangler-environment>] [--output <private-json-path>]';

/** A QA lane's Worker and private evidence folder, from the environment registry. */
async function resolveTarget(target) {
  const { readEnvironmentRegistry } = await import('./lib/environment-registry.mjs');
  let registry;
  try {
    registry = readEnvironmentRegistry();
  } catch (error) {
    throw new Error(`No registered QA lane named ${target}: the environment registry is unavailable (${error?.code ?? 'unreadable'}).`);
  }
  const registration = registry.targets?.[target];
  if (!registration?.workerName) throw new Error(`No registered QA lane named ${target}.`);
  return { worker: registration.workerName, evidenceRoot: registration.evidenceRoot };
}

let outputPath;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      worker: { type: 'string' },
      'account-id': { type: 'string' },
      profile: { type: 'string' },
      env: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(`${usage}\nRead-only: inspects current deployment traffic and version binding metadata. The Worker name never defaults from wrangler.jsonc; --target reads it from the environment registry and writes the receipt into that lane's private evidence folder unless --output is given. The guarded lane deploy already runs this check and writes the same receipt.`);
  } else {
    if (positionals.length !== 0 || (typeof values.worker === 'string') === (typeof values.target === 'string')) {
      throw new Error('INVALID_ARGUMENTS');
    }
    let worker = values.worker;
    outputPath = values.output;
    if (values.target) {
      const resolved = await resolveTarget(values.target);
      worker = resolved.worker;
      if (!outputPath && resolved.evidenceRoot) {
        outputPath = path.join(resolved.evidenceRoot, `telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      }
    }
    const providerContext = [];
    if (values.profile !== undefined) providerContext.push('--profile', values.profile);
    if (values.env !== undefined) providerContext.push('--env', values.env);
    const receipt = await verifyProductTelemetry({
      worker,
      ...(values['account-id'] ? { accountId: values['account-id'] } : {}),
      ...(providerContext.length > 0 ? { providerContext } : {}),
    });
    if (outputPath) writeProductTelemetryReceipt(outputPath, receipt);
    console.log(JSON.stringify(receipt, null, 2));
    if (outputPath) console.error(`Receipt: ${outputPath}`);
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
  } else if (error instanceof Error && (error.message.startsWith('Telemetry preflight output') || error.message.startsWith('No registered QA lane'))) {
    message = error.message;
  }
  console.error(message);
  process.exitCode = 1;
}
