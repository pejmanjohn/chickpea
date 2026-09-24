import { timingSafeEqual } from 'node:crypto';

import type { AuthPrincipal } from '../auth/types.ts';
import { resolveConnectorCatalogPreset, type ConnectorPreset } from '../config/presets.ts';
import { isQaTarget } from '../config/qa-targets.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { sha256HexNode } from '../security/digest.ts';

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
 *
 * Each seeded token connection records a short, non-reversible fingerprint of
 * what was seeded (credential plus non-secret fields). A reseed with the same
 * fingerprint reports `present`; a different or unrecorded one reports `stale`
 * and changes nothing unless the request sets `replace`, which rewrites the
 * credential on the existing connection through the ordinary replace path.
 *
 * `fixtures: true` targets the lane's standing fixtures Agent instead of a
 * named one, creating it when missing. That Agent is enabled (connections need
 * an enabled Agent) but unpublished and creator-less, so nobody reaches it in
 * Slack until a verifier deliberately publishes it. Chickpea binds each
 * connection account to exactly one Agent for life (a unique index on the
 * binding table), so fixture connections cannot be shared with run-owned
 * Agents; runs that need them address the fixtures Agent itself.
 */
export const ENVIRONMENT_SEED_PATH = '/internal/environment/seed';
export const ENVIRONMENT_SEED_TOKEN_BINDING = 'CHICKPEA_ENV_SEED_TOKEN';
/** The standing, unpublished Agent that holds a lane's fixture connections. */
export const QA_FIXTURES_AGENT_ID = 'qa-fixtures';
export const QA_FIXTURES_AGENT_NAME = 'QA fixtures';

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
  | 'stale'
  | 'replaced'
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
  /** Why a `stale` connection was not kept as seeded: a different or an unrecorded fingerprint. */
  reason?: 'changed' | 'unrecorded';
  error?: string;
}

export interface SeedRequest {
  agentId: string;
  fixtures: boolean;
  replace: boolean;
  connections: SeedConnectionRequest[];
}

export interface ExistingSeedConnection {
  connectionId: string;
  /** The fingerprint recorded when the seed last wrote this connection. */
  fingerprint?: string;
}

export interface SeedOwner {
  principal: AuthPrincipal;
  workspaceId: string;
}

export interface EnvironmentSeedDependencies {
  /** The active workspace owner the seed acts as, when Admin sign-in is configured. */
  owner(): Promise<SeedOwner | undefined>;
  /** `inactive` covers disabled or archived Agents, which cannot own connections. */
  agentState(agentId: string): Promise<'missing' | 'inactive' | 'ready'>;
  /** Create the standing fixtures Agent (enabled, unpublished, no creator). */
  createFixturesAgent(input: { id: string; name: string }): Promise<void>;
  /** An existing, non-revoked connection for this preset on the Agent. */
  existingConnection(input: {
    agentId: string;
    workspaceId: string;
    presetId: string;
  }): Promise<ExistingSeedConnection | undefined>;
  createConnection(input: {
    owner: SeedOwner;
    agentId: string;
    preset: ConnectorPreset;
    fields: Record<string, string>;
  }): Promise<string>;
  /** Replace the credential and policy on an existing connection this Agent owns. */
  replaceConnection(input: {
    owner: SeedOwner;
    agentId: string;
    connectionId: string;
    preset: ConnectorPreset;
    fields: Record<string, string>;
  }): Promise<void>;
  recordFingerprint(input: { connectionId: string; fingerprint: string }): Promise<void>;
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
  let agentState = await input.dependencies.agentState(request.agentId);
  if (agentState === 'missing' && request.fixtures) {
    try {
      await input.dependencies.createFixturesAgent({ id: request.agentId, name: QA_FIXTURES_AGENT_NAME });
    } catch (error) {
      // A concurrent seed may have created it; the re-read below decides.
      console.error('[chickpea] environment seed fixtures Agent creation failed', JSON.stringify({
        error: describeError(error, undefined),
      }));
    }
    agentState = await input.dependencies.agentState(request.agentId);
  }
  if (agentState === 'missing') {
    return Response.json({ error: 'unknown_agent' }, { status: 404, headers });
  }
  if (agentState === 'inactive') {
    return Response.json({ error: 'agent_inactive' }, { status: 409, headers });
  }
  const results: SeedConnectionResult[] = [];
  for (const connection of request.connections) {
    results.push(await seedOne(connection, request, owner, input.dependencies));
  }
  return Response.json({
    schemaVersion: 'chickpea-environment-seed/v1',
    target: input.env.CHICKPEA_ENV_TARGET,
    agentId: request.agentId,
    ...(request.fixtures ? { fixtures: true } : {}),
    connections: results,
  }, { headers });
}

async function seedOne(
  connection: SeedConnectionRequest,
  request: Pick<SeedRequest, 'agentId' | 'replace'>,
  owner: SeedOwner,
  dependencies: EnvironmentSeedDependencies,
): Promise<SeedConnectionResult> {
  const { agentId } = request;
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
    if (needsConsent || !tokenPreset) {
      // Consent connectors carry no seeded credential to compare.
      return existing
        ? { ...base, status: 'present', connectionId: existing.connectionId }
        : {
            ...base,
            status: 'needs_consent',
            adminUrl: dependencies.adminSetupUrl({ agentId, presetId: preset.id }),
          };
    }
    const credentialOptional = typeof tokenPreset.url === 'string' &&
      tokenPreset.auth?.kind === 'header' && tokenPreset.auth.optional === true;
    if (!connection.credential && !credentialOptional) {
      return existing
        ? { ...base, status: 'missing_credential', connectionId: existing.connectionId }
        : { ...base, status: 'missing_credential' };
    }
    const fields = {
      ...(connection.fields ?? {}),
      ...(connection.credential ? { credential: connection.credential } : {}),
    };
    const fingerprint = seedFingerprint(preset.id, fields);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        return { ...base, status: 'present', connectionId: existing.connectionId };
      }
      if (!request.replace) {
        return {
          ...base,
          status: 'stale',
          connectionId: existing.connectionId,
          reason: existing.fingerprint ? 'changed' : 'unrecorded',
        };
      }
      await dependencies.replaceConnection({
        owner,
        agentId,
        connectionId: existing.connectionId,
        preset: tokenPreset,
        fields,
      });
      await dependencies.recordFingerprint({ connectionId: existing.connectionId, fingerprint });
      return { ...base, status: 'replaced', connectionId: existing.connectionId };
    }
    const connectionId = await dependencies.createConnection({
      owner,
      agentId,
      preset: tokenPreset,
      fields,
    });
    await dependencies.recordFingerprint({ connectionId, fingerprint });
    return { ...base, status: 'created', connectionId };
  } catch (error) {
    console.error('[chickpea] environment seed connection failed', JSON.stringify({
      presetId: preset.id,
      error: describeError(error, connection.credential),
    }));
    return { ...base, status: 'failed', error: safeErrorCode(error) };
  }
}

/**
 * A short non-reversible digest of what was seeded: the preset, the credential,
 * and the non-secret fields in key order. It detects rotation; it is not a
 * credential and cannot be turned back into one.
 */
export function seedFingerprint(presetId: string, fields: Record<string, string>): string {
  const ordered = Object.keys(fields).sort().map((name) => [name, fields[name]]);
  const digest = sha256HexNode(JSON.stringify(['chickpea-environment-seed/v1', presetId, ordered]));
  return `sha256:${digest.slice(0, 16)}`;
}

/** Settings key for a seeded connection's fingerprint. The value is not secret. */
export function seedFingerprintSettingKey(connectionId: string): string {
  return `environment-seed.connection.${connectionId}.fingerprint`;
}

/** Operator log detail: error names and bounded messages, with the credential removed. */
function describeError(error: unknown, credential: string | undefined, depth = 0): unknown {
  if (!(error instanceof Error)) return { type: typeof error };
  const scrub = (text: string) => (credential ? text.split(credential).join('[credential]') : text).slice(0, 300);
  return {
    name: error.name,
    message: scrub(error.message),
    ...(error instanceof AggregateError && depth < 2
      ? { errors: error.errors.slice(0, 3).map((inner) => describeError(inner, credential, depth + 1)) }
      : {}),
  };
}

function authorizedSeed(authorization: string | undefined, env: PlatformEnv): boolean {
  const token = env[ENVIRONMENT_SEED_TOKEN_BINDING];
  const supplied = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  return isQaTarget(env.CHICKPEA_ENV_TARGET) &&
    typeof token === 'string' && TOKEN.test(token) &&
    Boolean(supplied) && timingSafeEqual(Buffer.from(token), Buffer.from(supplied!));
}

export function parseSeedRequest(text: string): SeedRequest | undefined {
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return undefined;
  let body: unknown;
  try { body = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(body)) return undefined;
  if (body.fixtures !== undefined && typeof body.fixtures !== 'boolean') return undefined;
  if (body.replace !== undefined && typeof body.replace !== 'boolean') return undefined;
  const fixtures = body.fixtures === true;
  // Exactly one target: a named Agent, or the lane's standing fixtures Agent.
  if (fixtures ? body.agentId !== undefined
    : typeof body.agentId !== 'string' || !AGENT_ID.test(body.agentId)) return undefined;
  const agentId = fixtures ? QA_FIXTURES_AGENT_ID : body.agentId as string;
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
  return { agentId, fixtures, replace: body.replace === true, connections };
}

/** Error codes only; a thrown message could quote provider output. */
function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'connection_failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const ENVIRONMENT_MODELS_PATH = '/internal/environment/models';

/**
 * Read-only lane model roles for `npm run env -- capabilities`: the workspace
 * default chat model and the image role. Same QA-only gate and seed token as
 * the seed route; anything else gets the same empty 404.
 */
export async function environmentModelsResponse(input: {
  authorization: string | undefined;
  env: PlatformEnv;
  readModels: () => Promise<{ defaultChatModel: string | null; imageModel: string | null } | undefined>;
}): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  if (!authorizedSeed(input.authorization, input.env)) {
    return new Response('{}', { status: 404, headers });
  }
  const models = await input.readModels();
  if (!models) return Response.json({ error: 'installation_unavailable' }, { status: 503, headers });
  return Response.json({
    schemaVersion: 'chickpea-environment-models/v1',
    target: input.env.CHICKPEA_ENV_TARGET,
    ...models,
  }, { headers });
}
