import { createHash, randomUUID } from 'node:crypto';
import type { EncryptedCredentialStore, SettingsStore } from '../config/settings-store.ts';
import { OPENAI_AUTH_METHOD_SETTING_KEY } from '../config/openai-auth.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';
import { loadCredentialKeyring } from '../slack/credential-keyring.ts';
import { decryptSlackSecretEnvelope, encryptSlackSecretEnvelope, workspaceCredentialContext, type CredentialKeyring } from '../slack/secret-envelope.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import { chatgptAuthorizationUrl, exchangeChatgptCode, listChatgptModels, refreshChatgptSession, revokeChatgptSession, type ChatgptPlanModel, type ChatgptPlanSession } from './protocol.ts';

const HOST = 'chatgpt-plan.host';
const REGISTRATION = 'chatgpt-plan.registration';
const PENDING = 'chatgpt-plan.pending';
const LOCK = 'chatgpt-plan.lock';
const COMPLETED = 'chatgpt-plan.completed';
const ACTIVE = 'chatgpt-plan.session';
const CANDIDATE = 'chatgpt-plan.candidate';
const ATTEMPT_TTL = 15 * 60_000;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

export interface PlanDependencies {
  settings: SettingsStore;
  credentials: EncryptedCredentialStore;
  keyring: CredentialKeyring;
  fetch?: typeof fetch;
  now?: () => number;
  exchange?: typeof exchangeChatgptCode;
  refresh?: typeof refreshChatgptSession;
  revoke?: typeof revokeChatgptSession;
}
export interface PlanDescriptor { challenge: string; state: string; nonce: string; redirectUri: string }
interface Registration { clientId: string; subject: string; email: string }
interface Pending extends PlanDescriptor {
  hostId: string; registration?: Registration | undefined; expiresAt: number;
  currentRevision: string | null; stateName: 'awaiting_signin' | 'confirm'; email?: string;
}
interface Bundle { session: ChatgptPlanSession; models: ChatgptPlanModel[]; modelsAt: number; connectedAt?: number }

export function planDependencies(env?: PlatformEnv, settings?: SettingsStore): PlanDependencies {
  const store = settings ?? getSettingsStore(env);
  return { settings: store, credentials: 'getEncryptedCredentialRevision' in store ? store as SettingsStore & EncryptedCredentialStore : getSettingsStore(env), get keyring() { return loadCredentialKeyring(env); } };
}
const now = (d: PlanDependencies) => d.now?.() ?? Date.now();
const fail = (code: ConstructorParameters<typeof OpenAiSubscriptionError>[0]): never => { throw new OpenAiSubscriptionError(code); };
const parse = <T>(value: string | undefined): T | undefined => value ? JSON.parse(value) as T : undefined;

export function validatePlanDescriptor(input: unknown): PlanDescriptor {
  if (!input || typeof input !== 'object') return fail('protocol_drift');
  const value = input as PlanDescriptor;
  if (![value.challenge, value.state, value.nonce].every(item => typeof item === 'string' && CAPABILITY.test(item)) || typeof value.redirectUri !== 'string' || value.redirectUri.length > 200) return fail('protocol_drift');
  chatgptAuthorizationUrl({ ...value, hostId: `urn:uuid:${randomUUID()}` });
  return { challenge: value.challenge, state: value.state, nonce: value.nonce, redirectUri: value.redirectUri };
}

async function locked<T>(d: PlanDependencies, operation: () => Promise<T>): Promise<T> {
  let lockValue = '';
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    lockValue = JSON.stringify({ id: randomUUID(), until: now(d) + 120_000 });
    const prior = await d.settings.getSetting(LOCK);
    if ((!prior || (parse<{ until: number }>(prior)?.until ?? Infinity) < now(d)) &&
        await d.settings.applySettingsPatch({ expected: { key: LOCK, value: prior ?? null }, set: [{ key: LOCK, value: lockValue }] })) {
      acquired = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!acquired) return fail('authorization_pending');
  try { return await operation(); }
  finally { await d.settings.applySettingsPatch({ expected: { key: LOCK, value: lockValue }, delete: [LOCK] }); }
}

function context(key: string, hostId: string, revision: string) {
  return workspaceCredentialContext({ contextId: hostId, identityId: key, appId: 'chickpea', purpose: 'chatgpt_plan', revision });
}
async function readBundle(d: PlanDependencies, key = ACTIVE) {
  const record = await d.credentials.getEncryptedCredentialRevision(key);
  if (!record) return undefined;
  const decrypted = await decryptSlackSecretEnvelope<{ bundle: string }>(d.keyring, context(key, record.contextId, record.revision), record.envelope);
  return { record, bundle: JSON.parse(decrypted.bundle) as Bundle };
}
async function writeBundle(d: PlanDependencies, key: string, bundle: Bundle, expectedRevision: string | null) {
  const revision = randomUUID();
  const contextId = bundle.session.hostId.replace('urn:uuid:', '');
  const envelope = await encryptSlackSecretEnvelope(d.keyring, context(key, contextId, revision), { bundle: JSON.stringify(bundle) });
  const record = await d.credentials.replaceEncryptedCredentialRevision({ key, expectedRevision, revision, contextId, envelope });
  if (!record) return fail('auth_reconnect_required');
  return record;
}
async function clearCandidate(d: PlanDependencies) {
  const candidate = await readBundle(d, CANDIDATE);
  if (candidate) {
    const active = await readBundle(d);
    if (active?.bundle.session.refreshToken !== candidate.bundle.session.refreshToken) await (d.revoke ?? revokeChatgptSession)(candidate.bundle.session, d.fetch);
    await d.credentials.deleteEncryptedCredentialRevision(CANDIDATE, candidate.record.revision);
  }
  await d.settings.deleteSetting(PENDING);
}

export async function preparePlanConnection(d: PlanDependencies, input: unknown, newAccount = false): Promise<void> {
  const descriptor = validatePlanDescriptor(input);
  await locked(d, async () => {
    const prior = parse<Pending>(await d.settings.getSetting(PENDING));
    if (prior?.challenge === descriptor.challenge && prior.expiresAt > now(d)) return;
    await clearCandidate(d);
    let hostId = await d.settings.getSetting(HOST);
    if (!hostId) { hostId = `urn:uuid:${randomUUID()}`; await d.settings.setSetting(HOST, hostId); }
    const registration = newAccount ? undefined : parse<Registration>(await d.settings.getSetting(REGISTRATION));
    const current = await d.credentials.getEncryptedCredentialRevision(ACTIVE);
    const pending: Pending = { ...descriptor, hostId, registration, currentRevision: current?.revision ?? null, expiresAt: now(d) + ATTEMPT_TTL, stateName: 'awaiting_signin' };
    await d.settings.setSetting(PENDING, JSON.stringify(pending));
  });
}

async function pendingFor(d: PlanDependencies, verifier: unknown): Promise<Pending | undefined> {
  if (typeof verifier !== 'string' || !CAPABILITY.test(verifier)) return fail('attempt_forbidden');
  const pending = parse<Pending>(await d.settings.getSetting(PENDING));
  if (!pending || pending.challenge !== createHash('sha256').update(verifier).digest('base64url')) return undefined;
  if (pending.expiresAt <= now(d)) return fail('authorization_expired');
  return pending;
}

/** Narrow public capability endpoint; only an owner can create its pending record. */
export async function pollPlanHandoff(d: PlanDependencies, verifier: unknown) {
  const pending = await pendingFor(d, verifier);
  if (!pending) {
    const done = parse<{ challenge: string; expiresAt: number }>(await d.settings.getSetting(COMPLETED));
    if (typeof verifier === 'string' && done && done.expiresAt > now(d) && done.challenge === createHash('sha256').update(verifier).digest('base64url')) return { state: 'connected' };
    return { state: 'waiting_for_approval' };
  }
  if (pending.stateName === 'confirm') return { state: 'awaiting_confirmation', email: pending.email };
  return { state: 'ready', authorizationUrl: chatgptAuthorizationUrl({ ...pending, ...(pending.registration ? { clientId: pending.registration.clientId } : {}) }), clientId: pending.registration?.clientId };
}

export async function completePlanHandoff(d: PlanDependencies, input: { verifier: unknown; code: unknown; clientId: unknown }) {
  // Reject unauthenticated callers before creating or contending on a write lock.
  if (!await pendingFor(d, input.verifier)) return fail('attempt_forbidden');
  return locked(d, async () => {
    const pending = await pendingFor(d, input.verifier);
    if (!pending) return fail('attempt_forbidden');
    if (pending.stateName === 'confirm') return { state: 'awaiting_confirmation', email: pending.email };
    const clientId = pending.registration?.clientId ?? input.clientId;
    if (typeof clientId !== 'string' || !/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId) ||
        (input.clientId != null && input.clientId !== clientId) || typeof input.code !== 'string' || !input.code || input.code.length > 8192) return fail('protocol_drift');
    // Persist immediately after exchange so retry/cancel can always recover the session.
    const existing = await readBundle(d, CANDIDATE);
    const session = existing?.bundle.session ?? await (d.exchange ?? exchangeChatgptCode)({ clientId, hostId: pending.hostId, code: input.code, verifier: input.verifier as string, nonce: pending.nonce, redirectUri: pending.redirectUri }, { ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.now ? { now: d.now } : {}) });
    const record = existing?.record ?? await writeBundle(d, CANDIDATE, { session, models: [], modelsAt: 0 }, null);
    if (pending.registration && pending.registration.subject !== session.subject) return fail('auth_reconnect_required');
    const models = await listChatgptModels(session.accessToken, d.fetch);
    if (!models.length) return fail('unsupported_model');
    await writeBundle(d, CANDIDATE, { session, models, modelsAt: now(d) }, record.revision);
    await d.settings.setSetting(PENDING, JSON.stringify({ ...pending, stateName: 'confirm', email: session.email } satisfies Pending));
    return { state: 'awaiting_confirmation', email: session.email };
  });
}

export async function confirmPlanConnection(d: PlanDependencies, challenge: unknown): Promise<void> {
  await locked(d, async () => {
    const pending = parse<Pending>(await d.settings.getSetting(PENDING));
    const candidate = await readBundle(d, CANDIDATE);
    if (!pending || pending.challenge !== challenge || pending.expiresAt <= now(d) || pending.stateName !== 'confirm' || !candidate) return fail('authorization_expired');
    const old = await readBundle(d);
    const alreadyActivated = old?.bundle.session.refreshToken === candidate.bundle.session.refreshToken;
    if (!alreadyActivated) {
      // A token refresh while the user signs in may rotate the old revision, but not its account.
      if (old && pending.registration && old.bundle.session.subject !== pending.registration.subject) return fail('attempt_forbidden');
      if (old) await (d.revoke ?? revokeChatgptSession)(old.bundle.session, d.fetch);
      await writeBundle(d, ACTIVE, { ...candidate.bundle, connectedAt: now(d) }, old?.record.revision ?? null);
    }
    const { clientId, subject, email } = candidate.bundle.session;
    await d.settings.applySettingsPatch({ set: [
      { key: REGISTRATION, value: JSON.stringify({ clientId, subject, email }) },
      { key: COMPLETED, value: JSON.stringify({ challenge: pending.challenge, expiresAt: pending.expiresAt }) },
      { key: OPENAI_AUTH_METHOD_SETTING_KEY, value: 'subscription' },
    ], delete: [PENDING] });
    await d.credentials.deleteEncryptedCredentialRevision(CANDIDATE, candidate.record.revision);

  });
}

export async function cancelPlanConnection(d: PlanDependencies) { await locked(d, () => clearCandidate(d)); }
export async function disconnectPlan(d: PlanDependencies) {
  await locked(d, async () => {
    await clearCandidate(d);
    await d.settings.deleteSetting(COMPLETED);
    const active = await readBundle(d);
    if (!active) return;
    await (d.revoke ?? revokeChatgptSession)(active.bundle.session, d.fetch);
    await d.credentials.deleteEncryptedCredentialRevision(ACTIVE, active.record.revision);
  });
}

export async function planStatus(d: PlanDependencies) {
  const pending = parse<Pending>(await d.settings.getSetting(PENDING));
  if (pending && pending.expiresAt <= now(d)) await cancelPlanConnection(d);
  const active = await readBundle(d);
  const registration = parse<Registration>(await d.settings.getSetting(REGISTRATION));
  return {
    state: active ? 'connected' as const : registration ? 'reconnect_required' as const : 'disconnected' as const,
    email: active?.bundle.session.email ?? registration?.email,
    connectedAt: active?.bundle.connectedAt ?? 0,
    models: active?.bundle.models ?? [],
    ...(pending && pending.expiresAt > now(d) ? { pending: { state: pending.stateName, email: pending.email, expiresAt: pending.expiresAt, challenge: pending.challenge } } : {}),
  };
}

export async function resolvePlanSession(d: PlanDependencies): Promise<Bundle> {
  const active = await readBundle(d);
  if (!active) return fail('auth_reconnect_required');
  if (active.bundle.session.expiresAt > now(d) + 60_000 && active.bundle.modelsAt > now(d) - 10 * 60_000) return active.bundle;
  return locked(d, async () => {
    const current = await readBundle(d);
    if (!current) return fail('auth_reconnect_required');
    let bundle = current.bundle;
    if (bundle.session.expiresAt <= now(d) + 60_000) {
      try { bundle = { ...bundle, session: await (d.refresh ?? refreshChatgptSession)(bundle.session, d.fetch, now(d)) }; }
      catch (error) {
        if (error instanceof OpenAiSubscriptionError && error.code === 'auth_reconnect_required') await d.credentials.deleteEncryptedCredentialRevision(ACTIVE, current.record.revision);
        throw error;
      }
      // Persist rotation before optional catalog networking.
      await writeBundle(d, ACTIVE, bundle, current.record.revision);
    }
    if (bundle.modelsAt <= now(d) - 10 * 60_000) {
      bundle = { ...bundle, models: await listChatgptModels(bundle.session.accessToken, d.fetch), modelsAt: now(d) };
      const revision = await d.credentials.getEncryptedCredentialRevision(ACTIVE);
      if (!revision) return fail('auth_reconnect_required');
      await writeBundle(d, ACTIVE, bundle, revision.revision);
    }
    return bundle;
  });
}
