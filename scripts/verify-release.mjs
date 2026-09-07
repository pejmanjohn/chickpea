#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { validateReleaseManifest } from './lib/release-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = validateReleaseManifest(root);
console.log(`Release v${manifest.version}: version and migration contract verified.`);
