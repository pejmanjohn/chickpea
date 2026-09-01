export const PRODUCT_AREAS = [
  'agents',
  'connections',
  'skills',
  'memory',
  'routines',
  'installation',
] as const;

export const PRODUCT_FEATURES = [
  'agent_lifecycle',
  'avatar_parity',
  'slack_routing',
  'connection_ownership',
  'connection_isolation',
  'skill_lifecycle',
  'agent_memory',
  'channel_routines',
  'dm_routines',
  'slack_installation',
] as const;

export const ENTRY_POINTS = [
  'slack_root',
  'slack_thread',
  'slack_dm',
  'admin',
  'app_home',
  'oauth',
  'scheduled_delivery',
  'provider',
] as const;

export const ACTION_IDS = [
  'slack.message.inspect',
  'slack.message.send',
  'slack.message.delete',
  'agent.create',
  'agent.update',
  'agent.archive',
  'agent.restore',
  'connection.authorize',
  'connection.revoke',
  'routine.create',
  'routine.update',
  'routine.delete',
  'routine.run_now',
  'route.handoff',
  'skill.import',
  'skill.remove',
  'memory.write',
  'memory.forget',
  'app_home.open',
  'app_home.select',
  'slack.app.uninstall',
  'slack.app.install',
] as const;

export const GENERATED_EFFECT_IDS = [
  'slack.message.generated',
  'app_home.generated',
  'agent.tombstone.generated',
] as const;

export const MUTATION_CLASSES = [
  'none',
  'create',
  'update',
  'delete',
  'archive',
  'restore',
  'authorize',
  'revoke',
] as const;

export const HUMAN_GATES = [
  'none',
  'approval',
  'oauth_consent',
  'login',
  'captcha',
  'credential_entry',
  'provider_permission',
] as const;

export const OBSERVER_IDS = [
  'slack.messages.read',
  'agent.read',
  'connection.read',
  'routine.read',
  'provider.read',
  'provider.revocation.read',
  'private.routine.read',
  'app_home.read',
  'cloudflare.version.read',
  'browser.screenshot',
  'agent.avatar.read',
  'slack.persona.read',
  'asset.digest.read',
  'route.read',
  'skill.read',
  'memory.read',
  'installation.read',
  'app_home.publication.read',
] as const;

export const OBSERVER_KINDS = [
  'slack_api',
  'chickpea_api',
  'provider_api',
  'cloudflare_api',
  'browser_screenshot',
  'computer_use_ui',
] as const;

export const ASSERTION_TOKENS = [
  'agent.exists',
  'agent.instructions_equal',
  'slack.message_matches',
  'connection.owner_personal',
  'connection.owner_team',
  'connection.editor_attributed',
  'routine.exists',
  'routine.due_delivery',
  'routine.paused',
  'routine.active',
  'routine.run_once',
  'forbidden.no_duplicate',
  'forbidden.no_cross_agent_reuse',
  'forbidden.no_early_mutation',
  'avatar.source_digest_parity',
  'avatar.presentation_parity',
  'route.ingress_admitted',
  'route.owner_exact',
  'slack.persona_matches',
  'connection.agent_isolated',
  'connection.needs_attention',
  'connection.reconnected',
  'routine.dependency_paused',
  'skill.provenance_pinned',
  'skill.enabled',
  'skill.removed',
  'skill.behavior_matches',
  'memory.digest_equal',
  'memory.revision_advanced',
  'memory.conflict_rejected',
  'memory.forgotten',
  'routine.private_exists',
  'routine.admin_omitted',
  'routine.private_delivery',
  'routine.authority_disabled',
  'installation.authorized',
  'installation.baseline_restored',
  'app_home.published',
  'route.app_home_selected',
  'forbidden.no_unauthorized_mutation',
  'forbidden.no_raw_memory',
] as const;

export const PRIMARY_RESULTS = [
  'pass',
  'fail',
  'blocked',
  'ambiguous',
  'infrastructure_error',
] as const;

export const TYPED_REASONS = [
  'assertion_failed',
  'fixture_missing',
  'authority_denied',
  'human_gate_denied',
  'human_gate_cancelled',
  'human_gate_expired',
  'wrong_session',
  'provider_error',
  'target_drift',
  'ambiguous_mutation',
  'cleanup_failed',
] as const;

export const CLEANUP_RESULTS = ['not_required', 'pass', 'failed'] as const;
export const SUITES = ['case', 'smoke', 'deep'] as const;
export const FIXTURE_CLASSES = [
  'immutable_baseline',
  'resettable_fixture',
  'run_owned',
  'attributed_residue',
] as const;
export const FIXTURE_KINDS = [
  'actor',
  'slack_channel',
  'agent',
  'routine',
  'provider_account',
  'source_fixture',
  'slack_dm',
  'slack_app',
] as const;
export const CLEANUP_STRATEGIES = [
  'not_required',
  'exact_reversal',
  'revision_restore',
  'attributed_residue',
] as const;
export const PUBLIC_SOURCE_KINDS = ['sanitized_contract', 'historical_candidate', 'source_fixture'] as const;
export const EVIDENCE_FIELDS = [
  'immutable_id',
  'revision',
  'observed_state',
  'actor_alias',
  'target_alias',
  'action_receipt',
  'cleanup_receipt',
  'source_commit',
  'source_digest',
] as const;

export type ProductArea = typeof PRODUCT_AREAS[number];
export type ProductFeature = typeof PRODUCT_FEATURES[number];
export type EntryPoint = typeof ENTRY_POINTS[number];
export type ActionId = typeof ACTION_IDS[number];
export type GeneratedEffectId = typeof GENERATED_EFFECT_IDS[number];
export type MutationClass = typeof MUTATION_CLASSES[number];
export type HumanGate = typeof HUMAN_GATES[number];
export type ObserverId = typeof OBSERVER_IDS[number];
export type ObserverKind = typeof OBSERVER_KINDS[number];
export type AssertionToken = typeof ASSERTION_TOKENS[number];
export type PrimaryResult = typeof PRIMARY_RESULTS[number];
export type TypedReason = typeof TYPED_REASONS[number];
export type CleanupResult = typeof CLEANUP_RESULTS[number];
export type Suite = typeof SUITES[number];
export type FixtureClass = typeof FIXTURE_CLASSES[number];
export type FixtureKind = typeof FIXTURE_KINDS[number];
export type CleanupStrategy = typeof CLEANUP_STRATEGIES[number];
export type PublicSourceKind = typeof PUBLIC_SOURCE_KINDS[number];
export type EvidenceField = typeof EVIDENCE_FIELDS[number];

export const OBSERVER_REGISTRY: Readonly<Record<ObserverId, {
  kind: ObserverKind;
  authoritative: boolean;
}>> = {
  'slack.messages.read': { kind: 'computer_use_ui', authoritative: true },
  'agent.read': { kind: 'computer_use_ui', authoritative: true },
  'connection.read': { kind: 'computer_use_ui', authoritative: true },
  'routine.read': { kind: 'computer_use_ui', authoritative: true },
  'provider.read': { kind: 'computer_use_ui', authoritative: true },
  'provider.revocation.read': { kind: 'computer_use_ui', authoritative: true },
  'private.routine.read': { kind: 'computer_use_ui', authoritative: true },
  'app_home.read': { kind: 'computer_use_ui', authoritative: true },
  'cloudflare.version.read': { kind: 'cloudflare_api', authoritative: true },
  'browser.screenshot': { kind: 'browser_screenshot', authoritative: false },
  'agent.avatar.read': { kind: 'computer_use_ui', authoritative: true },
  'slack.persona.read': { kind: 'computer_use_ui', authoritative: true },
  'asset.digest.read': { kind: 'computer_use_ui', authoritative: true },
  'route.read': { kind: 'computer_use_ui', authoritative: true },
  'skill.read': { kind: 'computer_use_ui', authoritative: true },
  'memory.read': { kind: 'computer_use_ui', authoritative: true },
  'installation.read': { kind: 'computer_use_ui', authoritative: true },
  'app_home.publication.read': { kind: 'computer_use_ui', authoritative: true },
};

export const REQUIRED_LIVE_VARIANTS = {
  'LC-01': ['LC01-V1-create-welcome', 'LC01-V2-update-approve'],
  'LC-02': ['LC02-V1-avatar-parity'],
  'LC-03': ['LC03-V1-ingress-root-thread', 'LC03-V2-handoff', 'LC03-V3-archive-restore'],
  'LC-04': ['LC04-V1-personal-read', 'LC04-V2-team-read', 'LC04-V3-editor-race'],
  'LC-05': ['LC05-V1-personal-isolation', 'LC05-V2-team-isolation', 'LC05-V3-revoke-reconnect'],
  'LC-06': ['LC06-V1-import-behavior-remove', 'LC06-V2-cross-agent-denial'],
  'LC-07': ['LC07-V1-explicit-memory', 'LC07-V2-implicit-preference', 'LC07-V3-conflict-replay-forget'],
  'LC-08': ['LC08-V1-create-due', 'LC08-V2-pause-resume', 'LC08-V3-run-now'],
  'LC-09': ['LC09-V1-one-shot-dm', 'LC09-V2-recurring-dm', 'LC09-V3-admin-omission-authority-loss'],
  'LC-10': ['LC10-V1-install-route', 'LC10-V2-app-home-selection', 'LC10-V3-stale-membership-denial'],
} as const;

export const FOUNDATION_CONTRACT_IDS = ['LC-01', 'LC-04', 'LC-08'] as const;
export const SMOKE_VARIANT_IDS = [
  'LC01-V1-create-welcome',
  'LC01-V2-update-approve',
  'LC04-V1-personal-read',
  'LC08-V1-create-due',
] as const;

export interface FixtureRequirement {
  slot: string;
  kind: FixtureKind;
  fixtureClass: FixtureClass;
  sourceDigest?: string;
}

export interface CleanupIntent {
  strategy: CleanupStrategy;
  fixtureClass: FixtureClass;
  reversalActionId?: ActionId;
  residue?: {
    kind: 'slack_message' | 'app_home_publication' | 'agent_tombstone';
    markerRequired: true;
    expectedState: string;
  };
}

export interface LiveAction {
  id: ActionId;
  message: string;
  mutation: MutationClass;
  humanGate: HumanGate;
  fixtureSlots: string[];
  cleanup: CleanupIntent;
}

export interface LiveAssertion {
  token: AssertionToken;
  observerId: ObserverId;
}

export interface GeneratedEffect {
  id: GeneratedEffectId;
  message: string;
  fixtureSlots: string[];
  observerId: ObserverId;
  cleanup: CleanupIntent;
}

export interface RegressionLesson {
  candidateId: string;
  lesson: string;
}

export interface LiveVariant {
  id: string;
  title: string;
  suites: Suite[];
  fixtures: FixtureRequirement[];
  actions: LiveAction[];
  generatedEffects: GeneratedEffect[];
  observers: ObserverId[];
  expected: LiveAssertion[];
  forbidden: LiveAssertion[];
  regressions: RegressionLesson[];
  evidence: EvidenceField[];
}

export interface LiveContract {
  id: string;
  title: string;
  area: ProductArea;
  feature: ProductFeature;
  entryPoints: EntryPoint[];
  variants: LiveVariant[];
}

export interface LiveCatalog {
  schemaVersion: 'chickpea-live-catalog/v1';
  release: 'v1.0' | 'v1.1';
  pendingContractIds: string[];
  contracts: LiveContract[];
}

export interface LiveManifest {
  schemaVersion: 'chickpea-live-manifest/v1';
  release: 'v1.0' | 'v1.1';
  digest: string;
  pendingContractIds: string[];
  requiredVariants: Record<Suite, string[]>;
  contracts: LiveContract[];
}

export type LiveContractErrorCode =
  | 'DATATYPE_NOT_ALLOWED'
  | 'UNKNOWN_FIELD'
  | 'EXECUTABLE_FIELD'
  | 'SECRET_FIELD'
  | 'SECRET_VALUE'
  | 'PRIVATE_COORDINATE'
  | 'RAW_CONTENT_FIELD'
  | 'ABSOLUTE_PATH'
  | 'FREEFORM_URL'
  | 'INVALID_ID'
  | 'DUPLICATE_ID'
  | 'INVALID_VALUE'
  | 'MISSING_CLEANUP'
  | 'INVALID_RESIDUE'
  | 'NON_AUTHORITATIVE_ASSERTION'
  | 'UNKNOWN_ACTION_ID'
  | 'UNKNOWN_OBSERVER_ID'
  | 'INVENTORY_MISMATCH'
  | 'OVERLAY_VARIANT_MISMATCH'
  | 'FIXTURE_MISMATCH'
  | 'SOURCE_NOT_PINNED'
  | 'SOURCE_DIGEST_MISMATCH'
  | 'FEATURE_MAP_STALE';

export class LiveContractValidationError extends Error {
  readonly code: LiveContractErrorCode;
  readonly path: string;

  constructor(code: LiveContractErrorCode, path = '$') {
    super(`${code} at ${path}`);
    this.name = 'LiveContractValidationError';
    this.code = code;
    this.path = path;
  }
}

export function defineLiveCase(contract: LiveContract): LiveContract {
  return validateLiveContract(contract);
}

export function requiredSuitesForVariant(variantId: string): Suite[] {
  return (SMOKE_VARIANT_IDS as readonly string[]).includes(variantId)
    ? ['case', 'smoke', 'deep']
    : ['case', 'deep'];
}

export function validateLiveCatalogShape(input: unknown): LiveCatalog {
  const value = record(input, '$');
  exactKeys(value, ['schemaVersion', 'release', 'pendingContractIds', 'contracts'], '$');
  if (value.schemaVersion !== 'chickpea-live-catalog/v1') fail('INVALID_VALUE', '$.schemaVersion');
  if (value.release !== 'v1.0' && value.release !== 'v1.1') fail('INVALID_VALUE', '$.release');
  const pendingContractIds = stringArray(value.pendingContractIds, '$.pendingContractIds');
  const contracts = array(value.contracts, '$.contracts').map((contract, index) =>
    validateLiveContract(contract, `$.contracts[${index}]`)
  );
  return { schemaVersion: value.schemaVersion, release: value.release, pendingContractIds, contracts };
}

export function validateLiveContract(input: unknown, path = '$'): LiveContract {
  const value = record(input, path);
  exactKeys(value, ['id', 'title', 'area', 'feature', 'entryPoints', 'variants'], path);
  const id = boundedString(value.id, `${path}.id`, 5, 5);
  if (!/^LC-(?:0[1-9]|10)$/.test(id)) fail('INVALID_ID', `${path}.id`);
  const title = boundedString(value.title, `${path}.title`, 1, 120);
  const area = enumValue(value.area, PRODUCT_AREAS, `${path}.area`);
  const feature = enumValue(value.feature, PRODUCT_FEATURES, `${path}.feature`);
  const entryPoints = enumArray(value.entryPoints, ENTRY_POINTS, `${path}.entryPoints`, true);
  const variants = array(value.variants, `${path}.variants`).map((variant, index) =>
    validateVariant(variant, `${path}.variants[${index}]`, id)
  );
  if (variants.length === 0) fail('INVALID_VALUE', `${path}.variants`);
  unique(variants.map((variant) => variant.id), `${path}.variants`);
  return { id, title, area, feature, entryPoints, variants };
}

function validateVariant(input: unknown, path: string, contractId: string): LiveVariant {
  const value = record(input, path);
  exactKeys(value, [
    'id', 'title', 'suites', 'fixtures', 'actions', 'generatedEffects', 'observers', 'expected', 'forbidden', 'regressions', 'evidence',
  ], path);
  const id = boundedString(value.id, `${path}.id`, 8, 100);
  const contractPrefix = contractId.replace('-', '');
  if (!new RegExp(`^${contractPrefix}-V[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(id)) {
    fail('INVALID_ID', `${path}.id`);
  }
  const title = boundedString(value.title, `${path}.title`, 1, 160);
  const suites = enumArray(value.suites, SUITES, `${path}.suites`, true);
  const fixtures = array(value.fixtures, `${path}.fixtures`).map((fixture, index) =>
    validateFixture(fixture, `${path}.fixtures[${index}]`)
  );
  unique(fixtures.map((fixture) => fixture.slot), `${path}.fixtures`);
  const fixtureSlots = new Set(fixtures.map((fixture) => fixture.slot));
  const actions = array(value.actions, `${path}.actions`).map((action, index) =>
    validateAction(action, `${path}.actions[${index}]`, fixtureSlots)
  );
  if (actions.length === 0) fail('INVALID_VALUE', `${path}.actions`);
  const observers = enumArray(value.observers, OBSERVER_IDS, `${path}.observers`, true, 'UNKNOWN_OBSERVER_ID');
  const generatedEffects = array(value.generatedEffects, `${path}.generatedEffects`).map((effect, index) =>
    validateGeneratedEffect(effect, `${path}.generatedEffects[${index}]`, fixtureSlots, observers)
  );
  const expected = assertionArray(value.expected, `${path}.expected`, observers);
  if (expected.length === 0) fail('INVALID_VALUE', `${path}.expected`);
  const forbidden = assertionArray(value.forbidden, `${path}.forbidden`, observers);
  const regressions = array(value.regressions, `${path}.regressions`).map((regression, index) => {
    const regressionPath = `${path}.regressions[${index}]`;
    const recordValue = record(regression, regressionPath);
    exactKeys(recordValue, ['candidateId', 'lesson'], regressionPath);
    const candidateId = boundedString(recordValue.candidateId, `${regressionPath}.candidateId`, 8, 100);
    if (!/^CAND-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(candidateId)) fail('INVALID_ID', `${regressionPath}.candidateId`);
    return {
      candidateId,
      lesson: boundedString(recordValue.lesson, `${regressionPath}.lesson`, 1, 300),
    };
  });
  if (regressions.length === 0) fail('INVALID_VALUE', `${path}.regressions`);
  const evidence = enumArray(value.evidence, EVIDENCE_FIELDS, `${path}.evidence`, true);
  return { id, title, suites, fixtures, actions, generatedEffects, observers, expected, forbidden, regressions, evidence };
}

function validateFixture(input: unknown, path: string): FixtureRequirement {
  const value = record(input, path);
  exactKeys(value, ['slot', 'kind', 'fixtureClass', 'sourceDigest'], path);
  const slot = alias(value.slot, `${path}.slot`);
  const kind = enumValue(value.kind, FIXTURE_KINDS, `${path}.kind`);
  const fixtureClass = enumValue(value.fixtureClass, FIXTURE_CLASSES, `${path}.fixtureClass`);
  const sourceDigest = value.sourceDigest === undefined
    ? undefined
    : boundedString(value.sourceDigest, `${path}.sourceDigest`, 71, 71);
  if (sourceDigest !== undefined && (kind !== 'source_fixture' || !/^sha256:[a-f0-9]{64}$/.test(sourceDigest))) {
    fail('INVALID_VALUE', `${path}.sourceDigest`);
  }
  return sourceDigest === undefined ? { slot, kind, fixtureClass } : { slot, kind, fixtureClass, sourceDigest };
}

function validateAction(input: unknown, path: string, fixtures: ReadonlySet<string>): LiveAction {
  const value = record(input, path);
  exactKeys(value, ['id', 'message', 'mutation', 'humanGate', 'fixtureSlots', 'cleanup'], path);
  const id = enumValue(value.id, ACTION_IDS, `${path}.id`, 'UNKNOWN_ACTION_ID');
  const message = messageTemplate(value.message, `${path}.message`);
  const mutation = enumValue(value.mutation, MUTATION_CLASSES, `${path}.mutation`);
  const humanGate = enumValue(value.humanGate, HUMAN_GATES, `${path}.humanGate`);
  const fixtureSlots = stringArray(value.fixtureSlots, `${path}.fixtureSlots`);
  unique(fixtureSlots, `${path}.fixtureSlots`);
  if (fixtureSlots.some((slot) => !fixtures.has(slot))) fail('FIXTURE_MISMATCH', `${path}.fixtureSlots`);
  const cleanup = validateCleanup(value.cleanup, `${path}.cleanup`);
  if (mutation !== 'none' && cleanup.strategy === 'not_required') fail('MISSING_CLEANUP', `${path}.cleanup`);
  if (mutation === 'none' && cleanup.strategy !== 'not_required') fail('INVALID_VALUE', `${path}.cleanup`);
  if (RESIDUE_ACTIONS.has(id) && cleanup.strategy !== 'attributed_residue') {
    fail('INVALID_RESIDUE', `${path}.cleanup`);
  }
  return { id, message, mutation, humanGate, fixtureSlots, cleanup };
}

function validateGeneratedEffect(
  input: unknown,
  path: string,
  fixtures: ReadonlySet<string>,
  observers: readonly ObserverId[],
): GeneratedEffect {
  const value = record(input, path);
  exactKeys(value, ['id', 'message', 'fixtureSlots', 'observerId', 'cleanup'], path);
  const id = enumValue(value.id, GENERATED_EFFECT_IDS, `${path}.id`);
  const message = messageTemplate(value.message, `${path}.message`);
  const fixtureSlots = stringArray(value.fixtureSlots, `${path}.fixtureSlots`);
  unique(fixtureSlots, `${path}.fixtureSlots`);
  if (fixtureSlots.some((slot) => !fixtures.has(slot))) fail('FIXTURE_MISMATCH', `${path}.fixtureSlots`);
  const observerId = enumValue(value.observerId, OBSERVER_IDS, `${path}.observerId`, 'UNKNOWN_OBSERVER_ID');
  if (!observers.includes(observerId) || !OBSERVER_REGISTRY[observerId].authoritative) {
    fail('NON_AUTHORITATIVE_ASSERTION', `${path}.observerId`);
  }
  const cleanup = validateCleanup(value.cleanup, `${path}.cleanup`);
  if (cleanup.strategy !== 'attributed_residue') fail('INVALID_RESIDUE', `${path}.cleanup`);
  if (id === 'slack.message.generated' && cleanup.residue?.kind !== 'slack_message') {
    fail('INVALID_RESIDUE', `${path}.cleanup.residue`);
  }
  return { id, message, fixtureSlots, observerId, cleanup };
}

function validateCleanup(input: unknown, path: string): CleanupIntent {
  if (input === undefined) fail('MISSING_CLEANUP', path);
  const value = record(input, path);
  exactKeys(value, ['strategy', 'fixtureClass', 'reversalActionId', 'residue'], path);
  const strategy = enumValue(value.strategy, CLEANUP_STRATEGIES, `${path}.strategy`);
  const fixtureClass = enumValue(value.fixtureClass, FIXTURE_CLASSES, `${path}.fixtureClass`);
  if (strategy === 'not_required') {
    if (value.reversalActionId !== undefined || value.residue !== undefined || fixtureClass !== 'immutable_baseline') {
      fail('INVALID_VALUE', path);
    }
    return { strategy, fixtureClass };
  }
  if (strategy === 'exact_reversal' || strategy === 'revision_restore') {
    const reversalActionId = enumValue(value.reversalActionId, ACTION_IDS, `${path}.reversalActionId`, 'UNKNOWN_ACTION_ID');
    if (value.residue !== undefined || fixtureClass === 'immutable_baseline') fail('INVALID_VALUE', path);
    return { strategy, fixtureClass, reversalActionId };
  }
  if (value.reversalActionId !== undefined || fixtureClass !== 'attributed_residue') fail('INVALID_RESIDUE', path);
  const residuePath = `${path}.residue`;
  const residueValue = record(value.residue, residuePath);
  exactKeys(residueValue, ['kind', 'markerRequired', 'expectedState'], residuePath);
  if (!['slack_message', 'app_home_publication', 'agent_tombstone'].includes(String(residueValue.kind)) ||
      residueValue.markerRequired !== true) {
    fail('INVALID_RESIDUE', residuePath);
  }
  const residue = {
    kind: residueValue.kind as 'slack_message' | 'app_home_publication' | 'agent_tombstone',
    markerRequired: true as const,
    expectedState: boundedString(residueValue.expectedState, `${residuePath}.expectedState`, 1, 300),
  };
  return { strategy, fixtureClass, residue };
}

function assertionArray(input: unknown, path: string, observers: readonly ObserverId[]): LiveAssertion[] {
  return array(input, path).map((assertion, index) => {
    const assertionPath = `${path}[${index}]`;
    const value = record(assertion, assertionPath);
    exactKeys(value, ['token', 'observerId'], assertionPath);
    const token = enumValue(value.token, ASSERTION_TOKENS, `${assertionPath}.token`);
    const observerId = enumValue(value.observerId, OBSERVER_IDS, `${assertionPath}.observerId`, 'UNKNOWN_OBSERVER_ID');
    if (!observers.includes(observerId)) fail('UNKNOWN_OBSERVER_ID', `${assertionPath}.observerId`);
    if (!OBSERVER_REGISTRY[observerId].authoritative) fail('NON_AUTHORITATIVE_ASSERTION', `${assertionPath}.observerId`);
    return { token, observerId };
  });
}

function messageTemplate(input: unknown, path: string): string {
  const message = boundedString(input, path, 1, 1_000);
  for (const match of message.matchAll(/\{\{([^}]+)\}\}/g)) {
    if (match[1] !== 'runMarker') fail('PRIVATE_COORDINATE', path);
  }
  return message;
}

const RESIDUE_ACTIONS = new Set<ActionId>(['slack.message.send', 'agent.archive']);

export function fail(code: LiveContractErrorCode, path = '$'): never {
  throw new LiveContractValidationError(code, path);
}

export function record(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('DATATYPE_NOT_ALLOWED', path);
  }
  return input as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail('UNKNOWN_FIELD', path);
}

export function array(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) fail('DATATYPE_NOT_ALLOWED', path);
  return input;
}

export function boundedString(input: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof input !== 'string' || input.length < minimum || input.length > maximum || input.trim() !== input) {
    fail('INVALID_VALUE', path);
  }
  return input;
}

export function alias(input: unknown, path: string): string {
  const value = boundedString(input, path, 1, 80);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) fail('INVALID_ID', path);
  return value;
}

function stringArray(input: unknown, path: string): string[] {
  const values = array(input, path).map((value, index) => boundedString(value, `${path}[${index}]`, 1, 160));
  unique(values, path);
  return values;
}

function enumArray<const Values extends readonly string[]>(
  input: unknown,
  allowed: Values,
  path: string,
  requireValue: boolean,
  code: LiveContractErrorCode = 'INVALID_VALUE',
): Values[number][] {
  const values = array(input, path).map((value, index) => enumValue(value, allowed, `${path}[${index}]`, code));
  if (requireValue && values.length === 0) fail('INVALID_VALUE', path);
  unique(values, path);
  return values;
}

function enumValue<const Values extends readonly string[]>(
  input: unknown,
  allowed: Values,
  path: string,
  code: LiveContractErrorCode = 'INVALID_VALUE',
): Values[number] {
  if (typeof input !== 'string' || !(allowed as readonly string[]).includes(input)) fail(code, path);
  return input as Values[number];
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail('DUPLICATE_ID', path);
}
