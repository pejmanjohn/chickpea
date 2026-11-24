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
import { type AgentAppSlackApi, type AgentAppSlackStep, SlackRefused, logSlackRefusal } from './slack-api.ts';

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

export type OwnAppSecrets =
  | { kind: 'own'; revision: string; secrets: AgentAppSecrets }
  | { kind: 'missing' | 'unreadable' | 'another_agent' };

/**
 * The one test before Chickpea uses, changes or deletes a Slack app: its
 * record exists, opens, and names this Agent. A configuration token can change
 * or delete any app its owner collaborates on, so an app ID alone proves
 * nothing. Both refusals that point at a fault are logged for the operator; a
 * store that cannot be reached still throws.
 */
export async function readOwnAppSecrets(
  d: SecretDeps,
  appId: string,
  agentId: string,
  use: Extract<AgentAppSlackStep, 'update' | 'icon' | 'exchange' | 'uninstall' | 'delete' | 'join'> | 'execution' | 'ingress' | 'end',
): Promise<OwnAppSecrets> {
  let stored;
  try {
    stored = await readAppSecrets(d, appId);
  } catch (error) {
    if (!(error instanceof AgentAppSecretsUnreadable)) throw error;
    console.warn(`[chickpea] agent_app_secrets_unreadable ${JSON.stringify({ appId })}`);
    return { kind: 'unreadable' };
  }
  if (!stored) return { kind: 'missing' };
  if (stored.agentId !== agentId) {
    console.warn({ event: 'chickpea.agent_app.record_refused', use, agentId, appId, recordAgentId: stored.agentId });
    return { kind: 'another_agent' };
  }
  return { kind: 'own', revision: stored.revision, secrets: stored.secrets };
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
  /** The Owner who pasted the token, and when; kept through every rotation. Pairs stored before this was kept lack it. */
  pastedBy?: string;
  pastedAt?: number;
}

/** What Admin may say about the stored token: whether there is one, who pasted it and when; never the token. */
export type ConfigurationTokenStatus =
  | { stored: false }
  | { stored: true; pastedBy: string | null; pastedAt: number | null };

/** A pair that cannot be opened is as good as none: the Owner pastes a new token, which replaces it. */
async function readPair(
  d: SecretDeps,
  teamId: string,
): Promise<{ revision: string; pair: ConfigurationTokenPair } | undefined> {
  const record = await d.credentials.getEncryptedCredentialRevision(configurationTokenKey(teamId));
  return record ? { revision: record.revision, pair: await openPair(d, teamId, record) } : undefined;
}

async function openPair(
  d: SecretDeps,
  teamId: string,
  record: { revision: string; envelope: Parameters<typeof decryptSlackSecretEnvelope>[2] },
): Promise<ConfigurationTokenPair> {
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
  const pastedAt = opened.pastedAt === undefined ? undefined : Number(opened.pastedAt);
  if (!opened.accessToken || !opened.refreshToken || !Number.isFinite(expiresAt)) throw new ConfigTokenNeeded(teamId);
  return {
    accessToken: opened.accessToken,
    refreshToken: opened.refreshToken,
    expiresAt,
    ...(rotatingSince !== undefined && Number.isFinite(rotatingSince) ? { rotatingSince } : {}),
    ...(opened.pastedBy ? { pastedBy: opened.pastedBy } : {}),
    ...(pastedAt !== undefined && Number.isFinite(pastedAt) ? { pastedAt } : {}),
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
    ...(pair.pastedBy ? { pastedBy: pair.pastedBy } : {}),
    ...(pair.pastedAt !== undefined ? { pastedAt: String(pair.pastedAt) } : {}),
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

/**
 * Paste: refuses an access token, rotates at once, refuses another team, then
 * retires any stored pair as removal does, best effort, and stores the new
 * pair with who pasted it.
 */
export async function saveConfigurationToken(
  d: SecretDeps,
  teamId: string,
  refreshToken: string,
  pastedBy?: string,
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
  const pair: ConfigurationTokenPair = {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt,
    ...(pastedBy ? { pastedBy, pastedAt: d.now?.() ?? Date.now() } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await d.credentials.getEncryptedCredentialRevision(configurationTokenKey(teamId));
    if (current) await spendRefreshToken(d, teamId, current);
    if (await writePair(d, teamId, pair, current?.revision ?? null)) return 'saved';
  }
  throw new LostRevision(configurationTokenKey(teamId));
}

export async function hasConfigurationToken(d: SecretDeps, teamId: string): Promise<boolean> {
  return (await d.credentials.getEncryptedCredentialRevision(configurationTokenKey(teamId))) !== undefined;
}

/** A pair that cannot be opened reads as none, as it does at the next start. */
export async function configurationTokenStatus(d: SecretDeps, teamId: string): Promise<ConfigurationTokenStatus> {
  let stored;
  try {
    stored = await readPair(d, teamId);
  } catch (error) {
    if (error instanceof ConfigTokenNeeded) return { stored: false };
    throw error;
  }
  return stored ? { stored: true, pastedBy: stored.pair.pastedBy ?? null, pastedAt: stored.pair.pastedAt ?? null } : { stored: false };
}

/**
 * Removal. Slack has no revoke call, and stops listing a token while its
 * refresh token still works, so the stored refresh token is rotated once and
 * the new pair is never kept: nobody then holds a working one. The stored copy
 * is deleted whatever Slack answers; `unconfirmed` means the rotation did not
 * succeed, so Slack may still accept the token. A rotation that writes a newer
 * pair first has that pair spent and deleted on the retry; throws LostRevision
 * when a pair still stays.
 */
export async function discardConfigurationToken(d: SecretDeps, teamId: string): Promise<'discarded' | 'unconfirmed' | 'none'> {
  const key = configurationTokenKey(teamId);
  let spent: boolean | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await d.credentials.getEncryptedCredentialRevision(key);
    if (!record) break;
    spent = (await spendRefreshToken(d, teamId, record)) && spent !== false;
    if (await d.credentials.deleteEncryptedCredentialRevision(key, record.revision)) {
      return spent ? 'discarded' : 'unconfirmed';
    }
  }
  if (spent === undefined) return 'none';
  if (await d.credentials.getEncryptedCredentialRevision(key)) throw new LostRevision(key);
  return spent ? 'discarded' : 'unconfirmed';
}

/** One rotation whose result is dropped; false when Slack did not rotate it, or the pair cannot be opened. */
async function spendRefreshToken(
  d: SecretDeps,
  teamId: string,
  record: { revision: string; envelope: Parameters<typeof decryptSlackSecretEnvelope>[2] },
): Promise<boolean> {
  let pair;
  try {
    pair = await openPair(d, teamId, record);
  } catch (error) {
    if (error instanceof ConfigTokenNeeded) return false;
    throw error;
  }
  try {
    await d.slack.rotate(pair.refreshToken);
    return true;
  } catch (error) {
    if (error instanceof SlackRefused) logSlackRefusal('rotate', {}, error);
    else console.warn({ event: 'chickpea.agent_app.token_not_spent', error: error instanceof Error ? error.name : 'unknown' });
    return false;
  }
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
    ...(pair.pastedBy ? { pastedBy: pair.pastedBy } : {}),
    ...(pair.pastedAt !== undefined ? { pastedAt: pair.pastedAt } : {}),
  }, claimRevision);
  return rotated.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
