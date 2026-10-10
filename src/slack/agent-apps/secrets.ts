/**
 * Custody of an Agent app's secrets and of the workspace's Slack app
 * configuration token, in the settings store's encrypted realm under Core's
 * keyring. Never the identity store: a bad envelope here fails one Agent, and
 * never the tenant's recovery gate.
 */
import type { EncryptedCredentialStore } from '../../config/settings-store.ts';
import { sha256Hex } from '../../security/digest.ts';
import {
  type CredentialKeyring,
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
  workspaceCredentialContext,
} from '../secret-envelope.ts';
import { type AgentAppSlackApi, SlackRefused, logSlackRefusal } from './slack-api.ts';

export interface AgentAppSecrets {
  clientSecret: string;
  signingSecret: string;
  botToken?: string;
}

export interface SecretDeps {
  credentials: EncryptedCredentialStore;
  keyring: CredentialKeyring;
  slack: Pick<AgentAppSlackApi, 'rotate'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** An access token with this much life left is used as is. */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000;
/** A rotation claim older than this is taken over. */
export const ROTATION_CLAIM_MS = 60_000;
const LOST_CLAIM_REREADS = 3;
const LOST_CLAIM_WAIT_MS = 1_000;
const REFRESH_TOKEN = /^xoxe-1-[A-Za-z0-9._-]{8,}$/;

/** The workspace has no usable configuration token; the Owner pastes again. */
export class ConfigTokenNeeded extends Error {
  readonly name = 'ConfigTokenNeeded';
  constructor(readonly teamId: string) {
    super('A Slack app configuration token is needed.');
  }
}

/** This app's envelope cannot be opened; only this Agent is affected. */
export class AgentAppSecretsUnreadable extends Error {
  readonly name = 'AgentAppSecretsUnreadable';
  constructor(readonly appId: string) {
    super(`The secrets of Slack app ${appId} cannot be read.`);
  }
}

/** An envelope that cannot be opened reads as no secrets; a store that cannot be reached still throws. */
export function unreadableAsNone(error: unknown): undefined {
  if (error instanceof AgentAppSecretsUnreadable) return undefined;
  throw error;
}

/** A compare-and-set on the realm lost to another writer. */
export class LostRevision extends Error {
  readonly name = 'LostRevision';
  constructor(readonly key: string) {
    super(`Another writer changed ${key} first.`);
  }
}

/** The realm admits only `[a-z0-9_.-]` keys, so the Slack ID is lowercased here and kept exact in the envelope context. */
export function agentAppSecretKey(appId: string): string {
  return `agent-slack-app.${appId.toLowerCase()}`;
}

export function configurationTokenKey(teamId: string): string {
  return `slack-configuration-token.${teamId.toLowerCase()}`;
}

/** The realm wants a context ID of 16 to 128 word characters; a digest of the owner fits and still binds the envelope. */
function contextIdFor(owner: string): Promise<string> {
  return sha256Hex(owner);
}

function appContext(appId: string, contextId: string, revision: string) {
  return workspaceCredentialContext({
    contextId,
    identityId: agentAppSecretKey(appId),
    appId,
    purpose: 'agent_slack_app',
    revision,
  });
}

async function tokenContext(teamId: string, revision: string) {
  return workspaceCredentialContext({
    contextId: await contextIdFor(`team:${teamId}`),
    identityId: configurationTokenKey(teamId),
    appId: 'configuration',
    purpose: 'slack_configuration_token',
    revision,
  });
}

export async function readAppSecrets(
  d: SecretDeps,
  appId: string,
): Promise<{ agentId: string; revision: string; secrets: AgentAppSecrets } | undefined> {
  const record = await d.credentials.getEncryptedCredentialRevision(agentAppSecretKey(appId));
  if (!record) return undefined;
  let opened: Record<string, string>;
  try {
    opened = await decryptSlackSecretEnvelope<Record<string, string>>(
      d.keyring,
      appContext(appId, record.contextId, record.revision),
      record.envelope,
    );
  } catch {
    throw new AgentAppSecretsUnreadable(appId);
  }
  const { agentId, clientSecret, signingSecret, botToken } = opened;
  if (!agentId || !clientSecret || !signingSecret) throw new AgentAppSecretsUnreadable(appId);
  return {
    agentId,
    revision: record.revision,
    secrets: { clientSecret, signingSecret, ...(botToken ? { botToken } : {}) },
  };
}

/** Throws LostRevision when `expected` is no longer the stored revision. */
export async function writeAppSecrets(
  d: SecretDeps,
  appId: string,
  agentId: string,
  secrets: AgentAppSecrets,
  expected: string | null,
): Promise<string> {
  const key = agentAppSecretKey(appId);
  const revision = crypto.randomUUID();
  const context = appContext(appId, await contextIdFor(`agent:${agentId}`), revision);
  const envelope = await encryptSlackSecretEnvelope(d.keyring, context, {
    agentId,
    clientSecret: secrets.clientSecret,
    signingSecret: secrets.signingSecret,
    ...(secrets.botToken ? { botToken: secrets.botToken } : {}),
  });
  const record = await d.credentials.replaceEncryptedCredentialRevision({
    key,
    expectedRevision: expected,
    revision,
    contextId: context.deploymentId,
    envelope,
  });
  if (!record) throw new LostRevision(key);
  return record.revision;
}

/** Gone afterwards whether or not this call removed it; throws LostRevision when another revision remains. */
export async function deleteAppSecrets(d: SecretDeps, appId: string, expected: string): Promise<void> {
  const key = agentAppSecretKey(appId);
  if (await d.credentials.deleteEncryptedCredentialRevision(key, expected)) return;
  if (await d.credentials.getEncryptedCredentialRevision(key)) throw new LostRevision(key);
}

interface ConfigurationTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  rotatingSince?: number;
}

/** A pair that cannot be opened is as good as none: the Owner pastes a new token, which replaces it. */
async function readPair(
  d: SecretDeps,
  teamId: string,
): Promise<{ revision: string; pair: ConfigurationTokenPair } | undefined> {
  const record = await d.credentials.getEncryptedCredentialRevision(configurationTokenKey(teamId));
  if (!record) return undefined;
  let opened: Record<string, string>;
  try {
    opened = await decryptSlackSecretEnvelope<Record<string, string>>(
      d.keyring,
      await tokenContext(teamId, record.revision),
      record.envelope,
    );
  } catch {
    throw new ConfigTokenNeeded(teamId);
  }
  const expiresAt = Number(opened.expiresAt);
  const rotatingSince = opened.rotatingSince === undefined ? undefined : Number(opened.rotatingSince);
  if (!opened.accessToken || !opened.refreshToken || !Number.isFinite(expiresAt)) throw new ConfigTokenNeeded(teamId);
  return {
    revision: record.revision,
    pair: {
      accessToken: opened.accessToken,
      refreshToken: opened.refreshToken,
      expiresAt,
      ...(rotatingSince !== undefined && Number.isFinite(rotatingSince) ? { rotatingSince } : {}),
    },
  };
}

/** The new revision, or undefined when `expected` lost. */
async function writePair(
  d: SecretDeps,
  teamId: string,
  pair: ConfigurationTokenPair,
  expected: string | null,
): Promise<string | undefined> {
  const revision = crypto.randomUUID();
  const context = await tokenContext(teamId, revision);
  const envelope = await encryptSlackSecretEnvelope(d.keyring, context, {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: String(pair.expiresAt),
    ...(pair.rotatingSince !== undefined ? { rotatingSince: String(pair.rotatingSince) } : {}),
  });
  const record = await d.credentials.replaceEncryptedCredentialRevision({
    key: configurationTokenKey(teamId),
    expectedRevision: expected,
    revision,
    contextId: context.deploymentId,
    envelope,
  });
  return record?.revision;
}

/** Paste: refuses an access token, rotates at once, refuses another team, stores the new pair. */
export async function saveConfigurationToken(
  d: SecretDeps,
  teamId: string,
  refreshToken: string,
): Promise<'saved' | 'not_refresh_token' | 'rejected' | 'other_workspace'> {
  const token = refreshToken.trim();
  if (!REFRESH_TOKEN.test(token)) return 'not_refresh_token';
  let rotated;
  try {
    rotated = await d.slack.rotate(token);
  } catch (error) {
    if (!(error instanceof SlackRefused)) throw error;
    logSlackRefusal('rotate', {}, error);
    return 'rejected';
  }
  if (rotated.teamId !== teamId) return 'other_workspace';
  const pair = { accessToken: rotated.accessToken, refreshToken: rotated.refreshToken, expiresAt: rotated.expiresAt };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentRevision = (await d.credentials.getEncryptedCredentialRevision(configurationTokenKey(teamId)))?.revision ?? null;
    if (await writePair(d, teamId, pair, currentRevision)) return 'saved';
  }
  throw new LostRevision(configurationTokenKey(teamId));
}

export async function hasConfigurationToken(d: SecretDeps, teamId: string): Promise<boolean> {
  return (await d.credentials.getEncryptedCredentialRevision(configurationTokenKey(teamId))) !== undefined;
}

/** Deletes Chickpea's stored pair and nothing in Slack. */
export async function deleteConfigurationToken(d: SecretDeps, teamId: string): Promise<'deleted' | 'none'> {
  const key = configurationTokenKey(teamId);
  const record = await d.credentials.getEncryptedCredentialRevision(key);
  if (!record) return 'none';
  await d.credentials.deleteEncryptedCredentialRevision(key, record.revision);
  return 'deleted';
}

/** Runs `use` with a fresh access token; the rotation is claimed by compare-and-set first. Throws ConfigTokenNeeded. */
export async function withConfigurationToken<T>(
  d: SecretDeps,
  teamId: string,
  use: (accessToken: string) => Promise<T>,
): Promise<T> {
  return use(await freshAccessToken(d, teamId));
}

function usable(pair: ConfigurationTokenPair, now: number): boolean {
  return pair.expiresAt - now > ACCESS_TOKEN_MARGIN_MS;
}

async function freshAccessToken(d: SecretDeps, teamId: string): Promise<string> {
  const now = d.now?.() ?? Date.now();
  let current = await readPair(d, teamId);
  for (let attempt = 0; ; attempt += 1) {
    if (!current) throw new ConfigTokenNeeded(teamId);
    if (usable(current.pair, now)) return current.pair.accessToken;
    const claimed = current.pair.rotatingSince !== undefined && now - current.pair.rotatingSince < ROTATION_CLAIM_MS;
    if (!claimed) {
      const claim = await writePair(d, teamId, { ...current.pair, rotatingSince: now }, current.revision);
      if (claim) return rotateHolding(d, teamId, current.pair, claim, now);
    }
    if (attempt >= LOST_CLAIM_REREADS) throw new ConfigTokenNeeded(teamId);
    await (d.sleep ?? sleep)(LOST_CLAIM_WAIT_MS);
    current = await readPair(d, teamId);
  }
}

/** The claim holder rotates; a spent refresh token means another rotator won, or the pair is dead. */
async function rotateHolding(
  d: SecretDeps,
  teamId: string,
  pair: ConfigurationTokenPair,
  claimRevision: string,
  now: number,
): Promise<string> {
  let rotated;
  try {
    rotated = await d.slack.rotate(pair.refreshToken);
  } catch (error) {
    if (!(error instanceof SlackRefused)) throw error;
    logSlackRefusal('rotate', {}, error);
    const latest = await readPair(d, teamId);
    if (latest && latest.pair.refreshToken !== pair.refreshToken && usable(latest.pair, now)) {
      return latest.pair.accessToken;
    }
    if (latest) await d.credentials.deleteEncryptedCredentialRevision(configurationTokenKey(teamId), latest.revision);
    throw new ConfigTokenNeeded(teamId);
  }
  await writePair(d, teamId, {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt,
  }, claimRevision);
  return rotated.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
