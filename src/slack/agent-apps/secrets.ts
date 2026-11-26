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
import { type AgentAppSlackApi, type AgentAppSlackStep, SlackRefused, SlackUnavailable, logSlackRefusal } from './slack-api.ts';

export interface AgentAppSecrets {
  clientSecret: string;
  signingSecret: string;
  botToken?: string;
}

export interface SecretDeps {
  credentials: EncryptedCredentialStore;
  keyring: CredentialKeyring;
  slack: Pick<AgentAppSlackApi, 'rotate' | 'revoke'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** An access token with this much life left is used as is. */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000;
/** A rotation claim older than this is taken over. */
export const ROTATION_CLAIM_MS = 60_000;
const LOST_CLAIM_REREADS = 3;
const LOST_CLAIM_WAIT_MS = 1_000;
/** Slack's answer to a rotation whose refresh token is spent or revoked: the only one that ends the stored pair. */
const DEAD_REFRESH_TOKEN = 'invalid_refresh_token';
/** How Slack refuses a configuration token itself, on a rotation or an ordinary call: a token is needed. */
export const TOKEN_REFUSALS: ReadonlySet<string> = new Set(['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive']);
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
 * Paste: refuses an access token, rotates at once, retires the pair of a token
 * for another team, stores the new pair with who pasted it, then retires any
 * pair it replaced as removal does, best effort.
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
    logTokenRefusal('rotate', error);
    // A rate limit says nothing about the token: the Owner is told to try again, not to generate a new one.
    if (error.code === 'ratelimited') throw new SlackUnavailable('tooling.tokens.rotate', error.code);
    return 'rejected';
  }
  if (rotated.teamId !== teamId) {
    // The pasted refresh token is spent already; the pair it returned is retired as a removal would.
    await retirePair(d, rotated);
    return 'other_workspace';
  }
  const pair: ConfigurationTokenPair = {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt,
    ...(pastedBy ? { pastedBy, pastedAt: d.now?.() ?? Date.now() } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await d.credentials.getEncryptedCredentialRevision(configurationTokenKey(teamId));
    const replaced = current ? await openPair(d, teamId, current).catch(unopenedAsNone) : undefined;
    // The new pair is kept before Slack is asked anything, so a request that ends here loses nothing pasted.
    if (!(await writePair(d, teamId, pair, current?.revision ?? null))) continue;
    // Then the pair it replaced is retired at Slack, best effort. A paste of the stored refresh token spent it, and a
    // replaced token whose rotation Slack refuses may be from the very chain just pasted: nothing else is called then,
    // so nothing of the new pair is revoked.
    if (replaced && replaced.refreshToken !== token) await retirePair(d, replaced);
    return 'saved';
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
 * What a removal tells Admin. `discarded`: Slack rotated the stored refresh
 * token, so the token Chickpea held no longer works. Slack may still list a
 * token for its person and workspace, and Chickpea cannot tell. `unconfirmed`:
 * Slack did not confirm the rotation, so it may still accept that token.
 */
export type ConfigurationTokenRemoval = 'discarded' | 'unconfirmed' | 'none';

/**
 * Removal. The stored pair is retired at Slack, and the stored copy is
 * deleted whatever Slack answers. When the delete loses to a newer write, the
 * record is read again: one that still holds the refresh token this removal
 * already rotated or tried (a rotation's claim, or another removal) is only
 * deleted, keeping the first answer, since Slack would refuse that token now.
 * One holding another refresh token (a rotation that won, or a paste that
 * completed after this removal began) is retired and deleted too, and the
 * answer is `discarded` only if both rotations were. Throws LostRevision when a
 * pair still stays.
 */
export async function discardConfigurationToken(d: SecretDeps, teamId: string): Promise<ConfigurationTokenRemoval> {
  const key = configurationTokenKey(teamId);
  let retired: { rotated: boolean; refreshToken: string | undefined } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await d.credentials.getEncryptedCredentialRevision(key);
    if (!record) break;
    // A pair that cannot be opened was never rotated by this removal.
    const pair = await openPair(d, teamId, record).catch(unopenedAsNone);
    if (!retired || retired.refreshToken !== pair?.refreshToken) {
      const rotated = pair ? await retirePair(d, pair) : false;
      retired = { rotated: (retired?.rotated ?? true) && rotated, refreshToken: pair?.refreshToken };
    }
    if (await d.credentials.deleteEncryptedCredentialRevision(key, record.revision)) return removal(retired.rotated);
  }
  if (retired === undefined) return 'none';
  if (await d.credentials.getEncryptedCredentialRevision(key)) throw new LostRevision(key);
  return removal(retired.rotated);
}

function removal(rotated: boolean): ConfigurationTokenRemoval {
  return rotated ? 'discarded' : 'unconfirmed';
}

function unopenedAsNone(error: unknown): undefined {
  if (error instanceof ConfigTokenNeeded) return undefined;
  throw error;
}

/**
 * Makes a pair Chickpea no longer keeps stop working at Slack; true when Slack
 * rotated its refresh token. The rotation spends that refresh token and, as
 * every rotation does, revokes the access token two before the one it returns
 * while that one is still valid. Then the access token it returned and the
 * pair's own are revoked, the latter only while it is valid: Slack refuses an
 * expired one. Nobody can revoke an expired access token, and Slack keeps
 * listing one, so Slack may still list a token afterwards, with the newest
 * refresh token not revoked on its row. That is why Chickpea never revokes a
 * refresh token: the listed one still rotates, so it can be pasted back here,
 * while a listed token with no working refresh token can be neither used,
 * replaced nor deleted.
 */
async function retirePair(d: SecretDeps, pair: { accessToken: string; refreshToken: string; expiresAt: number }): Promise<boolean> {
  const next = await rotateOnce(d, pair.refreshToken);
  if (!next) return false;
  await revokeToken(d, next.accessToken);
  if (pair.expiresAt > (d.now?.() ?? Date.now())) await revokeToken(d, pair.accessToken);
  return true;
}

/**
 * Never retried: Slack may have rotated before its answer was lost, and the pair it returned is then unknown. Only
 * these rotations have a time limit, since nothing they return is kept.
 */
async function rotateOnce(d: SecretDeps, refreshToken: string) {
  try {
    return await d.slack.rotate(refreshToken, { retiring: true });
  } catch (error) {
    logRetireFailed('rotate', error);
    return undefined;
  }
}

/** Revoking a token twice is harmless, so a revoke Slack did not answer is tried once more. */
async function revokeToken(d: SecretDeps, token: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await d.slack.revoke(token);
      return;
    } catch (error) {
      if (error instanceof SlackUnavailable && attempt === 0) continue;
      logRetireFailed('revoke', error);
      return;
    }
  }
}

/** The code only: Slack's `errors` list on a token call could quote the token it was sent. */
function logTokenRefusal(step: 'rotate' | 'revoke', error: SlackRefused): void {
  logSlackRefusal(step, {}, { code: error.code });
}

function logRetireFailed(step: 'rotate' | 'revoke', error: unknown): void {
  if (error instanceof SlackRefused) logTokenRefusal(step, error);
  else {
    console.warn({
      event: 'chickpea.agent_app.token_retire_failed',
      step,
      error: error instanceof SlackUnavailable ? error.reason : error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Runs `use` with a fresh access token; the rotation is claimed by compare-and-set first. Throws ConfigTokenNeeded when
 * no usable token is stored, and SlackUnavailable when a rotation cannot happen now.
 */
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
    // Another caller still holds the rotation: the token is not known to be bad, so this is Slack not answering yet.
    if (attempt >= LOST_CLAIM_REREADS) throw new SlackUnavailable('tooling.tokens.rotate', 'rotation_claimed');
    await (d.sleep ?? sleep)(LOST_CLAIM_WAIT_MS);
    current = await readPair(d, teamId);
  }
}

/**
 * The claim holder rotates; a spent refresh token means another rotator won,
 * or the pair is dead. Only Slack saying the refresh token is no longer valid
 * deletes the pair. Slack refusing the token itself asks for a token and
 * keeps the pair, its claim released so every caller hears the same. Any
 * other refusal, a rate limit among them, leaves the pair and its claim, and
 * is Slack not answering, so the caller retries once the claim lapses.
 */
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
    logTokenRefusal('rotate', error);
    const refusedToken = TOKEN_REFUSALS.has(error.code);
    if (!refusedToken && error.code !== DEAD_REFRESH_TOKEN) throw new SlackUnavailable('tooling.tokens.rotate', error.code);
    const latest = await readPair(d, teamId);
    if (latest && latest.pair.refreshToken !== pair.refreshToken && usable(latest.pair, now)) {
      return latest.pair.accessToken;
    }
    if (latest && refusedToken) {
      const { rotatingSince: _claim, ...unclaimed } = latest.pair;
      await writePair(d, teamId, unclaimed, latest.revision);
    } else if (latest) {
      await d.credentials.deleteEncryptedCredentialRevision(configurationTokenKey(teamId), latest.revision);
    }
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
