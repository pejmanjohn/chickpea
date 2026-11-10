#!/usr/bin/env node
/**
 * Builds the Worker in the current directory, an export of another commit,
 * for scripts/worker-closure.mjs to measure: `node build-worker-report.mjs
 * <report file name>`. The export links this checkout's node_modules, and
 * preserveSymlinks keeps each package's module id as a checkout's own build
 * writes it, so the two reports compare module by module. The report is this
 * checkout's, under its own name, whatever that commit's vite.config.ts writes.
 */
import path from 'node:path';
import process from 'node:process';
import { createBuilder } from 'vite';
import { bundleModuleReport } from './bundle-module-report.mjs';

const root = process.cwd();
// As `vite build` does: every environment, the Worker's and the client's.
const builder = await createBuilder({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'error',
  resolve: { preserveSymlinks: true },
  plugins: [bundleModuleReport(process.argv[2])],
});
await builder.buildApp();
