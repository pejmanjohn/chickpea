import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import {
  configureHostedSandboxPolicy,
  HOSTED_SANDBOX_POLICY_LAST_KNOWN_MS,
  HOSTED_SANDBOX_POLICY_TTL_MS,
  hostedSandboxPolicy,
  resetHostedSandboxPolicyForTests,
} from '../src/config/hosted-sandbox-policy.ts';
import {
  configureInstallationAdmission,
  InstallationNotAdmittedError,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import {
  InstallationContextError,
  scopeInstallationEnv,
  splitInstallationObjectName,
} from '../src/config/installation-scope.ts';
import { resolveSandboxSettings, SANDBOX_SETTING_KEYS } from '../src/config/sandbox-settings.ts';
import { SqliteSettingsStore, type SettingsPatch } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { SandboxEgressContext } from '../src/sandbox/cloudflare-policy.ts';
import {
  admitSandboxContainer,
  closeLapsedSandboxContainerLeases,
  holdSandboxContainerLease,
  readSandboxContainerUsage,
  releaseSandboxContainerLease,
  SANDBOX_CONTAINER_LEASE_MS,
  SANDBOX_CONTAINER_LEASES_KEY,
  SANDBOX_CONTAINER_SECONDS_PREFIX,
} from '../src/sandbox/container-lease.ts';
import {
  githubSandboxOutbound,
  packageRegistrySandboxOutbound,
  SANDBOX_BLOCKED_STATUS,
  type SandboxEgressStub,
} from '../src/sandbox/egress-outbound.ts';
import { SandboxSessionCapError, SandboxUnavailableError } from '../src/sandbox/errors.ts';
import {
  admitGithubWrite,
  GITHUB_PULL_REQUESTS_PER_WINDOW,
  GITHUB_WRITE_WINDOW_MS,
  GITHUB_WRITES_KEY,
  GITHUB_WRITES_PER_WINDOW,
} from '../src/sandbox/github-write-rate.ts';
import { decideSandboxEgress } from '../src/sandbox/egress-handler.ts';
import {
  admitWorkspaceContainer,
  maintainWorkspaceContainerLeases,
  meterWorkspaceContainer,
  requireWorkspaceTurnAdmitted,
} from '../src/sandbox/hosted-limits.ts';
import { WorkspaceSession, type WorkspaceSandboxStub } from '../src/sandbox/workspace-session.ts';
import {
  HOSTED_WORKSPACE_SESSION_CAP_MESSAGE,
  WORKSPACE_SESSION_CAP_MESSAGE,
  workspaceSessionCapMessage,
} from '../src/sandbox/workspace-tools.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

/**
 * H12b: on a deployment serving many installations the host's policy, not
 * the tenant's settings, decides the coding sandbox; the host's running
 * limit, container-hours cap, suspension and GitHub write rate bound each
 * installation. Standalone keeps its operator's settings and nothing more.
 */

const INSTALLATION_A = `inst_${'0123456789abcdef'.repeat(2)}`;
const INSTALLATION_B = `inst_${'fedcba9876543210'.repeat(2)}`;
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const hostedEnv = (installationId: string, bindings: Record<string, unknown> = {}) =>
  scopeInstallationEnv({ ...HOSTED, ...bindings } as Record<string, unknown>, { installationId });

const STAGING_POLICY = {
  enabled: true,
  allowedHosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
  monthlySessionCap: 50,
  monthlyContainerHours: 20,
  maxRunningContainers: 2,
};
const LIMITS = { monthlyContainerHours: 20, maxRunningContainers: 2 };
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

function hostPolicy(t: TestContext, read: (installationId: string) => unknown, now?: () => number) {
  resetHostedSandboxPolicyForTests(now ? { now } : {});
  configureHostedSandboxPolicy(read);
  t.after(() => resetHostedSandboxPolicyForTests());
}

function settingsStore(t: TestContext) {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  return store;
}

/** A tenant whose own settings say the opposite of the host's policy. */
async function contraryTenant(t: TestContext) {
  const store = settingsStore(t);
  await store.setSetting(SANDBOX_SETTING_KEYS.enabled, 'false');
  await store.setSetting(SANDBOX_SETTING_KEYS.allowedHosts, JSON.stringify([]));
  await store.setSetting(SANDBOX_SETTING_KEYS.monthlySessionCap, '0');
  await store.setSetting(SANDBOX_SETTING_KEYS.installRequested, 'true');
  return store;
}

// --- The policy port ------------------------------------------------------

test('under tenancy the host\'s policy decides the sandbox and the tenant\'s own settings are never read', async (t) => {
  const asked: string[] = [];
  hostPolicy(t, (installationId) => {
    asked.push(installationId);
    return { ...STAGING_POLICY, allowedHosts: ['Registry.NPMJS.org', 'evil.example', 'pypi.org', 'pypi.org'] };
  });
  const tenant = await contraryTenant(t);
  const read: string[] = [];
  const watched = new Proxy(tenant, {
    get(target, property, receiver) {
      if (property === 'getSetting' || property === 'getSettings') read.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  const settings = await resolveSandboxSettings(watched, hostedEnv(INSTALLATION_A));
  assert.deepEqual(settings, {
    installRequested: false,
    enabled: true,
    instanceType: 'standard-1',
    // The turn's registry snapshot follows the policy, curated only.
    allowedHosts: ['registry.npmjs.org', 'pypi.org'],
    monthlySessionCap: 50,
    monthlySessionCapConfigured: true,
    containerLimits: LIMITS,
  });
  assert.deepEqual(read, [], 'no tenant setting is read');
  assert.deepEqual(asked, [INSTALLATION_A]);

  // Standalone keeps its operator's settings, with no host limits.
  const standalone = await resolveSandboxSettings(tenant, undefined);
  assert.equal(standalone.enabled, false);
  assert.deepEqual(standalone.allowedHosts, []);
  assert.equal(standalone.monthlySessionCap, 0);
  assert.equal('containerLimits' in standalone, false);
});

test('without a valid host policy an installation has no coding sandbox', async (t) => {
  const tenant = await contraryTenant(t);
  await tenant.setSetting(SANDBOX_SETTING_KEYS.enabled, 'true');
  t.mock.method(console, 'error', () => {});
  // No reader installed: fail closed, whatever the tenant stored.
  resetHostedSandboxPolicyForTests();
  t.after(() => resetHostedSandboxPolicyForTests());
  assert.equal((await resolveSandboxSettings(tenant, hostedEnv(INSTALLATION_A))).enabled, false);
  // An incomplete or out-of-range answer is no policy.
  for (const invalid of [
    undefined, null, 'on', { ...STAGING_POLICY, enabled: 'true' },
    { ...STAGING_POLICY, monthlySessionCap: 0 }, { ...STAGING_POLICY, monthlyContainerHours: 0 },
    { ...STAGING_POLICY, maxRunningContainers: 1.5 }, { ...STAGING_POLICY, allowedHosts: 'pypi.org' },
    { enabled: true },
  ]) {
    hostPolicy(t, () => invalid);
    assert.equal((await resolveSandboxSettings(tenant, hostedEnv(INSTALLATION_A))).enabled, false, JSON.stringify(invalid));
  }
  // An env naming no installation is a fault, not a policy.
  hostPolicy(t, () => STAGING_POLICY);
  await assert.rejects(resolveSandboxSettings(tenant, HOSTED as Record<string, unknown>),
    (error: unknown) => error instanceof InstallationContextError);
});

test('a host policy is kept 30 seconds per installation; a failing reader keeps the last answer ten minutes, then closes', async (t) => {
  let now = T0;
  let reads = 0;
  let failing = false;
  hostPolicy(t, (installationId) => {
    reads += 1;
    if (failing) throw new Error('registry down');
    return { ...STAGING_POLICY, maxRunningContainers: installationId === INSTALLATION_A ? 2 : 3 };
  }, () => now);
  t.mock.method(console, 'warn', () => {});
  assert.equal((await hostedSandboxPolicy(INSTALLATION_A)).maxRunningContainers, 2);
  assert.equal((await hostedSandboxPolicy(INSTALLATION_B)).maxRunningContainers, 3, 'per installation');
  assert.equal((await hostedSandboxPolicy(INSTALLATION_A)).maxRunningContainers, 2);
  assert.equal(reads, 2, 'cached');
  now += HOSTED_SANDBOX_POLICY_TTL_MS;
  failing = true;
  assert.equal((await hostedSandboxPolicy(INSTALLATION_A)).enabled, true, 'last known answer stands');
  now += HOSTED_SANDBOX_POLICY_LAST_KNOWN_MS;
  assert.equal((await hostedSandboxPolicy(INSTALLATION_A)).enabled, false, 'then the sandbox is off');
});

test('hosted Admin reads the sandbox status from the host policy, with no account notes', async (t) => {
  hostPolicy(t, () => STAGING_POLICY);
  const tenant = await contraryTenant(t);
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  t.after(() => config.close());
  const app = new Hono();
  app.route('/', createAdminRoutes({ store: config, settings: tenant, ...testAdminAuthority('h12b-token') }));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const SANDBOX = { idFromName: (name: string) => name, get: () => ({ probeContainerRuntime: async () => true }) };
  const response = await app.request('/admin/api/sandbox/status', { headers: testAdminHeaders('h12b-token') },
    hostedEnv(INSTALLATION_A, { SANDBOX }));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.containerApplication, 'attached');
  assert.equal(body.enabled, true);
  assert.equal(body.storedEnabled, true);
  assert.equal(body.installRequested, false);
  assert.deepEqual(body.allowedHosts, STAGING_POLICY.allowedHosts);
  assert.equal(body.monthlySessionCap, 50);
  assert.equal(body.workersPaidNote, null);
  assert.equal(body.checkpointsNote, null);
});

// --- Running containers and monthly container time ------------------------

test('an installation starts no more containers than the host allows; a warm container is reused', async (t) => {
  const store = settingsStore(t);
  const admit = (key: string, running = false, now = T0) =>
    admitSandboxContainer({ store, key, running, limits: LIMITS, now });
  assert.equal(await admit('do_1'), 'admitted');
  assert.equal(await admit('do_2'), 'admitted');
  assert.equal(await admit('do_3'), 'running_limit');
  assert.equal(await admit('do_1', true, T0 + MINUTE), 'admitted', 'warm reuse holds its own lease');
  assert.equal((await readSandboxContainerUsage({ store, now: T0 })).running, 2);
  await releaseSandboxContainerLease({ store, key: 'do_2', now: T0 + 2 * MINUTE });
  assert.equal(await admit('do_3', false, T0 + 2 * MINUTE), 'admitted');
});

test('concurrent starts in one installation cannot pass the running limit', async (t) => {
  const store = settingsStore(t);
  const limits = { monthlyContainerHours: 20, maxRunningContainers: 1 };
  const results = await Promise.all(['do_1', 'do_2', 'do_3'].map((key) =>
    admitSandboxContainer({ store, key, running: false, limits, now: T0 })));
  assert.deepEqual(results.filter((result) => result === 'admitted').length, 1);
  assert.equal((await readSandboxContainerUsage({ store, now: T0 })).running, 1);
});

test('a stopped container\'s run is metered once, and the month\'s cap refuses even warm reuse', async (t) => {
  const store = settingsStore(t);
  const limits = { monthlyContainerHours: 1, maxRunningContainers: 3 };
  assert.equal(await admitSandboxContainer({ store, key: 'do_1', running: false, limits, now: T0 }), 'admitted');
  assert.equal(await releaseSandboxContainerLease({ store, key: 'do_1', now: T0 + 40 * MINUTE }), 2_400);
  assert.equal(await releaseSandboxContainerLease({ store, key: 'do_1', now: T0 + 41 * MINUTE }), 0, 'never twice');
  assert.equal((await readSandboxContainerUsage({ store, now: T0 })).meteredSeconds, 2_400);
  // A running container's time counts before it stops.
  assert.equal(await admitSandboxContainer({ store, key: 'do_2', running: false, limits, now: T0 + 41 * MINUTE }), 'admitted');
  assert.equal(await admitSandboxContainer({ store, key: 'do_2', running: true, limits, now: T0 + 61 * MINUTE }), 'hours_cap');
  assert.equal(await admitSandboxContainer({ store, key: 'do_3', running: false, limits, now: T0 + 61 * MINUTE }), 'hours_cap');
  // A new month starts from zero.
  await releaseSandboxContainerLease({ store, key: 'do_2', now: T0 + 62 * MINUTE });
  assert.equal(await store.getSetting(`${SANDBOX_CONTAINER_SECONDS_PREFIX}2026-10`), JSON.stringify({ seconds: 2_400 + 1_260 }));
  const nextMonth = Date.UTC(2026, 10, 1, 0, 5);
  assert.equal(await admitSandboxContainer({ store, key: 'do_3', running: false, limits, now: nextMonth }), 'admitted');
});

test('a lease left by a run that stopped unseen is charged up to its lapse and frees its slot', async (t) => {
  const store = settingsStore(t);
  const limits = { monthlyContainerHours: 20, maxRunningContainers: 1 };
  await admitSandboxContainer({ store, key: 'do_1', running: false, limits, now: T0 });
  // Its Sandbox starts a container again, without having seen the stop.
  assert.equal(await admitSandboxContainer({ store, key: 'do_1', running: false, limits, now: T0 + 3 * 60 * MINUTE }), 'admitted');
  const usage = await readSandboxContainerUsage({ store, now: T0 });
  assert.equal(usage.meteredSeconds, SANDBOX_CONTAINER_LEASE_MS / 1_000, 'charged up to its lapse, not the gap');
  assert.equal(usage.running, 1);
  // Starting holds a lease; a lapsed one is the earlier run's.
  await holdSandboxContainerLease({ store, key: 'do_1', now: T0 + 3 * 60 * MINUTE + 1 });
  await holdSandboxContainerLease({ store, key: 'do_2', now: T0 + 10 * 60 * MINUTE });
  const leases = JSON.parse(String(await store.getSetting(SANDBOX_CONTAINER_LEASES_KEY))) as Record<string, { startedAt: number }>;
  assert.equal(leases.do_2!.startedAt, T0 + 10 * 60 * MINUTE);
});

test('maintenance closes a lapsed lease only once its container stopped, and starts none', async (t) => {
  const store = settingsStore(t);
  for (const key of ['do_live', 'do_gone', 'do_fresh']) {
    await admitSandboxContainer({ store, key, running: false, limits: { ...LIMITS, maxRunningContainers: 3 }, now: key === 'do_fresh' ? T0 + 30 * MINUTE : T0 });
  }
  const asked: string[] = [];
  const later = T0 + 40 * MINUTE;
  assert.deepEqual(await closeLapsedSandboxContainerLeases({
    store, now: later, running: async (key) => { asked.push(key); return key === 'do_live'; },
  }), { closed: 1, renewed: 1 });
  assert.deepEqual(asked.sort(), ['do_gone', 'do_live'], 'only lapsed leases are checked');
  const usage = await readSandboxContainerUsage({ store, now: later });
  assert.equal(usage.running, 2);
  assert.equal(usage.meteredSeconds, SANDBOX_CONTAINER_LEASE_MS / 1_000);
});

test('the Sandbox wiring meters only an installation of many, never throws, and wakes only its own lease\'s Sandbox', async (t) => {
  const untouchable = new Proxy({}, { get() { throw new Error('standalone reads no store'); } }) as SqliteSettingsStore;
  const input = { key: 'do_1', running: false, limits: LIMITS, now: T0 };
  assert.equal(await admitWorkspaceContainer(undefined, input, untouchable), 'admitted');
  assert.equal(await admitWorkspaceContainer({ CHICKPEA_TENANCY: 'standalone' }, input, untouchable), 'admitted');
  await meterWorkspaceContainer(undefined, 'hold', input, untouchable);
  await maintainWorkspaceContainerLeases({ SANDBOX: {} }, T0, untouchable);

  const store = settingsStore(t);
  const envA = hostedEnv(INSTALLATION_A);
  assert.equal(await admitWorkspaceContainer(envA, input, store), 'admitted');
  await assert.rejects(admitWorkspaceContainer(HOSTED as Record<string, unknown>, input, store), InstallationContextError);
  const warned = t.mock.method(console, 'warn', () => {});
  await meterWorkspaceContainer(envA, 'release', input, untouchable);
  assert.equal(warned.mock.callCount(), 1);
  assert.doesNotMatch(String(warned.mock.calls[0]!.arguments[0]), /inst_|do_1/, 'content-free');
  await meterWorkspaceContainer(envA, 'release', { key: 'do_1', now: T0 + MINUTE }, store);
  assert.equal((await readSandboxContainerUsage({ store, now: T0 })).meteredSeconds, 60);

  await meterWorkspaceContainer(envA, 'hold', { key: 'do_2', now: T0 }, store);
  const woken: string[] = [];
  const SANDBOX = {
    idFromString: (id: string) => ({ id }),
    get: (id: { id: string }) => ({ async isContainerRunning() { woken.push(id.id); return false; } }),
  };
  await maintainWorkspaceContainerLeases(hostedEnv(INSTALLATION_A, { SANDBOX }), T0 + 40 * MINUTE, store);
  assert.deepEqual(woken, ['do_2']);
  assert.equal((await readSandboxContainerUsage({ store, now: T0 })).running, 0);
});

// --- Activation ------------------------------------------------------------

function session(options: {
  hostedLimits?: typeof LIMITS;
  reserve?: boolean;
  admission?: string;
  calls: string[];
}) {
  const stub = {
    async prepareTurn() {},
    async beginWorkspaceTurn() { return { state: 'fresh', reservationId: 'turn_a', restorable: false }; },
    async configureEgress() {},
    async admitContainer() { options.calls.push('admitContainer'); return options.admission ?? 'admitted'; },
    async exists() { options.calls.push('exists'); return true; },
    async applyGitIdentity() {},
  };
  return new WorkspaceSession({
    id: 'T1:C1:1.0', name: 'main', agentId: 'agent_coder', turnId: 'turn_a', credentialMode: 'app',
    grants: [{ id: 'repo_1', installationId: 7, accountLogin: 'acme', fullName: 'acme/app', enabled: true }],
    mintStub: async () => stub as unknown as WorkspaceSandboxStub,
    reserveSession: async () => { options.calls.push('reserveSession'); return options.reserve ?? true; },
    toSandbox: async () => { throw new Error('unused'); },
    ...(options.hostedLimits ? { hostedLimits: options.hostedLimits } : {}),
  });
}

test('a hosted activation reserves its session, then admits its container, before the container starts', async () => {
  const calls: string[] = [];
  const stub = await session({ hostedLimits: LIMITS, calls }).activatable();
  await stub.exists('/workspace');
  assert.deepEqual(calls, ['reserveSession', 'admitContainer', 'exists', 'exists']);

  const standalone: string[] = [];
  await (await session({ calls: standalone }).activatable()).exists('/workspace');
  assert.deepEqual(standalone, ['reserveSession', 'exists', 'exists'], 'standalone admits no container');
});

test('hosted cap refusals say only the first sentence; running and unknown refusals are "temporarily unavailable"', async () => {
  const refusal = async (options: Omit<Parameters<typeof session>[0], 'calls'>) => {
    const calls: string[] = [];
    const stub = await session({ ...options, calls }).activatable();
    return { error: await stub.exists('/workspace').then(() => undefined, (error: unknown) => error), calls };
  };
  for (const options of [{ hostedLimits: LIMITS, admission: 'hours_cap' }, { hostedLimits: LIMITS, reserve: false }]) {
    const { error, calls } = await refusal(options);
    assert.ok(error instanceof SandboxSessionCapError);
    assert.equal(error.hosted, true);
    assert.equal(error.message, 'The coding workspace monthly session limit has been reached.');
    assert.equal(error.details, '');
    assert.equal(workspaceSessionCapMessage(error), HOSTED_WORKSPACE_SESSION_CAP_MESSAGE);
    assert.doesNotMatch(HOSTED_WORKSPACE_SESSION_CAP_MESSAGE, /Settings|administrator/);
    assert.equal(calls.includes('exists'), false, 'no container starts');
  }
  for (const admission of ['running_limit', 'unexpected']) {
    const { error, calls } = await refusal({ hostedLimits: LIMITS, admission });
    assert.ok(error instanceof SandboxUnavailableError, admission);
    assert.equal(error.message, 'The coding workspace is temporarily unavailable.');
    assert.equal(calls.includes('exists'), false);
  }
  // Standalone keeps both sentences.
  const { error } = await refusal({ reserve: false });
  assert.ok(error instanceof SandboxSessionCapError);
  assert.equal(error.hosted, false);
  assert.equal(error.details, 'An administrator can review the coding sandbox limit in Settings.');
  assert.equal(workspaceSessionCapMessage(error), WORKSPACE_SESSION_CAP_MESSAGE);
});

// --- Suspension ------------------------------------------------------------

function hostAdmits(t: TestContext, admitted: (installationId: string) => boolean) {
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async (installationId) => admitted(installationId) ? 'admitted' : 'refused');
  t.after(() => resetInstallationAdmissionForTests());
}

test('a suspended installation opens no workspace turn; standalone never asks', async (t) => {
  hostAdmits(t, (installationId) => installationId === INSTALLATION_A);
  await requireWorkspaceTurnAdmitted(hostedEnv(INSTALLATION_A));
  await assert.rejects(requireWorkspaceTurnAdmitted(hostedEnv(INSTALLATION_B)), InstallationNotAdmittedError);
  await assert.rejects(requireWorkspaceTurnAdmitted(HOSTED as Record<string, unknown>), InstallationContextError);
  resetInstallationAdmissionForTests();
  await requireWorkspaceTurnAdmitted(undefined);
});

test('the Sandbox asks admission before a turn, admits its container, and meters its runs', () => {
  const source = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  const sandbox = source.slice(source.indexOf('export class Sandbox extends CloudflareSandbox'), source.indexOf('Sandbox.outboundByHost ='));
  const method = (name: string) => {
    const start = sandbox.indexOf(`async ${name}(`);
    assert.ok(start >= 0, name);
    return sandbox.slice(start, sandbox.indexOf('\n  }\n', start));
  };
  assert.match(method('beginWorkspaceTurn'), /^[^]*?\{\s*\/\/[^\n]*\n\s*await requireWorkspaceTurnAdmitted\(this\.env\);/,
    'admission comes first');
  assert.match(method('admitContainer'), /admitWorkspaceContainer\(this\.env, \{\s*key: this\.ctx\.id\.toString\(\),\s*running: this\.containerRunning\(\),/);
  assert.match(method('onStart'), /await super\.onStart\(\);\s*await meterWorkspaceContainer\(this\.env, 'hold'/);
  assert.match(method('onStop'), /await super\.onStop\(params\);\s*await meterWorkspaceContainer\(this\.env, 'release'/);
  assert.match(method('endTurn'), /meterWorkspaceContainer\(\s*this\.env,\s*this\.containerRunning\(\) \? 'hold' : 'release'/);
  assert.match(source, /if \(isContainerLeaseSweepMinute\(scheduledTime\)\) \{\s*try \{ await maintainWorkspaceContainerLeases\(platformEnv, scheduledTime\); \}/);
});

/** A Sandbox namespace whose objects answer egress with `context`. */
function egressEnv(base: Record<string, unknown>, context: SandboxEgressContext) {
  const stub: SandboxEgressStub = {
    async egressContext() { return context; },
    async getTurnId() { return context.turnId; },
    async recordPullRequestProgress() { return true; },
  };
  return {
    ...base,
    SANDBOX: { idFromString: (id: string) => ({ id }), get: () => stub },
  };
}

test('a suspended installation\'s container reaches nothing', async (t) => {
  hostAdmits(t, (installationId) => installationId === INSTALLATION_A);
  const fetched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request) => { fetched.push(input.url); return new Response('ok'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const context = (installationId: string): SandboxEgressContext => ({
    installationId, turnId: 'turn_a', policy: { grants: [], mode: null, packageRegistryHosts: ['registry.npmjs.org'] },
  });
  const npm = 'https://registry.npmjs.org/left-pad';
  assert.equal((await packageRegistrySandboxOutbound(new Request(npm), egressEnv(HOSTED, context(INSTALLATION_A)), { containerId: 'do_a' })).status, 200);
  assert.equal((await packageRegistrySandboxOutbound(new Request(npm), egressEnv(HOSTED, context(INSTALLATION_B)), { containerId: 'do_b' })).status,
    SANDBOX_BLOCKED_STATUS);
  const github = await githubSandboxOutbound(new Request('https://api.github.com/repos/acme/app/pulls', { method: 'POST' }),
    egressEnv(HOSTED, { ...context(INSTALLATION_B), policy: { grants: [], mode: 'app' } }), { containerId: 'do_b' });
  assert.equal(github.status, SANDBOX_BLOCKED_STATUS);
  assert.deepEqual(fetched, [npm]);
});

// --- GitHub write rate -----------------------------------------------------

const GRANTS = [{ id: 'repo_1', installationId: 7, accountLogin: 'Acme', fullName: 'Acme/Alpha', enabled: true }];

/** What egress decides a request does: the effect the write rate counts, or `denied`. */
function effect(url: string, method = 'POST', headers?: Record<string, string>) {
  const decision = decideSandboxEgress({
    url, method, grants: GRANTS, allowedHosts: [], ...(headers ? { headers: new Headers(headers) } : {}),
  });
  if (!decision.allowed) return 'denied';
  assert.equal(decision.kind, 'github');
  return decision.kind === 'github' ? decision.effect : 'not github';
}

test('only a request that surely reads escapes the GitHub write count', () => {
  // Reads.
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls', 'GET'), 'read');
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls', 'get'), 'read');
  assert.equal(effect('https://github.com/Acme/Alpha.git/info/refs?service=git-receive-pack', 'GET'), 'read');
  assert.equal(effect('https://github.com/Acme/Alpha.git/git-upload-pack'), 'read', 'Git fetch posts');
  assert.equal(effect('https://github.com/Acme/Alpha/git-upload-pack'), 'read');
  // Pushes and REST writes, in any method case.
  assert.equal(effect('https://github.com/Acme/Alpha.git/git-receive-pack'), 'write');
  assert.equal(effect('https://github.com/Acme/Alpha.git/info/lfs/objects/batch'), 'write');
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/issues/1/comments', 'post'), 'write');
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls/4', 'patch'), 'write');
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/contents/a.md', 'PUT'), 'write');
});

test('crafted requests cannot pass a write off as a read', () => {
  // A method override, by header or parameter, makes even a GET a write.
  for (const name of ['X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override']) {
    assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls/4', 'GET', { [name]: 'PATCH' }), 'write', name);
  }
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls/4?_method=PATCH', 'GET'), 'write');
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls/4?_METHOD=patch', 'GET'), 'write');
  assert.equal(effect('https://github.com/Acme/Alpha.git/git-upload-pack', 'POST', { 'X-HTTP-Method-Override': 'PUT' }), 'write');
  // Only Git's exact fetch endpoint is a read: no encoding, case, suffix or query tricks.
  for (const path of [
    'Acme/Alpha.git/git%2Dupload-pack',
    'Acme/Alpha.git/GIT-UPLOAD-PACK',
    'Acme/Alpha.git/git-upload-pack/',
    'Acme/Alpha.git/git-upload-pack?service=git-receive-pack',
    'Acme/Alpha.git/git-upload-pack;x',
    'Acme/Alpha.git/git-receive-pack/git-upload-pack',
    'Acme/Alpha.git/x/../git-receive-pack',
  ]) {
    assert.equal(effect(`https://github.com/${path}`), 'write', path);
  }
  // A pull request path counts per day however it is spelled.
  for (const path of [
    'repos/Acme/Alpha/pulls', 'repos/Acme/Alpha/pulls/', 'repos/Acme/Alpha/PULLS', 'repos/acme/ALPHA/Pulls',
    'repos/Acme/Alpha/%70ulls', 'repos/Acme/Alpha//pulls', 'repos/Acme/Alpha/./pulls', 'repos/Acme/Alpha/pulls?state=open',
  ]) {
    assert.equal(effect(`https://api.github.com/${path}`), 'pull_request', path);
  }
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls', 'GET', { 'X-HTTP-Method-Override': 'POST' }), 'pull_request');
  // What egress does not forward to GitHub is never forwarded at all.
  assert.equal(effect('https://api.github.com/graphql'), 'denied', 'GraphQL mutations');
  assert.equal(effect('https://uploads.github.com/repos/Acme/Alpha/releases/1/assets'), 'denied', 'the uploads host');
  assert.equal(effect('https://api.github.com/repos/Acme/Alpha/pulls', 'DELETE'), 'denied');
  assert.equal(effect('https://github.com/Acme/Alpha.git/git-receive-pack', 'HEAD'), 'denied');
});

test('an installation writes to GitHub at most 60 times in 10 minutes and opens at most 30 pull requests a day', async (t) => {
  const store = settingsStore(t);
  for (let index = 0; index < GITHUB_WRITES_PER_WINDOW; index += 1) {
    assert.equal(await admitGithubWrite({ store, kind: 'write', now: T0 + index }), true);
  }
  assert.equal(await admitGithubWrite({ store, kind: 'write', now: T0 + 100 }), false);
  assert.equal(await admitGithubWrite({ store, kind: 'pull_request', now: T0 + 100 }), false);
  assert.equal(await admitGithubWrite({ store, kind: 'write', now: T0 + GITHUB_WRITE_WINDOW_MS }), true, 'the window slides');

  const prs = settingsStore(t);
  let now = T0;
  for (let index = 0; index < GITHUB_PULL_REQUESTS_PER_WINDOW; index += 1) {
    now += GITHUB_WRITE_WINDOW_MS / 10;
    assert.equal(await admitGithubWrite({ store: prs, kind: 'pull_request', now }), true);
  }
  assert.equal(await admitGithubWrite({ store: prs, kind: 'pull_request', now: now + 1 }), false);
  assert.equal(await admitGithubWrite({ store: prs, kind: 'write', now: now + 1 }), true, 'other writes go on');
  assert.equal(await admitGithubWrite({ store: prs, kind: 'pull_request', now: T0 + 24 * 60 * MINUTE + MINUTE }), true);
});

/** A state store per installation, as Cloudflare's TAG_STATE serves them. */
async function tagState(t: TestContext, seeds: Record<string, Record<string, string>>) {
  const stores = new Map<string, SqliteSettingsStore>();
  for (const [installationId, seed] of Object.entries(seeds)) {
    const store = settingsStore(t);
    for (const [key, value] of Object.entries(seed)) await store.setSetting(key, value);
    stores.set(installationId, store);
  }
  return {
    store: (installationId: string) => stores.get(installationId)!,
    TAG_STATE: {
      getByName(name: string) {
        const settings = stores.get(splitInstallationObjectName(name).scope?.installationId ?? name);
        if (!settings) throw new Error('no such installation');
        return {
          async settingGet(key: string) { return { ok: true, value: (await settings.getSetting(key)) ?? null }; },
          async settingGetMany(keys: readonly string[]) {
            return { ok: true, value: (await settings.getSettings(keys)).map((value) => value ?? null) };
          },
          async settingApplyPatch(patch: SettingsPatch) { return { ok: true, value: await settings.applySettingsPatch(patch) }; },
        };
      },
    },
  };
}

test('hosted GitHub egress refuses an installation\'s write past its rate before minting a token; others and reads go on', async (t) => {
  hostAdmits(t, () => true);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => { if (previous !== undefined) process.env[name] = previous; });
  }
  const privateKey = String(generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const spent = JSON.stringify({ writes: Array.from({ length: GITHUB_WRITES_PER_WINDOW }, () => Date.now()), pullRequests: [] });
  const github = { [GITHUB_SETTING_KEYS.appId]: 'h12b-app', [GITHUB_SETTING_KEYS.privateKey]: privateKey };
  const state = await tagState(t, {
    [INSTALLATION_A]: { ...github, [GITHUB_WRITES_KEY]: spent },
    [INSTALLATION_B]: github,
  });
  const minted: string[] = [];
  const forwarded: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (/\/access_tokens$/.test(request.url)) {
      minted.push(request.url);
      return Response.json({ token: 'token-x', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    forwarded.push(`${request.method} ${request.url}`);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const grant = { id: 'repo_1', installationId: 50_001, accountLogin: 'acme', fullName: 'acme/app', enabled: true };
  const env = (installationId: string) => egressEnv({ ...HOSTED, TAG_STATE: state.TAG_STATE }, {
    installationId, turnId: 'turn_a', policy: { grants: [grant], mode: 'app' },
  });
  const push = () => new Request('https://github.com/acme/app.git/git-receive-pack', { method: 'POST', body: 'pack' });
  const limited = await githubSandboxOutbound(push(), env(INSTALLATION_A), { containerId: 'do_a' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '600');
  // The handler judges the request it forwards, headers included.
  const overridden = new Request('https://api.github.com/repos/acme/app/pulls/4', { headers: { 'X-HTTP-Method-Override': 'PATCH' } });
  assert.equal((await githubSandboxOutbound(overridden, env(INSTALLATION_A), { containerId: 'do_a' })).status, 429);
  assert.deepEqual(minted, [], 'no token for a refused write');
  assert.equal((await githubSandboxOutbound(new Request('https://api.github.com/repos/acme/app/pulls'), env(INSTALLATION_A),
    { containerId: 'do_a' })).status, 200, 'reads go on');
  assert.equal((await githubSandboxOutbound(push(), env(INSTALLATION_B), { containerId: 'do_b' })).status, 200,
    'another installation\'s writes go on');
  const countedB = JSON.parse(String(await state.store(INSTALLATION_B).getSetting(GITHUB_WRITES_KEY))) as { writes: number[] };
  assert.equal(countedB.writes.length, 1);
  assert.deepEqual(forwarded, [
    'GET https://api.github.com/repos/acme/app/pulls',
    'POST https://github.com/acme/app.git/git-receive-pack',
  ]);
});
