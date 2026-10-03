import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { prepareInstallationCodingWorker } from '../src/agents/coding-worker-task.ts';
import {
  codingWorkerCloudflareExtension,
  readStagedCodingWorkerBindingFrom,
  stageCodingWorkerBinding,
  writeStagedCodingWorkerBinding,
} from '../src/agents/coding-worker-staging.ts';
import { compileRuntimePlanV2, parseRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { configureInstallationAdmission, resetInstallationAdmissionForTests } from '../src/config/installation-admission.ts';
import {
  installationScopeOf,
  InstallationContextError,
  requireInstallationScope,
  scopeInstallationEnv,
  splitInstallationObjectName,
} from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { ModelCredentialAttribution, ResolvedAssignment } from '../src/config/types.ts';
import { SandboxPolicyState, type SandboxEgressContext, type SandboxPolicyStorage } from '../src/sandbox/cloudflare-policy.ts';
import {
  codingWorkerBindingForPlan,
  codingWorkerInstanceId,
  parseCodingWorkerBinding,
  type CodingWorkerBindingV1,
} from '../src/sandbox/coding-worker-binding.ts';
import {
  githubSandboxOutbound,
  packageRegistrySandboxOutbound,
  SANDBOX_BLOCKED_STATUS,
  type SandboxEgressStub,
} from '../src/sandbox/egress-outbound.ts';
import { CLOUDFLARE_SANDBOX_OPTIONS } from '../src/sandbox/lifecycle.ts';
import {
  resetRecordedWorkspaceObjectsForTests,
  SANDBOX_ID_MAX_CHARS,
  SANDBOX_INSTALLATION_STORAGE_KEY,
  sandboxObjectEnv,
  sandboxObjectName,
  sandboxStub,
  sandboxTurnReaders,
} from '../src/sandbox/sandbox-object.ts';
import { guestSandboxKey } from '../src/sandbox/thread-key.ts';
import { WorkspaceSession, workspaceIdFor, type WorkspaceSandboxStub } from '../src/sandbox/workspace-session.ts';
import { freezeCodingModelForTurn } from '../src/slack/run-turn.ts';
import { eraseInstallationObject } from '../src/state/installation-objects.ts';
import { InstallationObjectInventoryLogic } from '../src/state/object-inventory.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { opaqueId } from '../src/work/admission.ts';
import { FakeObjectStorage, hostedInstallation } from './helpers/installation-objects.ts';

/**
 * H12a: a deployment serving many installations names each coding
 * workspace's Sandbox under its installation, scopes the Sandbox and its
 * egress to that installation, binds each coding worker to the credential
 * its coordinator froze, and inventories both before anything addresses
 * them. Standalone names and behaviour are unchanged.
 */

/** An installation ID as Cloud mints it: `inst_` and 32 hex, 37 characters. */
const INSTALLATION_A = `inst_${'0123456789abcdef'.repeat(2)}`;
const INSTALLATION_B = `inst_${'fedcba9876543210'.repeat(2)}`;
/** A well-formed installation ID that lowercases to installation A's. */
const INSTALLATION_A_UPPERCASE = `inst_${'0123456789ABCDEF'.repeat(2)}`;
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const hostedEnv = (installationId: string, bindings: Record<string, unknown> = {}) =>
  scopeInstallationEnv({ ...HOSTED, ...bindings } as Record<string, unknown>, { installationId });

const THREAD_KEY = 'T0BUML4GZ18:C0C022KBYV6:1788000000.000100';
const NAMED_WORKSPACE = workspaceIdFor(THREAD_KEY, 'backend', 2);
const GUEST_WORKSPACE = guestSandboxKey(THREAD_KEY, 'agent_guest');
const HOSTED_NAME = /^i1~inst_[0-9a-f]{32}~w[a-z2-7]{21}$/;

test('standalone addresses every Sandbox by its workspace ID, exactly as before', () => {
  for (const workspaceId of [THREAD_KEY, NAMED_WORKSPACE, GUEST_WORKSPACE]) {
    assert.equal(sandboxObjectName(undefined, workspaceId), workspaceId);
    assert.equal(sandboxObjectName({}, workspaceId), workspaceId);
    assert.equal(sandboxObjectName({ CHICKPEA_TENANCY: 'standalone' }, workspaceId), workspaceId);
  }
});

test('a hosted Sandbox name carries the installation and fits the SDK\'s 63 characters', () => {
  const envA = hostedEnv(INSTALLATION_A);
  const names = [THREAD_KEY, NAMED_WORKSPACE, GUEST_WORKSPACE].map((id) => sandboxObjectName(envA, id));
  for (const name of names) {
    assert.match(name, HOSTED_NAME);
    assert.equal(name.length, SANDBOX_ID_MAX_CHARS, 'a 37-character installation ID fills the limit exactly');
    assert.equal(splitInstallationObjectName(name).scope?.installationId, INSTALLATION_A);
    // The SDK's own rules (sanitizeSandboxId): lowercase keeps the normalized-ID bridge unused.
    assert.ok(!name.startsWith('-') && !name.endsWith('-') && name === name.toLowerCase());
  }
  assert.equal(new Set(names).size, 3, 'each workspace has its own Sandbox');
  assert.equal(sandboxObjectName(envA, THREAD_KEY), names[0], 'the name is stable');
  assert.notEqual(sandboxObjectName(hostedEnv(INSTALLATION_B), THREAD_KEY), names[0], 'and never shared across installations');
  // Pinned (RFC 4648 base32 of SHA-256, cross-checked outside Node): a changed digest strands every hosted workspace.
  assert.equal(sandboxObjectName(envA, THREAD_KEY), `i1~${INSTALLATION_A}~wme2qmuvogtpyj4f4smxtt`);
});

test('a hosted Sandbox name is refused without an installation or past the SDK limit', () => {
  assert.throws(() => sandboxObjectName(HOSTED, THREAD_KEY),
    (error: unknown) => error instanceof InstallationContextError && error.code === 'installation_context_missing');
  const tooLong = hostedEnv(`${INSTALLATION_A}x`);
  assert.throws(() => sandboxObjectName(tooLong, THREAD_KEY),
    (error: unknown) => error instanceof InstallationContextError && /too long/.test(error.message));
  // The SDK's normalized IDs lowercase a name: an uppercase installation ID could reach installation A's Sandbox.
  assert.equal(INSTALLATION_A_UPPERCASE.toLowerCase(), INSTALLATION_A);
  assert.throws(() => sandboxObjectName(hostedEnv(INSTALLATION_A_UPPERCASE), THREAD_KEY),
    (error: unknown) => error instanceof InstallationContextError && error.code === 'installation_context_invalid'
      && /lowercase/.test(error.message));
});

test('only a standalone thread\'s Sandbox is also read under its normalized name; a broken env is never "no Sandbox"', () => {
  const sandbox = { SANDBOX: {} };
  // Standalone keeps the bridge for an uppercase thread key.
  assert.equal(sandboxTurnReaders(sandbox)(THREAD_KEY).length, 2);
  assert.equal(sandboxTurnReaders(sandbox)(THREAD_KEY.toLowerCase()).length, 1);
  assert.deepEqual(sandboxTurnReaders({})(THREAD_KEY), [], 'no Sandbox binding');
  // An installation's Sandbox is read under its own name only, whatever the thread key's case.
  assert.equal(sandboxTurnReaders(hostedEnv(INSTALLATION_A, sandbox))(THREAD_KEY).length, 1);
  // An installation that cannot name a Sandbox never opened one.
  assert.deepEqual(sandboxTurnReaders(hostedEnv(INSTALLATION_A_UPPERCASE, sandbox))(THREAD_KEY), []);
  assert.deepEqual(sandboxTurnReaders(hostedEnv(`${INSTALLATION_A}x`, sandbox))(THREAD_KEY), []);
  // An unscoped env or a malformed tenancy is a fault, not an absent Sandbox.
  assert.throws(() => sandboxTurnReaders({ ...HOSTED, ...sandbox })(THREAD_KEY),
    (error: unknown) => error instanceof InstallationContextError && error.code === 'installation_context_missing');
  assert.throws(() => sandboxTurnReaders({ CHICKPEA_TENANCY: 'many', ...sandbox })(THREAD_KEY),
    (error: unknown) => error instanceof InstallationContextError && error.code === 'installation_context_invalid');
});

function recordingOpener() {
  const calls: string[] = [];
  return {
    calls,
    open: async (binding: unknown, name: string, options: unknown) => {
      calls.push(`open:${name}`);
      return { binding, name, options };
    },
    record: async (_env: Record<string, unknown>, object: { kind: string; name: string }) => {
      calls.push(`record:${object.kind}:${object.name}`);
    },
  };
}

test('standalone opens a Sandbox by its workspace ID and records nothing', async (t) => {
  resetRecordedWorkspaceObjectsForTests();
  t.after(resetRecordedWorkspaceObjectsForTests);
  const opener = recordingOpener();
  const binding = { namespace: 'SANDBOX' };
  const stub = await sandboxStub<{ name: string; options: unknown }>({ SANDBOX: binding }, THREAD_KEY, undefined, opener);
  assert.deepEqual(opener.calls, [`open:${THREAD_KEY}`]);
  assert.equal(stub.options, CLOUDFLARE_SANDBOX_OPTIONS);
  await assert.rejects(sandboxStub({}, THREAD_KEY, undefined, opener), /No Sandbox binding/);
});

test('a hosted Sandbox is recorded in the inventory before it is first opened, once per isolate', async (t) => {
  resetRecordedWorkspaceObjectsForTests();
  t.after(resetRecordedWorkspaceObjectsForTests);
  const env = hostedEnv(INSTALLATION_A, { SANDBOX: {} });
  const name = sandboxObjectName(env, THREAD_KEY);
  const opener = recordingOpener();
  await sandboxStub(env, THREAD_KEY, undefined, opener);
  await sandboxStub(env, THREAD_KEY, undefined, opener);
  assert.deepEqual(opener.calls, [`record:sandbox:${name}`, `open:${name}`, `open:${name}`]);

  // A Sandbox that could not be recorded is never opened.
  const failing = recordingOpener();
  await assert.rejects(sandboxStub(env, NAMED_WORKSPACE, undefined, {
    open: failing.open,
    record: async () => { throw new Error('state store unavailable'); },
  }), /state store unavailable/);
  assert.deepEqual(failing.calls, []);
});

function sandboxContext(name: string | undefined, kv = new Map<string, unknown>()) {
  return {
    id: name === undefined ? {} : { name },
    storage: { kv: { get: (key: string) => kv.get(key), put: (key: string, value: unknown) => { kv.set(key, value); } } },
    kv,
  };
}

test('a hosted Sandbox serves the installation its name carries, and recovers it on a wake by ID', () => {
  const env = HOSTED as Record<string, unknown>;
  const name = sandboxObjectName(hostedEnv(INSTALLATION_A), THREAD_KEY);
  const kv = new Map<string, unknown>();
  const named = sandboxObjectEnv(sandboxContext(name, kv), env);
  assert.equal(installationScopeOf(named)?.installationId, INSTALLATION_A);
  assert.equal(kv.get(SANDBOX_INSTALLATION_STORAGE_KEY), INSTALLATION_A, 'the first named construction keeps it');

  // Egress handlers wake the object by its ID, which carries no name.
  const woken = sandboxObjectEnv(sandboxContext(undefined, kv), env);
  assert.equal(installationScopeOf(woken)?.installationId, INSTALLATION_A);

  // Neither a name nor a stored installation: the env stays unscoped, so every store fails closed.
  const unknown = sandboxObjectEnv(sandboxContext(undefined), env);
  assert.equal(installationScopeOf(unknown), undefined);
  assert.throws(() => requireInstallationScope(unknown), InstallationContextError);

  // The deployment's container probe serves no installation and keeps nothing.
  const probeKv = new Map<string, unknown>();
  assert.equal(installationScopeOf(sandboxObjectEnv(sandboxContext('chickpea-container-probe', probeKv), env)), undefined);
  assert.equal(probeKv.size, 0);

  // A name and a stored installation that disagree refuse to run.
  assert.throws(() => sandboxObjectEnv(sandboxContext(sandboxObjectName(hostedEnv(INSTALLATION_B), THREAD_KEY), kv), env),
    InstallationContextError);
});

test('a standalone Sandbox keeps the platform env and refuses an installation\'s name', () => {
  const standalone = {};
  const kv = new Map<string, unknown>();
  assert.equal(sandboxObjectEnv(sandboxContext(THREAD_KEY, kv), standalone), standalone);
  assert.equal(sandboxObjectEnv(sandboxContext(undefined, kv), standalone), standalone);
  assert.equal(kv.size, 0, 'standalone stores nothing');
  assert.throws(() => sandboxObjectEnv(sandboxContext(sandboxObjectName(hostedEnv(INSTALLATION_A), THREAD_KEY)), standalone),
    InstallationContextError);
});

/** The host admits every installation (H12b refuses a suspended one's egress). */
function admitted(t: TestContext) {
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => resetInstallationAdmissionForTests());
}

/** A Sandbox namespace whose objects answer egress with `context`, counting their calls. */
function egressEnv(base: Record<string, unknown>, context: SandboxEgressContext) {
  const calls: string[] = [];
  const stub: SandboxEgressStub = {
    async egressContext() { calls.push('egressContext'); return context; },
    async getTurnId() { calls.push('getTurnId'); return context.turnId; },
    async recordPullRequestProgress() { calls.push('recordPullRequestProgress'); return true; },
  };
  const env = {
    ...base,
    SANDBOX: {
      idFromString: (id: string) => ({ id }),
      get: (id: { id: string }) => { calls.push(`get:${id.id}`); return stub; },
    },
  };
  return { env, calls };
}

function withFetch(t: TestContext) {
  const fetched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request) => {
    fetched.push(input.url);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return fetched;
}

const NPM = 'https://registry.npmjs.org/left-pad';
const PYPI = 'https://pypi.org/simple/requests/';
const policy = (packageRegistryHosts?: string[]) => ({
  grants: [], mode: null, ...(packageRegistryHosts ? { packageRegistryHosts } : {}),
});

test('hosted registry egress reads its installation and allowlist from the Sandbox in one call, and nothing else', async (t) => {
  admitted(t);
  const fetched = withFetch(t);
  const { env, calls } = egressEnv(HOSTED, {
    installationId: INSTALLATION_A, turnId: 'turn_a', policy: policy(['registry.npmjs.org']),
  });
  const allowed = await packageRegistrySandboxOutbound(new Request(NPM), env, { containerId: 'do_a' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(calls, ['get:do_a', 'egressContext']);
  const denied = await packageRegistrySandboxOutbound(new Request(PYPI), env, { containerId: 'do_a' });
  assert.equal(denied.status, SANDBOX_BLOCKED_STATUS, 'a registry the turn did not allow');
  assert.deepEqual(fetched, [NPM]);
});

test('hosted egress fails closed when the Sandbox names no installation or has no turn policy', async (t) => {
  const fetched = withFetch(t);
  const unnamed = egressEnv(HOSTED, { turnId: 'turn_a', policy: policy(['registry.npmjs.org']) });
  assert.equal((await packageRegistrySandboxOutbound(new Request(NPM), unnamed.env, { containerId: 'do_x' })).status,
    SANDBOX_BLOCKED_STATUS);
  const github = await githubSandboxOutbound(
    new Request('https://api.github.com/repos/Acme/Alpha/pulls', { method: 'POST' }), unnamed.env, { containerId: 'do_x' },
  );
  assert.equal(github.status, SANDBOX_BLOCKED_STATUS);
  assert.deepEqual(unnamed.calls.filter((call) => call === 'getTurnId'), [], 'nothing past the scope is read');
  // Between turns a hosted Sandbox has no snapshot, and reaches no registry.
  const idle = egressEnv(HOSTED, { installationId: INSTALLATION_A, policy: policy() });
  assert.equal((await packageRegistrySandboxOutbound(new Request(NPM), idle.env, { containerId: 'do_a' })).status,
    SANDBOX_BLOCKED_STATUS);
  assert.deepEqual(fetched, []);
});

/** Run on the Cloudflare target, where every store is its installation's state store. */
function onCloudflare(t: TestContext) {
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
}

test('hosted GitHub egress reads only its own installation\'s GitHub connection', async (t) => {
  admitted(t);
  onCloudflare(t);
  const privateKey = String(generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({
    type: 'pkcs8', format: 'pem',
  }));
  const appIds: Record<string, string> = { [INSTALLATION_A]: 'h12a-app-a', [INSTALLATION_B]: 'h12a-app-b' };
  // Both installations' state stores, each holding its own GitHub App connection.
  const read: string[] = [];
  const TAG_STATE = {
    getByName(name: string) {
      const installationId = splitInstallationObjectName(name).scope?.installationId ?? name;
      return {
        async settingGetMany(keys: readonly string[]) {
          read.push(installationId);
          return {
            ok: true,
            value: keys.map((key) => key === GITHUB_SETTING_KEYS.appId
              ? appIds[installationId] ?? null
              : key === GITHUB_SETTING_KEYS.privateKey ? privateKey : null),
          };
        },
      };
    },
  };
  const forwarded: Array<{ url: string; authorization: string | null }> = [];
  const minted: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (/\/app\/installations\/\d+\/access_tokens$/.test(request.url)) {
      minted.push(request.url);
      return Response.json({ token: 'token-a', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    forwarded.push({ url: request.url, authorization: request.headers.get('Authorization') });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const grant = { id: 'repo_1', installationId: 50_001, accountLogin: 'Acme', fullName: 'Acme/Alpha', enabled: true };
  const { env, calls } = egressEnv({ ...HOSTED, TAG_STATE }, {
    installationId: INSTALLATION_A, turnId: 'turn_a', policy: { grants: [grant], mode: 'app' },
  });
  const url = 'https://api.github.com/repos/Acme/Alpha/contents/README.md';
  const response = await githubSandboxOutbound(new Request(url), env, { containerId: 'do_a' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['get:do_a', 'egressContext', 'getTurnId']);
  assert.deepEqual(read, [INSTALLATION_A], 'installation A\'s connection, and never B\'s');
  assert.deepEqual(minted, ['https://api.github.com/app/installations/50001/access_tokens']);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]!.url, url);
  assert.match(forwarded[0]!.authorization ?? '', /token-a/);
});

test('standalone registry egress keeps its setting outside a configured turn and refuses a Sandbox naming an installation', async (t) => {
  const fetched = withFetch(t);
  const configured = egressEnv({}, { turnId: 'turn_s', policy: policy([]) });
  assert.equal((await packageRegistrySandboxOutbound(new Request(NPM), configured.env, { containerId: 'do_s' })).status,
    SANDBOX_BLOCKED_STATUS, 'a turn that allowed no registry');
  // An unset setting allows the curated registries, as before.
  const idle = egressEnv({}, { policy: policy() });
  assert.equal((await packageRegistrySandboxOutbound(new Request(NPM), idle.env, { containerId: 'do_s' })).status, 200);
  const foreign = egressEnv({}, { installationId: INSTALLATION_A, turnId: 'turn_s', policy: policy(['registry.npmjs.org']) });
  assert.equal((await packageRegistrySandboxOutbound(new Request(NPM), foreign.env, { containerId: 'do_s' })).status,
    SANDBOX_BLOCKED_STATUS);
  assert.deepEqual(fetched, [NPM]);
});

class MemoryPolicyStorage implements SandboxPolicyStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
}

test('a turn snapshots its curated registries into its egress policy; revoking clears them', async () => {
  const state = new SandboxPolicyState(new MemoryPolicyStorage());
  await state.configureEgress({
    mode: 'app', grants: [], packageRegistryHosts: ['registry.npmjs.org', 'evil.example', 'registry.npmjs.org'],
  }, 'turn_a');
  assert.deepEqual(await state.egressContext(), {
    turnId: 'turn_a', policy: { grants: [], mode: 'app', packageRegistryHosts: ['registry.npmjs.org'] },
  });
  await state.revokeEgress();
  assert.deepEqual(await state.egressContext(), { turnId: 'turn_a', policy: { grants: [], mode: null } });
});

test('opening a workspace snapshots the registries its turn\'s settings allow into the egress policy', async () => {
  const configured: unknown[] = [];
  const session = (packageRegistryHosts?: string[]) => new WorkspaceSession({
    id: THREAD_KEY, name: 'main', agentId: 'agent_coder', turnId: 'turn_a', credentialMode: 'app',
    grants: [{ id: 'repo_1', installationId: 7, accountLogin: 'acme', fullName: 'acme/app', enabled: true }],
    ...(packageRegistryHosts ? { packageRegistryHosts } : {}),
    mintStub: async () => ({
      async prepareTurn() {},
      async beginWorkspaceTurn() { return { state: 'fresh', reservationId: 'turn_a', restorable: false }; },
      async configureEgress(input: unknown) { configured.push(input); },
    }) as unknown as WorkspaceSandboxStub,
    reserveSession: async () => true,
    toSandbox: async () => { throw new Error('unused'); },
  });
  await session(['pypi.org']).open();
  await session().open();
  assert.deepEqual(configured, [
    { grants: [{ id: 'repo_1', installationId: 7, accountLogin: 'acme', fullName: 'acme/app', enabled: true }], mode: 'app', packageRegistryHosts: ['pypi.org'] },
    { grants: [{ id: 'repo_1', installationId: 7, accountLogin: 'acme', fullName: 'acme/app', enabled: true }], mode: 'app' },
  ]);
});

test('an installation inventories its coding workspace objects by their own names only', () => {
  const installation = hostedInstallation(INSTALLATION_A);
  const inventory = installation.stores.objectInventory;
  const sandbox = sandboxObjectName(installation.env, THREAD_KEY);
  const worker = `i1~${INSTALLATION_A}~${opaqueId('codingworker', 'binding')}`;
  inventory.recordWorkspaceObject({ kind: 'sandbox', name: sandbox });
  inventory.recordWorkspaceObject({ kind: 'coding_worker', name: worker });
  inventory.recordWorkspaceObject({ kind: 'sandbox', name: sandbox });
  assert.deepEqual(inventory.counts(), { coding_worker: 1, routine_agent: 0, sandbox: 1, slack_agent: 0, thread_runner: 0 });
  assert.deepEqual(inventory.list().objects.map(({ kind, name }) => `${kind}:${name}`), [
    `coding_worker:${worker}`, `sandbox:${sandbox}`,
  ]);
  for (const object of [
    { kind: 'sandbox', name: sandboxObjectName(hostedEnv(INSTALLATION_B), THREAD_KEY) },
    { kind: 'sandbox', name: THREAD_KEY },
    { kind: 'sandbox', name: `i1~${INSTALLATION_A}~${THREAD_KEY}` },
    { kind: 'coding_worker', name: `i1~${INSTALLATION_A}~agent_x` },
    { kind: 'slack_agent', name: `i1~${INSTALLATION_A}~agent_x` },
  ] as const) {
    assert.throws(() => inventory.recordWorkspaceObject(object as never), `${object.kind} ${object.name} is refused`);
  }
  assert.equal(inventory.counts().sandbox, 1);
});

test('standalone records no coding workspace object', () => {
  const db = openStateDb(':memory:');
  try {
    const inventory = new InstallationObjectInventoryLogic(db, {});
    inventory.recordWorkspaceObject({ kind: 'sandbox', name: THREAD_KEY });
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'installation_object_inventory'"), undefined);
  } finally {
    db.close();
  }
});

test('an inventory from before coding workspace objects is widened in place, its names kept', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec(`CREATE TABLE installation_object_inventory (
      kind TEXT NOT NULL CHECK (kind IN ('routine_agent', 'slack_agent', 'thread_runner')),
      name TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (kind, name)
    )`);
    const earlier = `i1~${INSTALLATION_A}~agent_earlier`;
    db.run('INSERT INTO installation_object_inventory (kind, name, first_seen_at) VALUES (?, ?, ?)', 'slack_agent', earlier, 7);
    const env = hostedEnv(INSTALLATION_A);
    const inventory = new InstallationObjectInventoryLogic(db, env);
    inventory.recordWorkspaceObject({ kind: 'sandbox', name: sandboxObjectName(env, THREAD_KEY) });
    assert.deepEqual(inventory.list().objects.find(({ name }) => name === earlier), { kind: 'slack_agent', name: earlier, firstSeenAt: 7 });
    assert.equal(inventory.counts().sandbox, 1);
    assert.match(String(db.get("SELECT sql FROM sqlite_master WHERE name = 'installation_object_inventory'")?.sql), /'coding_worker'/);
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'installation_object_inventory_next'"), undefined);
  } finally {
    db.close();
  }
});

test('host functions reach a coding worker through its own binding; a Sandbox has none yet', async () => {
  const addressed: string[] = [];
  const workerBinding = {
    idFromName: (name: string) => name,
    get: (name: string) => ({ chickpeaHostErase: async () => { addressed.push(name); return { erased: true }; } }),
  };
  const env = hostedEnv(INSTALLATION_A, { FLUE_CHICKPEA_CODING_WORKER_V1_AGENT: workerBinding });
  const worker = `i1~${INSTALLATION_A}~${opaqueId('codingworker', 'binding')}`;
  await eraseInstallationObject(env, { kind: 'coding_worker', name: worker }, { confirmInstallationId: INSTALLATION_A });
  assert.deepEqual(addressed, [worker]);
  await assert.rejects(
    eraseInstallationObject(env, { kind: 'sandbox', name: sandboxObjectName(env, THREAD_KEY) }, { confirmInstallationId: INSTALLATION_A }),
    /no host functions yet/,
  );
});

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T1', channelId: 'C1', agentId: 'agent_coder', runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_coder', kind: 'user', revision: 1, name: 'Coder', instructions: 'Code.', enabled: true,
      model: 'anthropic/claude-haiku-4-5', skills: [], mcpServers: [], apiConnections: [],
      repositories: [{ id: 'repo_1', installationId: 7, accountLogin: 'acme', fullName: 'acme/app', enabled: true }],
    },
    model: 'anthropic/claude-haiku-4-5',
    modelAttribution: { source: 'pinned', providerId: 'anthropic' },
    modelCredential: {
      credentialRefId: 'cred_anthropic_stored', version: 3, providerId: 'anthropic',
      sourceKind: 'stored', label: 'Stored', scopeLabel: null, unknownRotation: false,
    },
  };
}

const CODING_CREDENTIAL = { credentialRefId: 'cred_openai_stored', version: 5, providerId: 'openai' };

function plan(options: { installationId?: string; codingCredential?: boolean } = {}): RuntimePlanV2 {
  return compileRuntimePlanV2({
    ...(options.installationId ? { installation: { version: 1, installationId: options.installationId } } : {}),
    turn: {
      workspaceId: 'T1', channelId: 'C1', eventId: 'E1', text: 'Fix it', userId: 'U1',
      messageTs: '1788000000.000200', threadTs: '1788000000.000100', source: 'app_mention', contextMode: 'thread',
    },
    assignment: assignment(),
    instructions: 'Code.',
    memoryEpoch: 1,
    codingWorkspace: true,
    codingModel: {
      model: 'openai/gpt-5.6-sol',
      runtimeModel: 'openai/gpt-5.6-sol',
      attribution: { role: 'coding', source: 'workspace_default', providerId: 'openai', fallback: false },
      ...(options.codingCredential ? { modelCredential: CODING_CREDENTIAL } : {}),
    },
  });
}

/** The instance ID standalone workers had before version 2 existed. */
function legacyInstanceId(binding: CodingWorkerBindingV1): string {
  const repositories = binding.repositories
    .map(({ id, fullName, allRepos, accountLogin }) => [id, fullName, allRepos === true, accountLogin ?? ''])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return opaqueId('codingworker', JSON.stringify([
    1, binding.workspaceId, binding.agentId, binding.codingModel.model, binding.codingModel.runtimeModel, null, repositories,
  ]));
}

test('a standalone coding worker keeps its version 1 binding and instance ID', () => {
  const binding = codingWorkerBindingForPlan(plan(), THREAD_KEY);
  assert.equal(binding.schemaVersion, 1);
  assert.deepEqual(Object.keys(binding).sort(), ['agentId', 'codingModel', 'repositories', 'schemaVersion', 'workspaceId']);
  assert.equal(codingWorkerInstanceId(binding), legacyInstanceId(binding as CodingWorkerBindingV1));
  assert.throws(() => parseCodingWorkerBinding({ ...binding, installation: { version: 1, installationId: INSTALLATION_A } }),
    /unknown field: installation/);
});

test('an installation\'s coding worker binding names it and the coding model\'s frozen credential', () => {
  const hostedPlan = plan({ installationId: INSTALLATION_A, codingCredential: true });
  assert.deepEqual(parseRuntimePlanV2(JSON.parse(JSON.stringify(hostedPlan))).codingWorkspace?.codingModel?.modelCredential,
    CODING_CREDENTIAL, 'the plan carries the frozen coding credential');
  const binding = codingWorkerBindingForPlan(hostedPlan, THREAD_KEY);
  assert.deepEqual(binding, {
    schemaVersion: 2,
    workspaceId: THREAD_KEY,
    agentId: 'agent_coder',
    codingModel: { model: 'openai/gpt-5.6-sol', runtimeModel: 'openai/gpt-5.6-sol' },
    repositories: hostedPlan.repositories,
    installation: { version: 1, installationId: INSTALLATION_A },
    modelCredential: CODING_CREDENTIAL,
  });
  assert.deepEqual(parseCodingWorkerBinding(JSON.parse(JSON.stringify(binding))), binding);
  const instanceId = codingWorkerInstanceId(binding);
  assert.match(instanceId, new RegExp(`^i1~${INSTALLATION_A}~codingworker_[a-f0-9]{40}$`));
  // Another credential version, or another installation, is another worker.
  assert.equal(binding.schemaVersion, 2);
  if (binding.schemaVersion !== 2) return;
  assert.notEqual(codingWorkerInstanceId({ ...binding, modelCredential: { ...CODING_CREDENTIAL, version: 6 } }), instanceId);
  assert.notEqual(
    codingWorkerInstanceId(codingWorkerBindingForPlan(plan({ installationId: INSTALLATION_B, codingCredential: true }), THREAD_KEY)),
    instanceId.replace(INSTALLATION_A, INSTALLATION_B),
  );
  const { installation: _installation, ...withoutInstallation } = binding;
  assert.throws(() => parseCodingWorkerBinding(withoutInstallation), InstallationContextError);
  // A plan that froze no coding model runs the worker on the Agent's model and credential.
  const agentModelPlan = { ...hostedPlan, codingWorkspace: { available: true as const } };
  const fallback = codingWorkerBindingForPlan(agentModelPlan, THREAD_KEY);
  assert.deepEqual(fallback.schemaVersion === 2 && fallback.modelCredential, {
    credentialRefId: 'cred_anthropic_stored', version: 3, providerId: 'anthropic',
  });
});

test('the coordinator stages the binding beside its worker; only the binding of that instance is read back', async () => {
  const binding = codingWorkerBindingForPlan(plan({ installationId: INSTALLATION_A, codingCredential: true }), THREAD_KEY);
  const instanceId = codingWorkerInstanceId(binding);
  const storage = new FakeObjectStorage();
  writeStagedCodingWorkerBinding(storage.sql, JSON.stringify(binding), 1);
  writeStagedCodingWorkerBinding(storage.sql, JSON.stringify(binding), 2);
  assert.deepEqual(readStagedCodingWorkerBindingFrom(storage.sql, instanceId), binding);
  assert.equal(readStagedCodingWorkerBindingFrom(storage.sql, `${instanceId}0`), undefined);
  // A tampered row is caught by the instance ID it no longer hashes to.
  storage.sql.exec('UPDATE chickpea_coding_worker_binding SET binding_json = ?',
    JSON.stringify({ ...binding, agentId: 'agent_other' }));
  assert.throws(() => readStagedCodingWorkerBindingFrom(storage.sql, instanceId), /another instance/);

  // The worker object refuses a binding addressed to another instance.
  class FakeAgentBase {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  }
  const Worker = codingWorkerCloudflareExtension.base(FakeAgentBase) as unknown as new (
    ctx: { id: { name?: string }; storage: { sql: FakeObjectStorage['sql'] } }, env: unknown,
  ) => { chickpeaStageCodingWorkerBinding(json: string): void };
  const own = new Worker({ id: { name: instanceId }, storage: { sql: new FakeObjectStorage().sql } }, HOSTED);
  own.chickpeaStageCodingWorkerBinding(JSON.stringify(binding));
  const other = new Worker({ id: { name: `i1~${INSTALLATION_A}~codingworker_${'0'.repeat(40)}` }, storage: { sql: new FakeObjectStorage().sql } }, HOSTED);
  assert.throws(() => other.chickpeaStageCodingWorkerBinding(JSON.stringify(binding)), /another instance/);

  // Host side: refuses a binding for another instance before addressing anything.
  const addressed: string[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({ async chickpeaStageCodingWorkerBinding() { addressed.push(name); } }),
  };
  await stageCodingWorkerBinding({ WORKERS: namespace }, 'WORKERS', instanceId, binding);
  await assert.rejects(stageCodingWorkerBinding({ WORKERS: namespace }, 'WORKERS', `${instanceId}0`, binding), /another instance/);
  assert.deepEqual(addressed, [instanceId]);
});

test('an installation\'s coding worker is inventoried before its binding is staged; a standalone worker needs neither', async () => {
  const calls: string[] = [];
  const env = hostedEnv(INSTALLATION_A);
  const dependencies = {
    env: async () => { calls.push('env'); return env; },
    record: async (_env: Record<string, unknown> | undefined, object: { kind: string; name: string }) => {
      calls.push(`record:${object.kind}:${object.name}`);
    },
    stage: async (_env: Record<string, unknown> | undefined, bindingName: string, instanceId: string) => {
      calls.push(`stage:${bindingName}:${instanceId}`);
    },
  };
  await prepareInstallationCodingWorker('codingworker_x', codingWorkerBindingForPlan(plan(), THREAD_KEY), dependencies as never);
  assert.deepEqual(calls, [], 'standalone records and stages nothing');

  const binding = codingWorkerBindingForPlan(plan({ installationId: INSTALLATION_A, codingCredential: true }), THREAD_KEY);
  const instanceId = codingWorkerInstanceId(binding);
  await prepareInstallationCodingWorker(instanceId, binding, dependencies as never);
  assert.deepEqual(calls, [
    'env',
    `record:coding_worker:${instanceId}`,
    `stage:FLUE_CHICKPEA_CODING_WORKER_V1_AGENT:${instanceId}`,
  ]);

  calls.length = 0;
  await assert.rejects(prepareInstallationCodingWorker(instanceId, binding, {
    ...dependencies,
    record: async () => { throw new Error('state store unavailable'); },
  } as never), /state store unavailable/);
  assert.deepEqual(calls, ['env'], 'a worker that could not be recorded is never staged');
});

async function freeze(env: PlatformEnv | undefined, options: {
  codingModel?: string;
  resolveCredential?: (model: string) => Pick<ModelCredentialAttribution, 'credentialRefId' | 'version' | 'providerId'> | null;
} = {}) {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    return await freezeCodingModelForTurn({
      workspaceId: 'T1',
      agent: { id: 'agent_coder', kind: 'user' },
      reader: {
        getWorkspaceModelRole: async (workspaceId, role) => role === 'coding' && options.codingModel
          ? { workspaceId, role, modelId: options.codingModel, revision: 1, createdAt: 1, updatedAt: 1 }
          : undefined,
        getAgentModelRole: async () => undefined,
      },
      agentRoute: { model: 'anthropic/claude-haiku-4-5', runtimeModel: 'anthropic/claude-haiku-4-5' },
      settings,
      ...(env ? { env } : {}),
      resolveModel: async (_agentId, model) => ({ model }) as never,
      agentCredential: { credentialRefId: 'cred_anthropic_stored', version: 3, providerId: 'anthropic' },
      resolveCredential: async (model) => (options.resolveCredential?.(model) ?? null) as never,
    });
  } finally {
    settings.close();
  }
}

test('an installation freezes the coding model\'s credential, or falls back to the Agent\'s model and credential', async () => {
  const env = hostedEnv(INSTALLATION_A) as PlatformEnv;
  const own = await freeze(env, { codingModel: 'openai/gpt-5.6-sol', resolveCredential: () => CODING_CREDENTIAL });
  assert.equal(own.model, 'openai/gpt-5.6-sol');
  assert.deepEqual(own.modelCredential, CODING_CREDENTIAL);
  assert.equal(own.attribution.fallback, false);

  // No key for the coding role's provider: the Agent's model, said to be a fallback.
  const fallback = await freeze(env, { codingModel: 'openai/gpt-5.6-sol' });
  assert.deepEqual(fallback, {
    model: 'anthropic/claude-haiku-4-5',
    runtimeModel: 'anthropic/claude-haiku-4-5',
    attribution: { role: 'coding', source: 'agent_model', providerId: 'anthropic', fallback: true },
    modelCredential: { credentialRefId: 'cred_anthropic_stored', version: 3, providerId: 'anthropic' },
  });
  const unset = await freeze(env);
  assert.deepEqual(unset.modelCredential, { credentialRefId: 'cred_anthropic_stored', version: 3, providerId: 'anthropic' });

  // Standalone freezes no coding credential: its worker reads the installation's keys.
  const standalone = await freeze(undefined, { codingModel: 'openai/gpt-5.6-sol', resolveCredential: () => CODING_CREDENTIAL });
  assert.equal(standalone.model, 'openai/gpt-5.6-sol');
  assert.equal('modelCredential' in standalone, false);
});

test('an installation whose credential store cannot be read fails the turn instead of switching the coding model', async () => {
  const env = hostedEnv(INSTALLATION_A) as PlatformEnv;
  await assert.rejects(freeze(env, {
    codingModel: 'openai/gpt-5.6-sol',
    resolveCredential: () => { throw new Error('credential store unavailable'); },
  }), /credential store unavailable/);
});
