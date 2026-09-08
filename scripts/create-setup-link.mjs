#!/usr/bin/env node
import process from 'node:process';

import {
  mintSetupCapability,
  SETUP_CAPABILITY_DIGEST_BINDING,
  SETUP_CAPABILITY_ISSUED_AT_BINDING,
  setupCapabilityUrl,
} from '../src/auth/setup-capability.mjs';

const baseUrl = process.argv[2]?.trim();
if (!baseUrl) {
  console.error('Usage: npm run setup:link -- https://chickpea.example.com');
  process.exit(1);
}

try {
  const minted = await mintSetupCapability();
  process.stdout.write([
    `${SETUP_CAPABILITY_DIGEST_BINDING}=${minted.digest}`,
    `${SETUP_CAPABILITY_ISSUED_AT_BINDING}=${minted.issuedAt}`,
    '',
    setupCapabilityUrl(baseUrl, minted.capability),
    '',
  ].join('\n'));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
