#!/usr/bin/env node
/**
 * Seed standing test connections into a QA lane.
 *
 *   npm run lane:seed -- <amber|cobalt|violet> --agent <agentId> [--manifest <path>] [--dry-run]
 *
 * The manifest (default ~/.chickpea/qa-seed.json) holds no secrets. It names
 * catalog connectors and, for token connectors, which name in the lane
 * secrets file carries the credential:
 *
 *   { "schemaVersion": "chickpea-lane-seed/v1",
 *     "connections": [
 *       { "connector": "asana", "secret": "ASANA_QA_TOKEN" },
 *       { "connector": "zendesk", "secret": "ZENDESK_QA_TOKEN", "fields": { "workspaceSubdomain": "acme" } },
 *       { "connector": "gmail" } ] }
 *
 * Values come from the lane secrets file (LANE__NAME overrides NAME) and go
 * straight to the lane's seed route; they are never printed. Token connectors
 * are created on the Agent; OAuth and managed connectors come back as Admin
 * setup links to finish with a consent click in a signed-in browser.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  laneCredentialsDirectory,
  LANE_SECRET_TARGETS,
  laneSecretValue,
  readLaneSecretEntries,
  readLaneSeedToken,
} from './lib/lane-secrets.mjs';

const SEED_PATH = '/internal/environment/seed';
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export function parseArguments(argv) {
  const [lane, ...rest] = argv;
  const options = { lane, manifest: path.join(homedir(), '.chickpea', 'qa-seed.json'), dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--agent') options.agentId = rest[++index];
    else if (flag === '--manifest') options.manifest = rest[++index];
    else if (flag === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument "${flag}".`);
  }
  if (!LANE_SECRET_TARGETS.includes(options.lane)) throw new Error(`Choose a lane: ${LANE_SECRET_TARGETS.join(', ')}.`);
  if (!AGENT_ID.test(options.agentId ?? '')) throw new Error('Pass --agent <agentId> for the Agent that receives the connections.');
  if (!path.isAbsolute(options.manifest ?? '')) throw new Error('--manifest must be an absolute path.');
  return options;
}

export function parseManifest(text) {
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Error('The seed manifest is not readable JSON.'); }
  if (manifest?.schemaVersion !== 'chickpea-lane-seed/v1' || !Array.isArray(manifest.connections) ||
      manifest.connections.length === 0) {
    throw new Error('The seed manifest needs schemaVersion "chickpea-lane-seed/v1" and a non-empty connections list.');
  }
  return manifest.connections.map((entry, index) => {
    if (typeof entry?.connector !== 'string' || !entry.connector.trim()) {
      throw new Error(`Seed manifest connection ${index + 1} needs a connector.`);
    }
    if (entry.secret !== undefined && (typeof entry.secret !== 'string' || !SECRET_NAME.test(entry.secret))) {
      throw new Error(`Seed manifest connection ${index + 1} names an invalid secret.`);
    }
    if (entry.fields !== undefined && (typeof entry.fields !== 'object' || entry.fields === null ||
        Object.values(entry.fields).some((value) => typeof value !== 'string'))) {
      throw new Error(`Seed manifest connection ${index + 1} has invalid fields.`);
    }
    return {
      connector: entry.connector.trim(),
      ...(entry.secret ? { secret: entry.secret } : {}),
      ...(entry.fields ? { fields: { ...entry.fields } } : {}),
    };
  });
}

/** Build the request body. Returns names that were declared but empty so they can be reported. */
export function buildSeedRequest({ lane, agentId, connections, entries }) {
  const missing = [];
  const body = {
    agentId,
    connections: connections.map((connection) => {
      const credential = connection.secret && entries ? laneSecretValue(entries, lane, connection.secret) : undefined;
      if (connection.secret && !credential) missing.push(connection.secret);
      return {
        connector: connection.connector,
        ...(credential ? { credential } : {}),
        ...(connection.fields ? { fields: connection.fields } : {}),
      };
    }),
  };
  return { body, missing };
}

export function laneOrigin(lane, env = process.env) {
  const file = path.join(laneCredentialsDirectory(env), `${lane}-live.json`);
  if (!existsSync(file)) throw new Error(`No lane origin: ${file} is missing.`);
  let origin;
  try { origin = JSON.parse(readFileSync(file, 'utf8')).origin; } catch { origin = undefined; }
  const url = typeof origin === 'string' ? new URL(origin) : undefined;
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`The ${lane} lane origin in ${file} must be an https URL without credentials.`);
  }
  return url.origin;
}

export function describeResults(response) {
  return (response.connections ?? []).map((result) => {
    const detail = result.connectionId ?? result.adminUrl ?? result.error ?? '';
    return `  ${result.connector.padEnd(24)} ${result.status.padEnd(18)} ${detail}`.trimEnd();
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(options.manifest)) throw new Error(`No seed manifest at ${options.manifest}.`);
  const connections = parseManifest(readFileSync(options.manifest, 'utf8'));
  const entries = readLaneSecretEntries();
  const { body, missing } = buildSeedRequest({
    lane: options.lane, agentId: options.agentId, connections, entries,
  });
  if (missing.length) console.log(`Empty in the lane secrets file (sent without a credential): ${missing.join(', ')}`);
  if (options.dryRun) {
    for (const connection of body.connections) {
      console.log(`  ${connection.connector.padEnd(24)} ${connection.credential ? 'credential set' : 'no credential'}`);
    }
    return;
  }
  const seedToken = readLaneSeedToken(options.lane);
  if (!seedToken) {
    throw new Error(`The ${options.lane} lane has no seed token yet. Deploy it once with the guarded deploy.`);
  }
  const origin = laneOrigin(options.lane);
  const response = await fetch(new URL(SEED_PATH, origin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${seedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok) {
    const code = typeof parsed?.error === 'string' ? parsed.error : `http_${response.status}`;
    if (code === 'agent_inactive') {
      throw new Error(`Agent ${options.agentId} is disabled or archived on ${options.lane}; enable it before seeding connections.`);
    }
    throw new Error(response.status === 404 && !parsed?.error
      ? `The ${options.lane} lane did not accept its seed token (404). Redeploy the lane so it serves the seed route and token.`
      : `Seeding ${options.lane} failed: ${code}.`);
  }
  console.log(`Seeded ${options.lane} Agent ${options.agentId}:`);
  for (const line of describeResults(parsed)) console.log(line);
  const consent = (parsed.connections ?? []).filter((result) => result.status === 'needs_consent');
  if (consent.length) console.log('Open each setup link in a browser signed in to the lane Admin to finish consent.');
  if ((parsed.connections ?? []).some((result) => ['failed', 'unknown_connector', 'missing_credential'].includes(result.status))) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
