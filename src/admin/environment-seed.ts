import { timingSafeEqual } from 'node:crypto';

import type { AuthPrincipal } from '../auth/types.ts';
import { resolveConnectorCatalogPreset, type ConnectorPreset } from '../config/presets.ts';
import { isQaTarget } from '../config/qa-targets.ts';
import type { PlatformEnv } from '../config/state-backend.ts';

/**
 * Operator-only connection seeding for QA lanes.
 *
 * A QA lane is sometimes rebuilt from a fresh install, which empties its
 * database. The operator keeps standing test credentials outside the lane and
 * reseeds them here. The route exists only on QA targets and only answers the
 * lane's own seed token (`CHICKPEA_ENV_SEED_TOKEN`, installed by the guarded
 * lane deploy). Everything else gets the same empty 404.
 *
 * Token connectors (API keys and MCP bearer/header credentials) are created
 * directly on the named Agent through the ordinary connection service, as the
 * workspace owner. OAuth and managed (Composio) connectors need a real consent,
 * so they are returned as Admin setup links for the verifier to finish in a
 * signed-in browser. Responses never contain credentials.
 */
export const ENVIRONMENT_SEED_PATH = '/internal/environment/seed';
export const ENVIRONMENT_SEED_TOKEN_BINDING = 'CHICKPEA_ENV_SEED_TOKEN';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_CONNECTIONS = 40;
const MAX_CREDENTIAL_LENGTH = 8_192;
const MAX_FIELD_LENGTH = 256;
const MAX_BODY_BYTES = 512 * 1024;

export interface SeedConnectionRequest {
  connector: string;
  credential?: string;
  fields?: Record<string, string>;
}

export type SeedConnectionStatus =
  | 'created'
  | 'present'
  | 'needs_consent'
  | 'unknown_connector'
  | 'missing_credential'
  | 'failed';

export interface SeedConnectionResult {
  connector: string;
  status: SeedConnectionStatus;
  presetId?: string;
  connectionId?: string;
  adminUrl?: string;
  error?: string;
}

export interface SeedOwner {
  principal: AuthPrincipal;
  workspaceId: string;
}

export interface EnvironmentSeedDependencies {
  /** The active workspace owner the seed acts as, when Admin sign-in is configured. */
  owner(): Promise<SeedOwner | undefined>;
  agentExists(agentId: string): Promise<boolean>;
  /** An existing, non-revoked connection for this preset on the Agent. */
  existingConnection(input: { agentId: string; workspaceId: string; presetId: string }): Promise<string | undefined>;
  createConnection(input: {
    owner: SeedOwner;
    agentId: string;
    preset: ConnectorPreset;
    fields: Record<string, string>;
  }): Promise<string>;
  adminSetupUrl(input: { agentId: string; presetId: string }): string;
}

export async function environmentSeedResponse(input: {
  authorization: string | undefined;
  env: PlatformEnv;
  readBody: () => Promise<string>;
  dependencies: EnvironmentSeedDependencies;
}): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  if (!authorizedSeed(input.authorization, input.env)) {
    return new Response('{}', { status: 404, headers });
  }
  const request = parseSeedRequest(await input.readBody().catch(() => ''));
  if (!request) {
    return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  }
  const owner = await input.dependencies.owner();
  if (!owner) {
    return Response.json({ error: 'owner_unavailable' }, { status: 503, headers });
  }
  if (!(await input.dependencies.agentExists(request.agentId))) {
    return Response.json({ error: 'unknown_agent' }, { status: 404, headers });
  }
  const results: SeedConnectionResult[] = [];
  for (const connection of request.connections) {
    results.push(await seedOne(connection, request.agentId, owner, input.dependencies));
  }
  return Response.json({
    schemaVersion: 'chickpea-environment-seed/v1',
    target: input.env.CHICKPEA_ENV_TARGET,
    agentId: request.agentId,
    connections: results,
  }, { headers });
}

async function seedOne(
  connection: SeedConnectionRequest,
  agentId: string,
  owner: SeedOwner,
  dependencies: EnvironmentSeedDependencies,
): Promise<SeedConnectionResult> {
  const preset = resolveConnectorCatalogPreset(connection.connector);
  if (!preset) return { connector: connection.connector, status: 'unknown_connector' };
  const base = { connector: connection.connector, presetId: preset.id };
  try {
    const tokenPreset = 'managedToolkit' in preset ? undefined : preset;
    const needsConsent = !tokenPreset ||
      (typeof tokenPreset.url === 'string' && tokenPreset.auth?.kind === 'oauth');
    const existing = await dependencies.existingConnection({
      agentId,
      workspaceId: owner.workspaceId,
      presetId: preset.id,
    });
    if (existing) return { ...base, status: 'present', connectionId: existing };
    if (needsConsent || !tokenPreset) {
      return {
        ...base,
        status: 'needs_consent',
        adminUrl: dependencies.adminSetupUrl({ agentId, presetId: preset.id }),
      };
    }
    const credentialOptional = typeof tokenPreset.url === 'string' &&
      tokenPreset.auth?.kind === 'header' && tokenPreset.auth.optional === true;
    if (!connection.credential && !credentialOptional) {
      return { ...base, status: 'missing_credential' };
    }
    const connectionId = await dependencies.createConnection({
      owner,
      agentId,
      preset: tokenPreset,
      fields: {
        ...(connection.fields ?? {}),
        ...(connection.credential ? { credential: connection.credential } : {}),
      },
    });
    return { ...base, status: 'created', connectionId };
  } catch (error) {
    return { ...base, status: 'failed', error: safeErrorCode(error) };
  }
}

function authorizedSeed(authorization: string | undefined, env: PlatformEnv): boolean {
  const token = env[ENVIRONMENT_SEED_TOKEN_BINDING];
  const supplied = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  return isQaTarget(env.CHICKPEA_ENV_TARGET) &&
    typeof token === 'string' && TOKEN.test(token) &&
    Boolean(supplied) && timingSafeEqual(Buffer.from(token), Buffer.from(supplied!));
}

export function parseSeedRequest(text: string): { agentId: string; connections: SeedConnectionRequest[] } | undefined {
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return undefined;
  let body: unknown;
  try { body = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(body) || typeof body.agentId !== 'string' || !AGENT_ID.test(body.agentId)) return undefined;
  const list = body.connections;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CONNECTIONS) return undefined;
  const connections: SeedConnectionRequest[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.connector !== 'string') return undefined;
    const connector = entry.connector.trim();
    if (!connector || connector.length > 64) return undefined;
    const request: SeedConnectionRequest = { connector };
    if (entry.credential !== undefined) {
      if (typeof entry.credential !== 'string' || entry.credential.length > MAX_CREDENTIAL_LENGTH) return undefined;
      if (entry.credential.trim()) request.credential = entry.credential.trim();
    }
    if (entry.fields !== undefined) {
      if (!isRecord(entry.fields)) return undefined;
      const fields: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry.fields)) {
        if (!FIELD_NAME.test(name) || name === 'credential' ||
            typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) return undefined;
        fields[name] = value;
      }
      request.fields = fields;
    }
    connections.push(request);
  }
  return { agentId: body.agentId, connections };
}

/** Error codes only; a thrown message could quote provider output. */
function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'connection_failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
