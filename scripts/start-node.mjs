#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

import { assertNodeVersion } from './lib/node-version.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 60_000;

export function parseStartArguments(args) {
  let envFile;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--env-file') throw new Error(`Unknown option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--env-file requires a file path');
    if (envFile) throw new Error('--env-file may only be provided once');
    envFile = value;
    index += 1;
  }
  if (!envFile) throw new Error('--env-file <path> is required for production startup');
  return { envFile };
}

export function applyEnvironmentFile(file, target = process.env) {
  const resolved = path.resolve(file);
  let parsed;
  try {
    parsed = parseEnv(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot load production environment file ${resolved}: ${error.message}`, { cause: error });
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in target)) target[key] = value;
  }
  return resolved;
}

export function resolveServerOptions(environment = process.env) {
  const rawHost = Object.hasOwn(environment, 'HOST') ? environment.HOST : DEFAULT_HOST;
  if (typeof rawHost !== 'string' || !rawHost || !/^[A-Za-z0-9._:-]+$/.test(rawHost)) {
    throw new Error('HOST must be a hostname or IP address without a scheme, path, or whitespace');
  }
  const rawPort = environment.PORT ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(rawPort)) throw new Error('PORT must be an integer from 1 through 65535');
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  return { hostname: rawHost, port };
}

export function assertProductionArtifact(file) {
  if (!existsSync(file)) {
    throw new Error(`Production Node artifact is missing at ${file}. Run npm run flue:build first.`);
  }
  return file;
}

export async function startNodeApplication({
  application,
  loadApplication,
  background,
  serverOptions,
}) {
  const ownership = background.acquireNodeProcessOwnership();
  let flueLifecycle;
  let backgroundAttempted = false;
  try {
    const loadedApplication = application ?? await loadApplication();
    flueLifecycle = await loadedApplication.startFlueNodeServer(serverOptions);
    backgroundAttempted = true;
    await background.startNodeBackground();
  } catch (error) {
    if (backgroundAttempted) await background.stopNodeBackground().catch(() => undefined);
    if (flueLifecycle) await flueLifecycle.stop().catch(() => undefined);
    ownership.release();
    throw error;
  }
  let stopping;
  return {
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        const failures = [];
        try { await background.stopNodeBackground(); } catch (error) { failures.push(error); }
        try { await flueLifecycle.stop(); } catch (error) { failures.push(error); }
        try { ownership.release(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Node shutdown failed');
      })();
      return stopping;
    },
  };
}

export async function startProductionNode({ args = process.argv.slice(2) } = {}) {
  assertNodeVersion();
  const { envFile } = parseStartArguments(args);
  applyEnvironmentFile(envFile);
  const options = resolveServerOptions();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const appArtifact = assertProductionArtifact(path.join(root, 'dist', 'app.mjs'));
  const backgroundArtifact = assertProductionArtifact(path.join(root, 'dist', 'node-background.mjs'));
  const background = await import(pathToFileURL(backgroundArtifact).href);
  if (typeof background.acquireNodeProcessOwnership !== 'function' ||
      typeof background.startNodeBackground !== 'function' ||
      typeof background.stopNodeBackground !== 'function') {
    throw new Error(`Production Node artifact at ${backgroundArtifact} is incomplete. Rebuild it with npm run flue:build.`);
  }
  const lifecycle = await startNodeApplication({
    loadApplication: async () => {
      const application = await import(pathToFileURL(appArtifact).href);
      if (typeof application.startFlueNodeServer !== 'function') {
        throw new Error(`Production Node artifact at ${appArtifact} does not export startFlueNodeServer. Rebuild it with npm run flue:build.`);
      }
      return application;
    },
    background,
    serverOptions: options,
  });
  // The managed tunnel must wait for this child's successful bind, not merely
  // an HTTP response that another process on the requested port could serve.
  if (process.send) process.send({ type: 'chickpea-ready' });
  let shutdown;
  const stop = (exitCode) => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      let finalExitCode = exitCode;
      const timeout = setTimeout(() => {
        console.error('[chickpea] Shutdown timed out, exiting.');
        process.exit(exitCode);
      }, SHUTDOWN_TIMEOUT_MS);
      timeout.unref();
      try {
        await lifecycle.stop();
      } catch {
        console.error('[chickpea] Graceful shutdown failed.');
        finalExitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
      process.exit(finalExitCode);
    })();
    return shutdown;
  };
  process.once('SIGINT', () => { void stop(130); });
  process.once('SIGTERM', () => { void stop(143); });
  process.once('disconnect', () => { void stop(0); });
  return lifecycle;
}

export function isMainModule(argvEntry = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  startProductionNode().catch((error) => {
    console.error(`[chickpea] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
