// Shared by tests/environment-preflight*.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { createEnvironmentRegistry } from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { EnvironmentPreflightError, writeEnvironmentBaseline, writeEnvironmentResourceCreationIntent, writeEnvironmentResourceCreationReceipt } from '../scripts/lib/environment-preflight.mjs';
import { readTargetLock } from '../qa/live/safety/lock.ts';

export const NOW = Date.parse('2026-09-01T12:00:00.000Z');
export const DEAD_PID = 2_147_483_647;
export const TARGETS = ['amber', 'cobalt'] as const;

export function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function fixture(input: {
  schemaGeneration?: string;
  reachable?: boolean;
  identityMatches?: boolean;
  transport?: 'events' | 'gateway';
  baseline?: Record<string, unknown>;
} = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-preflight-')));
  const worktree = join(parent, 'worktree');
  const root = join(parent, 'registry');
  mkdirSync(worktree);
  git(worktree, 'init', '-b', 'feature/preflight');
  git(worktree, 'config', 'user.email', 'fixture@example.test');
  git(worktree, 'config', 'user.name', 'Fixture');
  writeFileSync(join(worktree, '.gitignore'), '.chickpea-environment\n');
  writeFileSync(join(worktree, 'source.txt'), 'fixture\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'fixture');
  const revision = git(worktree, 'rev-parse', 'HEAD');
  const records = TARGETS.map((target) => {
    const evidenceRoot = join(parent, target, 'evidence');
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    return {
      target, role: 'branch', transport: input.transport ?? 'events', workerName: `chickpea-${target}-live`,
      authDatabaseBinding: 'AUTH_DB', authDatabaseName: `chickpea-auth-db-${target}-live`,
      authDatabaseId: `d1-${target}`, workspaceId: `T_${target.toUpperCase()}`,
      workspaceLabel: `${target} workspace`, slackAppId: `A_${target.toUpperCase()}`,
      slackAppLabel: `${target} app`, botUserId: `U_${target.toUpperCase()}_BOT`,
      providerProjectId: `provider-${target}`,
      providerAuthConfigId: `provider-read-${target}`,
      timezone: 'America/Los_Angeles', evidenceRoot,
      bindingIdentities: { AUTH_DB: `d1-${target}`, TAG_STATE: `tag-${target}` },
      schemaGeneration: input.schemaGeneration ?? 'd1:0002_mcp_oauth;do:v9',
      servingVersion: `version-${target}`,
      sourceRevision: revision, sourceDirty: false,
      reachable: input.reachable ?? true,
      identityMatches: input.identityMatches ?? true,
      computerUseSurfaces: {
        bridgeAvailable: true, windowCaptureAvailable: true, slackVisible: true, adminVisible: true,
      },
      missingActorAliases: [],
    };
  });
  createEnvironmentRegistry({
    root, hostFingerprint: 'host-fixture', targets: records,
    sandbox: {
      archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5,
      workspaceSlotsUsed: 3, integrationHeadroom: 37,
    },
  });
  writeEnvironmentBaseline(records[0]!.evidenceRoot, input.baseline ?? baseline());
  const options = {
    root, hostFingerprint: 'host-fixture', worktreePath: worktree, now: () => NOW,
    allowTestAuthorityObserver: true,
  };
  return { parent, root, worktree, revision, records, options };
}

export function fingerprints(target: string) {
  return Object.fromEntries(['auth', 'cookie', 'signing', 'recovery', 'setup', 'encryption']
    .map((name, index) => [name, `sha256:${target.charCodeAt(0).toString(16)}${index}`.padEnd(71, '0')]));
}

export function baseline(target = 'amber') {
  return {
    schemaVersion: 'chickpea-environment-baseline/v1', target,
    manifestDigest: `sha256:${'1'.repeat(64)}`, requiredScopes: ['chat:write'],
    setupContractDigest: `sha256:${'2'.repeat(64)}`,
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    credentialFingerprintsByTarget: Object.fromEntries(TARGETS.map((name) => [name, fingerprints(name)])),
  };
}

export function localContract() {
  return {
    manifestDigest: `sha256:${'1'.repeat(64)}`, requiredScopes: ['chat:write'],
    existingInstallManifestDigest: `sha256:${'1'.repeat(64)}`,
    existingInstallScopes: ['chat:write'],
    setupContractDigest: `sha256:${'2'.repeat(64)}`,
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    schemaHistory: {
      d1: ['0001_old', '0002_mcp_oauth', '0003_reviewed'],
      durableObject: ['v8', 'v9', 'v10'],
    },
  };
}

export const INSTALL_DIGEST = `sha256:${'a'.repeat(64)}`;
export const OTHER_INSTALL_DIGEST = `sha256:${'b'.repeat(64)}`;
export const FLOW_DIGEST = `sha256:${'c'.repeat(64)}`;
export const OTHER_FLOW_DIGEST = `sha256:${'d'.repeat(64)}`;
export const OTHER_COMBINED_DIGEST = `sha256:${'4'.repeat(64)}`;

export function splitBaseline(overrides: Record<string, unknown> = {}) {
  return {
    ...baseline(),
    installContractDigest: INSTALL_DIGEST,
    setupFlowDigest: FLOW_DIGEST,
    ...overrides,
  };
}

export function splitLocalContract(overrides: Record<string, unknown> = {}) {
  return {
    ...localContract(),
    installContractDigest: INSTALL_DIGEST,
    setupFlowDigest: FLOW_DIGEST,
    ...overrides,
  };
}

export function optionalListsLocalContract(overrides: Record<string, unknown> = {}) {
  return splitLocalContract({
    manifestDigest: `sha256:${'3'.repeat(64)}`,
    requiredScopes: ['chat:write', 'lists:read', 'lists:write'],
    existingInstallManifestDigest: `sha256:${'1'.repeat(64)}`,
    existingInstallScopes: ['chat:write'],
    ...overrides,
  });
}

export function authority(target = 'amber', overrides: Record<string, unknown> = {}) {
  const activeVersion = typeof overrides.activeVersion === 'string'
    ? overrides.activeVersion
    : `version-${target}`;
  return {
    target, observedAt: new Date(NOW).toISOString(), workerName: `chickpea-${target}-live`,
    activeVersion, activePercentage: 100,
    bindingIdentities: { AUTH_DB: `d1-${target}`, TAG_STATE: `tag-${target}` },
    slack: {
      teamId: `T_${target.toUpperCase()}`, appId: `A_${target.toUpperCase()}`,
      botUserId: `U_${target.toUpperCase()}_BOT`, replySenderId: `U_${target.toUpperCase()}_BOT`,
      scopes: ['chat:write'],
    },
    transport: 'events',
    transportAuthority: {
      installationHealthy: true, signedEventReceiptFresh: true,
      signedEventReceiptVersionId: activeVersion,
      signedEventReceiptAt: new Date(NOW).toISOString(), installationRevision: 1,
      eventsVerified: true,
    },
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    credentialFingerprints: fingerprints(target),
    fleetCredentialFingerprints: Object.fromEntries(TARGETS.map((name) => [name, fingerprints(name)])),
    deploymentMetadata: null,
    ...overrides,
  };
}

export const RUNTIME_SECRET_SOURCE_BINDINGS = {
  auth: 'CHICKPEA_AUTH_SECRET', cookie: 'hkdf(CHICKPEA_AUTH_SECRET,chickpea/cookie/v1)',
  signing: 'SLACK_SIGNING_SECRET', recovery: 'CHICKPEA_RECOVERY_TOKEN',
  setup: 'CHICKPEA_SETUP_CAPABILITY_DIGEST',
  encryption: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID+CHICKPEA_CREDENTIAL_KEY_<ID>',
};

export function runtimeAuthorities(fingerprintFor = (target: string) => fingerprints(target)) {
  return Object.fromEntries(TARGETS.map((target) => [target, {
    schemaVersion: 'chickpea-environment-runtime-authority/v1', target,
    observedAt: new Date(NOW).toISOString(),
    secretFingerprints: {
      schemaVersion: 'chickpea-environment-runtime-secret-fingerprints/v1',
      sourceBindings: RUNTIME_SECRET_SOURCE_BINDINGS,
      fingerprints: fingerprintFor(target),
    },
    transportAuthority: {
      installationHealthy: true, signedEventReceiptFresh: true,
      signedEventReceiptVersionId: `version-${target}`,
      signedEventReceiptAt: new Date(NOW).toISOString(), installationRevision: 1,
      eventsVerified: true,
    },
  }]));
}

export function protectedInventories(
  additions: Partial<Record<(typeof TARGETS)[number], {
    baseline?: Array<{ provider: string; kind: string; id: string }>;
    productOwned?: Array<{ provider: string; kind: string; id: string }>;
  }>> = {},
) {
  return TARGETS.map((target) => ({
    schemaVersion: 'chickpea-environment-protected-resource-inventory/v1',
    target,
    baseline: additions[target]?.baseline ?? [],
    productOwned: additions[target]?.productOwned ?? [],
  }));
}

export function rejects(code: string) {
  return (error: unknown) => error instanceof EnvironmentPreflightError
    && (error as { code?: unknown }).code === code;
}

export function installationDatabaseReceipt(parent: string, target: string, options: object) {
  const intentPath = join(parent, `${target}-d1-intent.json`);
  const receiptPath = join(parent, `${target}-d1-receipt.json`);
  const intent = writeEnvironmentResourceCreationIntent(intentPath, { target, provider: 'cloudflare', kind: 'd1' }, options);
  writeEnvironmentResourceCreationReceipt(receiptPath, {
    target, provider: 'cloudflare', kind: 'd1', id: 'fresh-d1', intentPath,
    providerReadback: { target, provider: 'cloudflare', kind: 'd1', id: 'fresh-d1', immutableId: 'fresh-d1',
      creationIntentDigest: intent.intentDigest, observedAt: new Date(NOW).toISOString() },
  }, { ...options, allowSuppliedProviderReadback: true });
  return receiptPath;
}

export function nodeInstallationFixture(context: { after: (fn: () => void) => void }) {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const installer = join(f.parent, 'node-release');
  mkdirSync(join(installer, 'dist'), { recursive: true });
  const before = { slack: { workspace: 'T_AMBER' }, admin: { owner: 'test-owner' },
    fixtures: { agent: 'smoke-amber' }, pendingWork: false, independentAppsResolved: true };
  const beforePath = join(f.parent, 'node-before.json');
  writeFileSync(beforePath, JSON.stringify(before), { mode: 0o600 });
  const spec = { runtime: 'node', runId: 'node-install', installerPath: installer,
    beforeEvidence: beforePath, stateParent: f.parent };
  const specPath = join(f.parent, 'node-spec.json');
  writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const envPath = join(f.parent, 'node-env.json');
  writeFileSync(envPath, JSON.stringify({ DO_NOT_TRACK: '1' }), { mode: 0o600 });
  return { ...f, installer, before, beforePath, spec, specPath, envPath,
    options: { ...f.options, localContract: localContract(), observeAuthority: async () => authority() } };
}

export function makeMutationLockStale(evidenceRoot: string) {
  const lockPath = join(evidenceRoot, 'target.lock');
  const owner = readTargetLock(lockPath);
  assert.ok(owner);
  writeFileSync(lockPath, `${JSON.stringify({ ...owner, pid: DEAD_PID })}\n`, { mode: 0o600 });
}

export function runNodeModule(source: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', source,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
