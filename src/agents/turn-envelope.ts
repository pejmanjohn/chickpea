import { OPENAI_AUTH_METHOD_SETTING_KEY } from '../config/openai-auth.ts';
import { SANDBOX_SETTING_KEYS } from '../config/sandbox-settings.ts';
import type { SettingsPatch, SettingsStore } from '../config/settings-store.ts';
import type { AgentKind, CustomAgentConfig, RepositoryGrant } from '../config/types.ts';
import { MODEL_CATALOG_SETTING_KEYS } from '../model-catalog/store.ts';

/**
 * The turn envelope: the per-turn configuration that tool code inside the
 * Agent (and its coding workers) would otherwise read from the singleton
 * state object on every tool call. The host freezes it once, when it prepares
 * the Flue dispatch, and the Agent fetches it once per turn by the TurnJob id.
 *
 * It carries non-secret facts only. Secret values (provider API keys, the
 * GitHub App private key, connector and OAuth credentials, the Browserbase
 * key, the Slack bot token) are never frozen here: tool code still reads
 * them live at use, exactly as before. Live authority checks (connection
 * accounts, website-login revocation, approvals) stay live as well.
 *
 * Why a fetch and not Flue `initialData`: creation data rides only the
 * instance's first message and is part of its identity, so it cannot change
 * per turn; signal attributes are rendered into the model's context.
 */
export const TURN_ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Whole envelope, serialized. Larger envelopes are not frozen (tools read live). */
export const TURN_ENVELOPE_MAX_BYTES = 64 * 1024;

/** One frozen setting value. A larger value is left out and read live. */
export const TURN_ENVELOPE_MAX_SETTING_BYTES = 16 * 1024;

const MAX_REPOSITORIES = 200;

/**
 * Non-secret settings that Agent-side tool code reads, frozen at dispatch.
 * Never add a credential here: anything listed is persisted with the TurnJob.
 */
export const TURN_ENVELOPE_SETTING_KEYS: readonly string[] = Object.freeze([
  SANDBOX_SETTING_KEYS.installRequested,
  SANDBOX_SETTING_KEYS.enabled,
  SANDBOX_SETTING_KEYS.allowedHosts,
  SANDBOX_SETTING_KEYS.monthlySessionCap,
  OPENAI_AUTH_METHOD_SETTING_KEY,
  MODEL_CATALOG_SETTING_KEYS.mode,
  MODEL_CATALOG_SETTING_KEYS.lkg,
]);

/** The Agent as it stood at dispatch: liveness and repository grants only. */
export interface TurnEnvelopeAgentV1 {
  id: string;
  kind: AgentKind;
  revision: number;
  enabled: boolean;
  repositories: RepositoryGrant[];
}

export type TurnEnvelopeAgentFacts = Pick<
  CustomAgentConfig,
  'id' | 'kind' | 'revision' | 'enabled' | 'repositories'
>;

export interface TurnEnvelopeV1 {
  schemaVersion: typeof TURN_ENVELOPE_SCHEMA_VERSION;
  /** Digest of every frozen fact below except `frozenAt`; equal revisions froze equal inputs. */
  settingsRevision: string;
  frozenAt: number;
  agentId: string;
  /** Null when the Agent was missing at dispatch; the Agent side seals the thread. */
  agent: TurnEnvelopeAgentV1 | null;
  /** Frozen values of TURN_ENVELOPE_SETTING_KEYS; `null` is an absent setting. */
  settings: Record<string, string | null>;
  /** A GitHub App was connected at dispatch. Its key is still read live to mint tokens. */
  githubAppConnected: boolean;
  /**
   * The image role's model at dispatch; present only for plans whose image
   * role resolved. `null` means the role no longer resolved at dispatch.
   */
  imageModelId?: string | null;
}

export type TurnEnvelopeBody = Omit<TurnEnvelopeV1, 'schemaVersion' | 'settingsRevision'>;

/** Bound, then seal the body with its revision. Undefined when it is too large to freeze. */
export async function sealTurnEnvelope(
  body: TurnEnvelopeBody,
  digest: (value: string) => Promise<string>,
): Promise<TurnEnvelopeV1 | undefined> {
  const settings: Record<string, string | null> = {};
  for (const key of TURN_ENVELOPE_SETTING_KEYS) {
    if (!(key in body.settings)) continue;
    const value = body.settings[key] ?? null;
    if (value !== null && utf8Bytes(value) > TURN_ENVELOPE_MAX_SETTING_BYTES) continue;
    settings[key] = value;
  }
  const bounded: TurnEnvelopeBody = { ...body, settings };
  // The revision names the frozen facts, not the moment they were read.
  const settingsRevision = await digest(canonicalJson({ ...bounded, frozenAt: undefined }));
  const envelope: TurnEnvelopeV1 = {
    schemaVersion: TURN_ENVELOPE_SCHEMA_VERSION,
    settingsRevision,
    ...bounded,
  };
  if (utf8Bytes(JSON.stringify(envelope)) > TURN_ENVELOPE_MAX_BYTES) return undefined;
  return parseTurnEnvelope(envelope);
}

/** Strict reader for a stored or fetched envelope. Throws on anything unexpected. */
export function parseTurnEnvelope(value: unknown): TurnEnvelopeV1 {
  const record = objectRecord(value, 'Turn envelope');
  allowOnly(record, [
    'schemaVersion', 'settingsRevision', 'frozenAt', 'agentId', 'agent', 'settings',
    'githubAppConnected', 'imageModelId',
  ], 'Turn envelope');
  if (record.schemaVersion !== TURN_ENVELOPE_SCHEMA_VERSION) {
    throw new Error('Turn envelope schemaVersion is unsupported.');
  }
  if (typeof record.settingsRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.settingsRevision)) {
    throw new Error('Turn envelope settingsRevision is invalid.');
  }
  if (typeof record.frozenAt !== 'number' || !Number.isSafeInteger(record.frozenAt) || record.frozenAt < 0) {
    throw new Error('Turn envelope frozenAt is invalid.');
  }
  const agentId = boundedString(record.agentId, 'agentId', 256);
  const agent = record.agent === null ? null : parseAgent(record.agent, agentId);
  const settingsRecord = objectRecord(record.settings, 'Turn envelope settings');
  const settings: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(settingsRecord)) {
    if (!TURN_ENVELOPE_SETTING_KEYS.includes(key)) {
      throw new Error('Turn envelope carries a setting that may not be frozen.');
    }
    if (entry !== null && (typeof entry !== 'string' || utf8Bytes(entry) > TURN_ENVELOPE_MAX_SETTING_BYTES)) {
      throw new Error('Turn envelope setting value is invalid.');
    }
    settings[key] = entry;
  }
  if (typeof record.githubAppConnected !== 'boolean') {
    throw new Error('Turn envelope githubAppConnected is invalid.');
  }
  const envelope: TurnEnvelopeV1 = {
    schemaVersion: TURN_ENVELOPE_SCHEMA_VERSION,
    settingsRevision: record.settingsRevision,
    frozenAt: record.frozenAt,
    agentId,
    agent,
    settings,
    githubAppConnected: record.githubAppConnected,
  };
  if ('imageModelId' in record) {
    envelope.imageModelId = record.imageModelId === null
      ? null
      : boundedString(record.imageModelId, 'imageModelId', 256);
  }
  if (utf8Bytes(JSON.stringify(envelope)) > TURN_ENVELOPE_MAX_BYTES) {
    throw new Error('Turn envelope exceeds its size bound.');
  }
  return envelope;
}

/**
 * Settings as tool code sees them for one turn: frozen keys come from the
 * envelope, every other key (all secrets) is read live, and every write goes
 * to the live store. A write to a frozen key drops it from the view so this
 * turn reads its own write back live.
 */
export class TurnSettingsView implements SettingsStore {
  private readonly frozen: Map<string, string | null>;

  constructor(
    private readonly live: SettingsStore,
    envelope: Pick<TurnEnvelopeV1, 'settings'>,
  ) {
    this.frozen = new Map(Object.entries(envelope.settings));
  }

  async getSetting(key: string): Promise<string | undefined> {
    if (this.frozen.has(key)) return this.frozen.get(key) ?? undefined;
    return this.live.getSetting(key);
  }

  async getSettings(keys: readonly string[]): Promise<(string | undefined)[]> {
    const missing = keys.filter((key) => !this.frozen.has(key));
    const fetched = missing.length > 0 ? await this.live.getSettings(missing) : [];
    const liveValues = new Map(missing.map((key, index) => [key, fetched[index]]));
    return keys.map((key) =>
      this.frozen.has(key) ? this.frozen.get(key) ?? undefined : liveValues.get(key));
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.frozen.delete(key);
    await this.live.setSetting(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.frozen.delete(key);
    await this.live.deleteSetting(key);
  }

  async applySettingsPatch(patch: SettingsPatch): Promise<boolean> {
    for (const write of patch.set ?? []) this.frozen.delete(write.key);
    for (const key of patch.delete ?? []) this.frozen.delete(key);
    return this.live.applySettingsPatch(patch);
  }

  async mergeSettingStringSet(key: string, values: readonly string[]): Promise<string[]> {
    this.frozen.delete(key);
    return this.live.mergeSettingStringSet(key, values);
  }
}

/** Resolved envelopes by TurnJob id. Immutable once frozen, so safe to share in an isolate. */
const resolvedEnvelopes = new Map<string, TurnEnvelopeV1 | null>();
const MAX_RESOLVED_ENVELOPES = 64;

/** Test seam: forget envelopes resolved in this isolate. */
export function resetTurnEnvelopeCacheForTests(): void {
  resolvedEnvelopes.clear();
}

/**
 * One turn's view of its envelope inside the Agent (or a coding worker).
 * The envelope is fetched at most once per turn and isolate; every lookup
 * after that is local. When the turn has no envelope (Node, a routine run, a
 * turn dispatched before this existed, or a failed fetch) every accessor
 * falls back to the live store, exactly as before.
 */
export class TurnEnvelopeContext {
  private pending: Promise<TurnEnvelopeV1 | undefined> | undefined;
  private readonly memos = new Map<string, Promise<unknown>>();

  constructor(
    readonly turnJobId: string,
    readonly agentId: string,
    private readonly load: (turnJobId: string) => Promise<unknown>,
  ) {}

  /** This turn's frozen envelope, or undefined when tools must read live. */
  envelope(): Promise<TurnEnvelopeV1 | undefined> {
    this.pending ??= this.resolve();
    return this.pending;
  }

  /** The settings this turn's tools read: the envelope view, or `live` without one. */
  async settings(live: SettingsStore): Promise<SettingsStore> {
    const envelope = await this.envelope();
    return envelope ? new TurnSettingsView(live, envelope) : live;
  }

  /**
   * Run `operation` against this turn's settings. When it fails on the frozen
   * view, a frozen fact may have gone stale mid-turn: re-resolve once against
   * the live store, whose result (success or the same failure) stands.
   */
  async withSettings<T>(
    live: SettingsStore,
    operation: (settings: SettingsStore) => Promise<T>,
  ): Promise<T> {
    const settings = await this.settings(live);
    if (settings === live) return operation(live);
    try {
      return await operation(settings);
    } catch {
      return operation(live);
    }
  }

  /** Share one result per key for the rest of this turn's render; a failure is not kept. */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.memos.get(key);
    if (existing) return existing as Promise<T>;
    const created = compute();
    this.memos.set(key, created);
    created.catch(() => {
      if (this.memos.get(key) === created) this.memos.delete(key);
    });
    return created;
  }

  private async resolve(): Promise<TurnEnvelopeV1 | undefined> {
    const cached = resolvedEnvelopes.get(this.turnJobId);
    if (cached !== undefined) return this.forThisAgent(cached ?? undefined);
    let envelope: TurnEnvelopeV1 | undefined;
    try {
      const loaded = await this.load(this.turnJobId);
      envelope = loaded == null ? undefined : parseTurnEnvelope(loaded);
    } catch {
      // No envelope is never an error: the tools read live, as before.
      console.warn('[chickpea] turn envelope unavailable; tools read settings live this turn');
      return undefined;
    }
    if (resolvedEnvelopes.size >= MAX_RESOLVED_ENVELOPES) {
      const oldest = resolvedEnvelopes.keys().next().value;
      if (oldest !== undefined) resolvedEnvelopes.delete(oldest);
    }
    resolvedEnvelopes.set(this.turnJobId, envelope ?? null);
    return this.forThisAgent(envelope);
  }

  private forThisAgent(envelope: TurnEnvelopeV1 | undefined): TurnEnvelopeV1 | undefined {
    return envelope?.agentId === this.agentId ? envelope : undefined;
  }
}

function parseAgent(value: unknown, agentId: string): TurnEnvelopeAgentV1 {
  const record = objectRecord(value, 'Turn envelope agent');
  allowOnly(record, ['id', 'kind', 'revision', 'enabled', 'repositories'], 'Turn envelope agent');
  const id = boundedString(record.id, 'agent id', 256);
  if (id !== agentId) throw new Error('Turn envelope agent does not match its agentId.');
  if (record.kind !== 'user' && record.kind !== 'system') {
    throw new Error('Turn envelope agent kind is invalid.');
  }
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)) {
    throw new Error('Turn envelope agent revision is invalid.');
  }
  if (typeof record.enabled !== 'boolean') throw new Error('Turn envelope agent enabled is invalid.');
  if (!Array.isArray(record.repositories) || record.repositories.length > MAX_REPOSITORIES) {
    throw new Error('Turn envelope agent repositories must be a bounded list.');
  }
  return {
    id,
    kind: record.kind,
    revision: record.revision,
    enabled: record.enabled,
    repositories: record.repositories.map(parseRepositoryGrant),
  };
}

function parseRepositoryGrant(value: unknown): RepositoryGrant {
  const record = objectRecord(value, 'Turn envelope repository');
  allowOnly(record, ['id', 'installationId', 'accountLogin', 'fullName', 'allRepos', 'enabled'], 'Turn envelope repository');
  const installationId = record.installationId;
  if (installationId !== null && (typeof installationId !== 'number' || !Number.isSafeInteger(installationId))) {
    throw new Error('Turn envelope repository installationId is invalid.');
  }
  if (typeof record.enabled !== 'boolean') throw new Error('Turn envelope repository enabled is invalid.');
  if (record.allRepos !== undefined && typeof record.allRepos !== 'boolean') {
    throw new Error('Turn envelope repository allRepos is invalid.');
  }
  return {
    id: boundedString(record.id, 'repository id', 256),
    installationId,
    accountLogin: boundedString(record.accountLogin, 'repository accountLogin', 256, true),
    fullName: boundedString(record.fullName, 'repository fullName', 512, true),
    ...(record.allRepos === true ? { allRepos: true } : {}),
    enabled: record.enabled,
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function allowOnly(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`${label} has an unknown field: ${key}.`);
  }
}

function boundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new Error(`Turn envelope ${label} is invalid.`);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Stable JSON: object keys sorted, so equal inputs digest equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
