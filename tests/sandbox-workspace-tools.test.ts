import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FlueExecutionOperation, Sandbox } from '@flue/runtime';

import { runtimePlanWorkspaceResolver, runtimePlanWorkspaceToolsMounted } from '../src/agents/slack-thread.ts';
import { createWorkspaceArtifactTool } from '../src/sandbox/artifact-tool.ts';
import { SandboxUnavailableError } from '../src/sandbox/errors.ts';
import { sandboxThreadKey } from '../src/sandbox/thread-key.ts';
import {
  currentWorkspaceRegistry,
  runWithWorkspaceRegistry,
  workspaceRegistryInterceptor,
} from '../src/sandbox/workspace-registry.ts';
import {
  WorkspaceSession,
  defaultWorkspaceId,
  workspaceIdFor,
  workspaceReservationId,
  type WorkspaceSandboxStub,
} from '../src/sandbox/workspace-session.ts';
import {
  DEFAULT_WORKSPACE_NAME,
  EMPTY_WORKSPACE_ROSTER,
  MAX_OPEN_WORKSPACES,
  WorkspaceLimitError,
  admitWorkspace,
  closeWorkspace,
  createWorkspaceRoster,
  defaultOnlyWorkspaceRoster,
  normalizeWorkspaceName,
  openWorkspaceNames,
  parseRoster,
  type WorkspaceRosterState,
} from '../src/sandbox/workspace-limits.ts';
import { workspaceRegistryKey } from '../src/sandbox/workspace-registry.ts';
import { WORKSPACE_CHECKPOINT_TTL_SECONDS } from '../src/sandbox/workspace-lifecycle.ts';
import {
  codingWorkerBindingForPlan,
  codingWorkerInstanceId,
} from '../src/sandbox/coding-worker-binding.ts';
import {
  MAX_WORKSPACE_EXEC_OUTPUT_BYTES,
  WORKSPACE_TOOL_NAMES,
  createWorkspaceTools,
  workspaceDirectoryPath,
  workspaceFilePath,
} from '../src/sandbox/workspace-tools.ts';

const RUN = {
  toolCallId: 'workspace-test-call',
  log: { info() {}, warn() {}, error() {} },
} as const;

const GRANT = {
  id: 'grant-1',
  installationId: 42,
  accountLogin: 'acme',
  fullName: 'acme/app',
  enabled: true,
};

interface StubLog {
  calls: string[];
}

function fakeStub(
  log: StubLog,
  options: {
    restorable?: boolean;
    state?: 'warm' | 'fresh' | 'retired';
    turnId?: string;
    gitIdentityFails?: boolean;
  } = {},
): WorkspaceSandboxStub {
  return {
    async getTurnId() {
      log.calls.push('getTurnId');
      return options.turnId ?? 'turn-1';
    },
    async prepareTurn() {
      log.calls.push('prepareTurn');
    },
    async endTurn() {
      log.calls.push('endTurn');
    },
    async beginWorkspaceTurn() {
      log.calls.push('beginWorkspaceTurn');
      return {
        state: options.state ?? 'fresh',
        reservationId: 'turn-1',
        restorable: options.restorable ?? false,
      };
    },
    async configureEgress() {
      log.calls.push('configureEgress');
    },
    async restoreWorkspace() {
      log.calls.push('restoreWorkspace');
      return 'restored';
    },
    async exists() {
      log.calls.push('exists');
      return true;
    },
    async describeWorkspace() {
      log.calls.push('describeWorkspace');
      return { running: false, hasCheckpoint: true };
    },
    async discardWorkspace() {
      log.calls.push('discardWorkspace');
    },
    async destroy() {
      log.calls.push('destroy');
    },
    async applyGitIdentity() {
      log.calls.push('applyGitIdentity');
      if (options.gitIdentityFails) throw new Error('git config failed');
    },
  };
}

function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    cwd: '/workspace',
    resolvePath: (path: string) => path,
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async readFile() {
      return '';
    },
    async readFileBuffer() {
      return new Uint8Array([104, 105]);
    },
    async writeFile() {},
    async stat() {
      return { isFile: true, isDirectory: false, size: 2 };
    },
    async readdir() {
      return [];
    },
    async exists() {
      return true;
    },
    async mkdir() {},
    async rm() {},
    ...overrides,
  } as Sandbox;
}

function session(
  log: StubLog,
  options: {
    stub?: Parameters<typeof fakeStub>[1];
    reserve?: boolean;
    sandbox?: Sandbox;
  } = {},
) {
  return new WorkspaceSession({
    id: 'sandbox_' + 'a'.repeat(40),
    name: DEFAULT_WORKSPACE_NAME,
    agentId: 'agent-1',
    grants: [GRANT],
    credentialMode: 'app',
    mintStub: async () => fakeStub(log, options.stub),
    reserveSession: async () => {
      log.calls.push('reserveSession');
      return options.reserve ?? true;
    },
    // Model the Flue adapter: every file/exec operation goes through the
    // activatable stub's `exists` probe first.
    toSandbox: async (stub) => {
      const inner = options.sandbox ?? fakeSandbox();
      return fakeSandbox({
        async exec(command, execOptions) {
          await stub.exists('/workspace');
          return inner.exec(command, execOptions);
        },
        async writeFile(path, content) {
          await stub.exists('/workspace');
          return inner.writeFile(path, content);
        },
        async exists(path) {
          await stub.exists('/workspace');
          return inner.exists(path);
        },
        stat: inner.stat.bind(inner),
        readFileBuffer: inner.readFileBuffer.bind(inner),
        rm: inner.rm.bind(inner),
      });
    },
  });
}

function toolsFor(target: WorkspaceSession | undefined) {
  const roster = defaultOnlyWorkspaceRoster();
  const tools = createWorkspaceTools({
    // As production: a use admits the name first.
    resolve: (name, access = 'use') => {
      if (access === 'use') roster.admit(name);
      return name === DEFAULT_WORKSPACE_NAME ? target : undefined;
    },
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

async function run(tool: { run: (context: never) => unknown }, data: unknown, extra: object = {}) {
  const result = (await tool.run({ ...RUN, data, ...extra } as never)) as { output: Record<string, unknown> };
  return result.output;
}

test('the default workspace id is the legacy per-thread Sandbox key', () => {
  const ownerBound = 'sandbox_' + 'b'.repeat(40);
  assert.equal(defaultWorkspaceId(ownerBound), ownerBound);
  const slackKey = 'slack:T1:C1:1783000000.000100';
  assert.equal(defaultWorkspaceId(slackKey), sandboxThreadKey(slackKey));
});

test('opening a workspace prepares Durable Object state without starting the container', async () => {
  const log: StubLog = { calls: [] };
  const target = session(log, { stub: { restorable: true } });
  const output = await run(toolsFor(target).workspace_open!, {});
  assert.deepEqual(output, { ok: true, workspace: 'main', state: 'restored' });
  assert.deepEqual(log.calls, ['getTurnId', 'beginWorkspaceTurn', 'configureEgress']);
  assert.equal(log.calls.includes('exists'), false, 'open must not probe the container');

  // Listing reads DO records only.
  log.calls.length = 0;
  const listed = await run(toolsFor(target).workspace_list!, {});
  assert.deepEqual(listed, {
    ok: true,
    maxOpen: 2,
    workspaces: [{ workspace: 'main', open: true, state: 'checkpointed', hasCheckpoint: true, taskRunning: false }],
  });
  assert.deepEqual(log.calls, ['describeWorkspace']);
});

test('the first operation reserves the session and restores the checkpoint once, shared by every consumer', async () => {
  const log: StubLog = { calls: [] };
  const target = session(log, { stub: { restorable: true } });
  const attached = await target.activatable();
  const tools = toolsFor(target);
  await run(tools.workspace_exec!, { command: 'true' });
  await attached.exists('/workspace');
  await run(tools.workspace_exec!, { command: 'true' });
  assert.equal(log.calls.filter((call) => call === 'beginWorkspaceTurn').length, 1);
  assert.equal(log.calls.filter((call) => call === 'reserveSession').length, 1);
  assert.equal(log.calls.filter((call) => call === 'restoreWorkspace').length, 1);
});

test('activation presets the Git identity after the checkpoint restore, before the first operation', async () => {
  const log: StubLog = { calls: [] };
  const target = session(log, { stub: { restorable: true } });
  await run(toolsFor(target).workspace_exec!, { command: 'git commit -m x' });
  const start = log.calls.indexOf('reserveSession');
  assert.deepEqual(log.calls.slice(start, start + 4), [
    'reserveSession',
    'restoreWorkspace',
    'applyGitIdentity',
    'exists',
  ]);
});

test('a failed Git identity preset leaves the workspace usable', async () => {
  const log: StubLog = { calls: [] };
  const target = session(log, { stub: { gitIdentityFails: true } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const output = await run(toolsFor(target).workspace_exec!, { command: 'true' });
    assert.equal(output.ok, true);
  } finally {
    console.warn = warn;
  }
  assert.equal(log.calls.includes('applyGitIdentity'), true);
});

test('a refused session cap and an unavailable container become typed results, not turn failures', async () => {
  const capped = await run(toolsFor(session({ calls: [] }, { reserve: false })).workspace_exec!, {
    command: 'ls',
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'session_cap');

  const broken = session({ calls: [] }, {
    sandbox: fakeSandbox({
      async exec() {
        throw new SandboxUnavailableError(new Error('container was unavailable'));
      },
    }),
  });
  const unavailable = await run(toolsFor(broken).workspace_exec!, { command: 'ls' });
  assert.equal(unavailable.reason, 'workspace_unavailable');

  const missing = await run(toolsFor(undefined).workspace_exec!, { command: 'ls' });
  assert.equal(missing.reason, 'workspace_unavailable');

  // Without a roster only the default workspace exists.
  const other = await run(toolsFor(session({ calls: [] })).workspace_exec!, {
    workspace: 'second',
    command: 'ls',
  });
  assert.equal(other.reason, 'workspace_limit');
  const invalid = await run(toolsFor(session({ calls: [] })).workspace_exec!, {
    workspace: 'not/a name',
    command: 'ls',
  });
  assert.equal(invalid.reason, 'invalid_input');
});

test('unexpected faults still throw so the model sees an error result', async () => {
  const target = session({ calls: [] }, {
    sandbox: fakeSandbox({
      async exec() {
        throw new Error('unexpected');
      },
    }),
  });
  await assert.rejects(run(toolsFor(target).workspace_exec!, { command: 'ls' }), /unexpected/);
});

test('workspace paths reuse the artifact normalization and stay under /workspace', async () => {
  assert.equal(workspaceFilePath('src/app.ts'), '/workspace/src/app.ts');
  assert.equal(workspaceFilePath('/workspace/a/b.txt'), '/workspace/a/b.txt');
  assert.equal(workspaceDirectoryPath('/workspace/'), '/workspace');
  assert.throws(() => workspaceFilePath('/etc/passwd'), /under \/workspace/);
  assert.throws(() => workspaceFilePath('/workspace/../etc'), /normalized/);

  const tools = toolsFor(session({ calls: [] }));
  const escaped = await run(tools.workspace_read!, { path: '/workspace/a/../../etc/shadow' }, {
    harness: { sandbox: fakeSandbox() },
  });
  assert.equal(escaped.reason, 'invalid_path');
  const badCwd = await run(tools.workspace_exec!, { command: 'ls', cwd: '/tmp' });
  assert.equal(badCwd.reason, 'invalid_path');
});

test('exec keeps the tail of long output and reports truncation', async () => {
  const long = 'x'.repeat(MAX_WORKSPACE_EXEC_OUTPUT_BYTES) + 'END';
  const seen: Array<{ command: string; cwd?: string; timeoutMs?: number }> = [];
  const target = session({ calls: [] }, {
    sandbox: fakeSandbox({
      async exec(command, options) {
        seen.push({ command, ...(options?.cwd ? { cwd: options.cwd } : {}), ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
        return { stdout: long, stderr: 'warn', exitCode: 3 };
      },
    }),
  });
  const output = await run(toolsFor(target).workspace_exec!, { command: 'npm test', cwd: 'repo' });
  assert.equal(output.exitCode, 3);
  assert.equal(output.truncated, true);
  assert.equal(output.stderr, 'warn');
  assert.ok(String(output.stdout).endsWith('END'));
  assert.equal(new TextEncoder().encode(String(output.stdout)).byteLength, MAX_WORKSPACE_EXEC_OUTPUT_BYTES);
  assert.deepEqual(seen, [{ command: 'npm test', cwd: '/workspace/repo', timeoutMs: 120_000 }]);
});

test('write takes exactly one source and copies coordinator files byte for byte', async () => {
  const written: Array<[string, string | Uint8Array]> = [];
  const target = session({ calls: [] }, {
    sandbox: fakeSandbox({
      async writeFile(path, content) {
        written.push([path, content]);
      },
    }),
  });
  const tools = toolsFor(target);
  const coordinator = fakeSandbox({
    async readFileBuffer() {
      return new Uint8Array([1, 2, 3]);
    },
    async stat() {
      return { isFile: true, isDirectory: false, size: 3 };
    },
  });
  const neither = await run(tools.workspace_write!, { path: 'a.txt' }, { harness: { sandbox: coordinator } });
  assert.equal(neither.reason, 'invalid_input');
  const both = await run(tools.workspace_write!, { path: 'a.txt', content: 'x', from: '/a' }, {
    harness: { sandbox: coordinator },
  });
  assert.equal(both.reason, 'invalid_input');

  assert.deepEqual(
    await run(tools.workspace_write!, { path: 'run.sh', content: 'echo hi\n' }, { harness: { sandbox: coordinator } }),
    { ok: true, path: '/workspace/run.sh', byteLength: 8 },
  );
  assert.deepEqual(
    await run(tools.workspace_write!, { path: 'data.bin', from: '/home/user/data.bin' }, {
      harness: { sandbox: coordinator },
    }),
    { ok: true, path: '/workspace/data.bin', byteLength: 3 },
  );
  assert.deepEqual(written.map(([path]) => path), ['/workspace/run.sh', '/workspace/data.bin']);
  assert.deepEqual(written[1]?.[1], new Uint8Array([1, 2, 3]));
});

test('read returns bounded text, or copies into the coordinator sandbox with to', async () => {
  const copied: Array<[string, string | Uint8Array]> = [];
  const target = session({ calls: [] });
  const tools = toolsFor(target);
  const coordinator = fakeSandbox({
    async writeFile(path, content) {
      copied.push([path, content]);
    },
  });
  const text = await run(tools.workspace_read!, { path: 'out.txt' }, { harness: { sandbox: coordinator } });
  assert.deepEqual(text, { ok: true, path: '/workspace/out.txt', byteLength: 2, content: 'hi' });
  const moved = await run(tools.workspace_read!, { path: 'out.txt', to: '/home/user/out.txt' }, {
    harness: { sandbox: coordinator },
  });
  assert.deepEqual(moved, { ok: true, path: '/home/user/out.txt', byteLength: 2 });
  assert.equal(copied[0]?.[0], '/home/user/out.txt');

  const gone = session({ calls: [] }, { sandbox: fakeSandbox({ async exists() { return false; } }) });
  const missing = await run(toolsFor(gone).workspace_read!, { path: 'nope.txt' }, {
    harness: { sandbox: coordinator },
  });
  assert.equal(missing.reason, 'not_found');
});

test('list_files parses one bounded find and prunes dependency trees', async () => {
  const commands: string[] = [];
  const target = session({ calls: [] }, {
    sandbox: fakeSandbox({
      async exec(command) {
        commands.push(command);
        return { stdout: 'd\t4096\trepo\nf\t12\trepo/README.md\nd\t4096\trepo/node_modules\n', stderr: '', exitCode: 0 };
      },
    }),
  });
  const output = await run(toolsFor(target).workspace_list_files!, {});
  assert.deepEqual(output, {
    ok: true,
    path: '/workspace',
    truncated: false,
    entries: [
      { path: '/workspace/repo', type: 'directory' },
      { path: '/workspace/repo/README.md', type: 'file', size: 12 },
      { path: '/workspace/repo/node_modules', type: 'directory' },
    ],
  });
  assert.match(commands[0] ?? '', /-maxdepth 2 .*-name node_modules .*-prune/);
});

test('discarding a workspace destroys it through the DO and the next open starts over', async () => {
  const log: StubLog = { calls: [] };
  const target = session(log);
  const tools = toolsFor(target);
  await run(tools.workspace_open!, {});
  const closed = await run(tools.workspace_close!, { discard: true });
  assert.deepEqual(closed, { ok: true, workspace: 'main', closed: true, discarded: true });
  assert.equal(target.isOpen, false);
  await run(tools.workspace_open!, {});
  assert.equal(log.calls.filter((call) => call === 'beginWorkspaceTurn').length, 2);
  assert.ok(log.calls.includes('discardWorkspace'));
});

test('the registry ends every owned workspace when the submission throws, and skips relay-owned ones', async () => {
  const ended: string[] = [];
  const owned = session({ calls: [] });
  const shared = new WorkspaceSession({
    id: 'x',
    name: 'relay',
    agentId: 'agent-1',
    grants: [],
    mintStub: async () => fakeStub({ calls: [] }),
    reserveSession: async () => true,
    toSandbox: async () => fakeSandbox(),
  });
  await assert.rejects(
    runWithWorkspaceRegistry(async () => {
      const registry = currentWorkspaceRegistry()!;
      registry.register(owned, async () => {
        ended.push('main');
        throw new Error('end failed');
      });
      registry.register(shared);
      assert.equal(registry.get('main'), owned);
      throw new Error('turn failed');
    }),
    /turn failed/,
  );
  assert.deepEqual(ended, ['main']);
  assert.equal(currentWorkspaceRegistry(), undefined);
});

test('the registry interceptor scopes managed agent submissions only', async () => {
  const agent: FlueExecutionOperation = { type: 'agent', operationId: 's1', operationKind: 'prompt' };
  let inside: unknown;
  await workspaceRegistryInterceptor(agent, { agentName: 'chickpea-slack-v2' }, async () => {
    inside = currentWorkspaceRegistry();
    // A nested session-scope operation reuses the submission's registry.
    await workspaceRegistryInterceptor(agent, { agentName: 'chickpea-slack-v2' }, async () => {
      assert.equal(currentWorkspaceRegistry(), inside);
    });
  });
  assert.ok(inside);
  await workspaceRegistryInterceptor(agent, { agentName: 'some-other-agent' }, async () => {
    assert.equal(currentWorkspaceRegistry(), undefined);
  });
});

test('workspace tools are absent on bash plans and on the Node target', () => {
  assert.equal(runtimePlanWorkspaceToolsMounted({ sandbox: { mode: 'bash' } } as never, false), false);
  // This suite runs on Node, where no plan mounts them even with a workspace.
  assert.equal(runtimePlanWorkspaceToolsMounted({ sandbox: { mode: 'cloudflare' } } as never, false), false);
  assert.equal(runtimePlanWorkspaceToolsMounted(
    { sandbox: { mode: 'bash' }, codingWorkspace: { available: true } } as never,
    false,
  ), false);
  assert.deepEqual([...WORKSPACE_TOOL_NAMES].every((name) => name.startsWith('workspace_')), true);
});

test('on Cloudflare the tools mount for a virtual-sandbox plan with a coding workspace, never in a repair', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  try {
    const current = { sandbox: { mode: 'bash' }, codingWorkspace: { available: true } } as never;
    assert.equal(runtimePlanWorkspaceToolsMounted(current, false), true);
    assert.equal(runtimePlanWorkspaceToolsMounted(current, true), false);
    // A plan admitted with an attached container keeps its tools.
    assert.equal(runtimePlanWorkspaceToolsMounted({ sandbox: { mode: 'cloudflare' } } as never, false), true);
    assert.equal(runtimePlanWorkspaceToolsMounted({ sandbox: { mode: 'bash' } } as never, false), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('a session bound to its own turn prepares that turn before any workspace state', async () => {
  const log: StubLog = { calls: [] };
  const opened: string[] = [];
  const target = new WorkspaceSession({
    id: 'sandbox_' + 'c'.repeat(40),
    name: DEFAULT_WORKSPACE_NAME,
    agentId: 'agent-1',
    grants: [GRANT],
    credentialMode: 'app',
    turnId: 'turnjob-7',
    mintStub: async () => fakeStub(log),
    reserveSession: async () => true,
    toSandbox: async () => fakeSandbox(),
    onOpen: () => opened.push('open'),
  });
  assert.equal(target.wasOpened, false);
  await target.open();
  await target.open();
  // No relay prepared this turn: the session prepares it and never reads a
  // turn id someone else left on the Durable Object.
  assert.deepEqual(log.calls, ['prepareTurn', 'beginWorkspaceTurn', 'configureEgress']);
  assert.deepEqual(opened, ['open']);
  assert.equal(target.wasOpened, true);
  await target.discard();
  assert.equal(target.isOpen, false);
  assert.equal(target.wasOpened, true, 'a discarded workspace still has a turn to end');
});

test('a workspace that cannot be reached at open is a typed result, not a turn failure', async () => {
  const log: StubLog = { calls: [] };
  const target = new WorkspaceSession({
    id: 'sandbox_' + 'd'.repeat(40),
    name: DEFAULT_WORKSPACE_NAME,
    agentId: 'agent-1',
    grants: [GRANT],
    credentialMode: 'app',
    turnId: 'turnjob-8',
    mintStub: async (): Promise<WorkspaceSandboxStub> => ({
      ...fakeStub(log),
      async prepareTurn() { throw new Error('Durable Object reset because its code was updated'); },
    }),
    reserveSession: async () => true,
    toSandbox: async () => fakeSandbox(),
  });
  const output = await run(toolsFor(target).workspace_open!, {});
  assert.equal(output.ok, false);
  assert.equal(output.reason, 'workspace_unavailable');
});

test('the resolver building a workspace can fail as a typed result for every tool', async () => {
  const tools = Object.fromEntries(createWorkspaceTools({
    resolve: async () => { throw new SandboxUnavailableError(new Error('binding gone')); },
  }).map((tool) => [tool.name, tool]));
  for (const [name, input] of [
    ['workspace_open', {}],
    ['workspace_exec', { command: 'true' }],
    ['workspace_write', { path: 'a.txt', content: 'x' }],
  ] as const) {
    const output = await run(tools[name]!, input, { harness: { sandbox: fakeSandbox() } });
    assert.equal(output.ok, false, name);
    assert.equal(output.reason, 'workspace_unavailable', name);
  }
  // A listing reports a workspace it cannot read instead of failing whole.
  const listed = await run(tools.workspace_list!, {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.workspaces, [{ workspace: 'main', open: false, state: 'unavailable' }]);
});

test('the registry builds a workspace lazily, once per name, and retries a failed build', async () => {
  await runWithWorkspaceRegistry(async () => {
    const registry = currentWorkspaceRegistry()!;
    let builds = 0;
    const log: StubLog = { calls: [] };
    const factory = async () => {
      builds += 1;
      if (builds === 1) throw new Error('first build fails');
      return { session: session(log), end: async () => { log.calls.push('end'); } };
    };
    await assert.rejects(registry.resolve('main', factory), /first build fails/);
    const [first, second] = await Promise.all([
      registry.resolve('main', factory),
      registry.resolve('main', factory),
    ]);
    assert.equal(first, second);
    assert.equal(builds, 2);
    assert.equal(await registry.resolve('main', factory), first);
    // Building a session reaches no Durable Object.
    assert.deepEqual(log.calls, []);
    const empty = await registry.resolve('other', async () => undefined);
    assert.equal(empty, undefined);
  });
});

test('post_artifact with a workspace reads that workspace and fails closed without one', async () => {
  const staged: string[] = [];
  const binding = {
    channel: 'C1',
    threadTs: '1.2',
    sandboxKind: 'bash' as const,
    async stageArtifact(input: { filename: string; bytes: unknown }) {
      staged.push(input.filename);
      return { attached: true as const, byteLength: 2 };
    },
  };
  const readFrom: string[] = [];
  const deliver = async (env: Sandbox, input: { path: string; filename: string }, used: { sandboxKind: string }) => {
    readFrom.push(`${env.cwd}:${used.sandboxKind}:${input.path}`);
    return { attached: true as const, filename: input.filename, byteLength: 2 };
  };
  const workspaceEnv = fakeSandbox({ cwd: '/workspace' } as Partial<Sandbox>);
  const coordinatorEnv = fakeSandbox({ cwd: '/home/user' } as Partial<Sandbox>);
  const tool = createWorkspaceArtifactTool(binding, deliver, {
    sandbox: (name) => (name === 'main' ? Promise.resolve(workspaceEnv) : undefined),
  });
  const harness = { sandbox: coordinatorEnv };
  await tool.run({ ...RUN, harness, data: { path: 'a.csv', filename: 'a.csv' } } as never);
  await tool.run({ ...RUN, harness, data: { path: '/workspace/b.png', filename: 'b.png', workspace: 'main' } } as never);
  const missing = await tool.run({
    ...RUN,
    harness,
    data: { path: '/workspace/c.png', filename: 'c.png', workspace: 'other' },
  } as never);
  assert.deepEqual(readFrom, ['/home/user:bash:a.csv', '/workspace:cloudflare:/workspace/b.png']);
  assert.deepEqual(missing, {
    output: { attached: false, reason: 'unavailable', detail: 'source_unavailable' },
  });
  assert.ok(tool.description.includes('pass workspace'));

  const plain = createWorkspaceArtifactTool(binding, deliver);
  assert.equal(plain.description.includes('pass workspace'), false);
});

test('list_files reports a missing directory, and read of a directory is a typed refusal', async () => {
  const missing = session({ calls: [] }, {
    sandbox: fakeSandbox({
      async exec(command) {
        assert.match(command, /^test -d '\/workspace\/nope' && find /);
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    }),
  });
  const listed = await run(toolsFor(missing).workspace_list_files!, { path: 'nope' });
  assert.equal(listed.reason, 'not_found');

  const directory = session({ calls: [] }, {
    sandbox: fakeSandbox({
      async stat() {
        return { isFile: false, isDirectory: true };
      },
    }),
  });
  const read = await run(toolsFor(directory).workspace_read!, { path: 'repo' }, {
    harness: { sandbox: fakeSandbox() },
  });
  assert.equal(read.reason, 'not_found');
});

test('a root cwd stays outside the workspace instead of mapping onto it', async () => {
  assert.throws(() => workspaceDirectoryPath('/'), /under \/workspace/);
  assert.throws(() => workspaceDirectoryPath('///'), /under \/workspace/);
  assert.equal(workspaceDirectoryPath(''), '/workspace');
  assert.equal(workspaceDirectoryPath('/workspace//'), '/workspace');
  const output = await run(toolsFor(session({ calls: [] })).workspace_exec!, { command: 'ls', cwd: '/' });
  assert.equal(output.reason, 'invalid_path');
});

// --- multiple workspaces -----------------------------------------------------

test('named and retired workspace ids are stable, distinct, and never the legacy key', () => {
  for (const conversation of ['T1:C1:1783000000.000100', 'sandbox_' + 'c'.repeat(40)]) {
    const legacy = defaultWorkspaceId(conversation);
    assert.equal(workspaceIdFor(conversation, DEFAULT_WORKSPACE_NAME), legacy, 'default = legacy key');
    assert.equal(workspaceIdFor(conversation, DEFAULT_WORKSPACE_NAME, 0), legacy);
    const ids = [
      workspaceIdFor(conversation, 'api'),
      workspaceIdFor(conversation, 'web'),
      workspaceIdFor(conversation, 'api', 1),
      workspaceIdFor(conversation, 'api', 2),
      workspaceIdFor(conversation, DEFAULT_WORKSPACE_NAME, 1),
    ];
    assert.equal(new Set([legacy, ...ids]).size, ids.length + 1, 'every name and generation is its own workspace');
    for (const id of ids) {
      assert.match(id, /^sandbox_[a-f0-9]{40}$/);
      assert.ok(id.length <= 63, 'within the Sandbox id limit');
      // The relay's thread-key mapping leaves a workspace id unchanged.
      assert.equal(sandboxThreadKey(id), id);
    }
    assert.equal(workspaceIdFor(conversation, 'api', 1), ids[2], 'stable across calls');
  }
  assert.notEqual(
    workspaceIdFor('T1:C1:1', 'api'),
    workspaceIdFor('T1:C1:2', 'api'),
    'a name is scoped to its thread',
  );
});

test('the coding worker id includes the workspace id and the binding', () => {
  const plan = {
    agentId: 'agent-1',
    model: 'anthropic/claude-sonnet-5',
    runtimeModel: 'anthropic/claude-sonnet-5',
    repositories: [{ id: 'grant-1', fullName: 'acme/app' }],
    codingWorkspace: { available: true as const },
  };
  const conversation = 'T1:C1:1783000000.000100';
  const main = codingWorkerInstanceId(codingWorkerBindingForPlan(plan, workspaceIdFor(conversation, 'main')));
  const api = codingWorkerInstanceId(codingWorkerBindingForPlan(plan, workspaceIdFor(conversation, 'api')));
  const retired = codingWorkerInstanceId(codingWorkerBindingForPlan(plan, workspaceIdFor(conversation, 'api', 1)));
  const otherModel = codingWorkerInstanceId(codingWorkerBindingForPlan(
    { ...plan, model: 'openai/gpt-6', runtimeModel: 'openai/gpt-6' },
    workspaceIdFor(conversation, 'api'),
  ));
  assert.equal(new Set([main, api, retired, otherModel]).size, 4);
  for (const id of [main, api, retired]) {
    assert.notEqual(id, workspaceIdFor(conversation, 'main'), 'the worker id is never the workspace id');
  }
});

test('each workspace but the default qualifies its session reservation', () => {
  const conversation = 'T1:C1:1783000000.000100';
  assert.equal(workspaceReservationId(conversation, defaultWorkspaceId(conversation), 'turn-1'), 'turn-1');
  const api = workspaceIdFor(conversation, 'api');
  const web = workspaceIdFor(conversation, 'web');
  assert.equal(workspaceReservationId(conversation, api, 'turn-1'), `turn-1:${api}`);
  assert.notEqual(
    workspaceReservationId(conversation, api, 'turn-1'),
    workspaceReservationId(conversation, web, 'turn-1'),
    'two workspaces in one turn are two sessions',
  );
});

test('workspace names normalize and reject anything else', () => {
  assert.equal(normalizeWorkspaceName(undefined), 'main');
  assert.equal(normalizeWorkspaceName('  API '), 'api');
  assert.equal(normalizeWorkspaceName('tag-team_2'), 'tag-team_2');
  for (const bad of ['', ' ', '-x', 'a/b', 'a:b', 'a b', 'x'.repeat(33)]) {
    assert.throws(() => normalizeWorkspaceName(bad), /workspace name/);
  }
});

test('the open cap admits two workspaces, refuses a third, and frees a slot on close', () => {
  const now = 1_000_000;
  let state: WorkspaceRosterState = EMPTY_WORKSPACE_ROSTER;
  const admit = (name: string, at = now) => {
    const result = admitWorkspace(state, name, at);
    state = result.state;
    return result.admission;
  };
  assert.equal(MAX_OPEN_WORKSPACES, 2);
  assert.deepEqual(admit('api'), { ok: true, generation: 0 });
  assert.deepEqual(admit('web'), { ok: true, generation: 0 });
  assert.deepEqual(admit('api'), { ok: true, generation: 0 }, 'using an open workspace is always admitted');
  assert.deepEqual(admit('docs'), { ok: false, open: ['api', 'web'] });
  assert.deepEqual(openWorkspaceNames(state, now), ['api', 'web'], 'a refusal changes nothing');

  state = closeWorkspace(state, 'web', { discard: false, now });
  assert.deepEqual(admit('docs'), { ok: true, generation: 0 });
  assert.deepEqual(admit('web'), { ok: false, open: ['api', 'docs'] });

  // A discard retires the name: its next use is generation 1.
  state = closeWorkspace(state, 'docs', { discard: true, now });
  assert.deepEqual(admit('docs'), { ok: true, generation: 1 });
  // A plain close keeps the generation, so reopening finds the same files.
  state = closeWorkspace(state, 'docs', { discard: false, now });
  assert.deepEqual(admit('docs'), { ok: true, generation: 1 });

  // A workspace idle past the checkpoint lifetime holds nothing and stops counting.
  const later = now + WORKSPACE_CHECKPOINT_TTL_SECONDS * 1000;
  assert.deepEqual(openWorkspaceNames(state, later), []);
  assert.deepEqual(admit('web', later), { ok: true, generation: 0 });
});

test('the roster persists through its updater and keeps its own writes visible', () => {
  let stored: unknown = { schemaVersion: 1, workspaces: { api: { generation: 2, open: true, lastUsedAt: 5 } } };
  let writes = 0;
  const roster = createWorkspaceRoster(parseRoster(stored), (updater) => {
    writes += 1;
    stored = updater(stored as WorkspaceRosterState);
  }, () => 10);
  assert.equal(roster.generation('api'), 2);
  assert.equal(roster.admit('api'), 2);
  assert.equal(writes, 0, 'a use within a minute of the last one writes nothing');
  assert.equal(roster.admit('web'), 0);
  assert.throws(() => roster.admit('docs'), (error) => error instanceof WorkspaceLimitError);
  roster.close('api', { discard: true });
  assert.equal(roster.generation('api'), 3);
  assert.equal(roster.knows('api'), true);
  assert.equal(roster.knows('docs'), false);
  assert.equal(roster.knows('main'), true, 'the default workspace always exists');
  assert.equal(roster.admit('docs'), 0);
  assert.equal(writes, 3);
  assert.deepEqual(parseRoster(stored), roster.snapshot());

  // Malformed state from an earlier release is dropped, not trusted.
  assert.deepEqual(parseRoster({ schemaVersion: 2 }), EMPTY_WORKSPACE_ROSTER);
  assert.deepEqual(parseRoster({
    schemaVersion: 1,
    workspaces: { 'Bad Name': { generation: 0, open: true, lastUsedAt: 1 }, ok: { generation: -1, open: true, lastUsedAt: 1 } },
  }), EMPTY_WORKSPACE_ROSTER);
});

/**
 * Tools over a roster and a resolver shaped like the coordinator's: a use
 * admits the name, and the name's generation picks its workspace.
 */
function multiWorkspaceTools(options: { running?: Set<string>; describe?: Record<string, { running: boolean; hasCheckpoint: boolean }> } = {}) {
  let stored: WorkspaceRosterState = EMPTY_WORKSPACE_ROSTER;
  const roster = createWorkspaceRoster(stored, (updater) => { stored = updater(stored); });
  const log: StubLog = { calls: [] };
  const sessions = new Map<string, WorkspaceSession>();
  const conversation = 'T1:C1:1783000000.000100';
  const tools = createWorkspaceTools({
    roster,
    taskRunning: (id) => options.running?.has(id) ?? false,
    resolve: (name, access = 'use') => {
      const generation = access === 'use' ? roster.admit(name) : roster.generation(name);
      const key = workspaceRegistryKey(name, generation);
      let found = sessions.get(key);
      if (!found) {
        const id = workspaceIdFor(conversation, name, generation);
        found = new WorkspaceSession({
          id,
          name,
          agentId: 'agent-1',
          grants: [GRANT],
          credentialMode: 'app',
          mintStub: async (): Promise<WorkspaceSandboxStub> => ({
            ...fakeStub(log),
            async describeWorkspace() {
              log.calls.push(`describe:${name}`);
              return options.describe?.[name] ?? { running: false, hasCheckpoint: false };
            },
            async discardWorkspace() {
              log.calls.push(`discard:${name}`);
            },
          }),
          reserveSession: async () => true,
          toSandbox: async () => fakeSandbox(),
        });
        sessions.set(key, found);
      }
      return found;
    },
  });
  return {
    tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
    log,
    sessions,
    conversation,
    stored: () => stored,
  };
}

test('two named workspaces open, a third is refused without touching its Durable Object, and closing frees a slot', async () => {
  const { tools, log, sessions, conversation } = multiWorkspaceTools();
  assert.equal((await run(tools.workspace_open!, { workspace: 'api' })).ok, true);
  assert.equal((await run(tools.workspace_exec!, { workspace: 'web', command: 'true' })).ok, true);
  log.calls.length = 0;
  const refused = await run(tools.workspace_open!, { workspace: 'docs' });
  assert.equal(refused.reason, 'workspace_limit');
  assert.match(String(refused.message), /open: api, web/);
  assert.deepEqual(log.calls, [], 'a refused workspace reaches no Durable Object');
  assert.equal(sessions.has('docs'), false);

  assert.deepEqual(await run(tools.workspace_close!, { workspace: 'web' }), {
    ok: true, workspace: 'web', closed: true, discarded: false,
  });
  const opened = await run(tools.workspace_open!, { workspace: 'docs' });
  assert.equal(opened.ok, true);
  assert.equal(sessions.get('docs')?.id, workspaceIdFor(conversation, 'docs'));

  // Closing a name this thread never used is a typed refusal.
  const unknown = await run(tools.workspace_close!, { workspace: 'never' });
  assert.equal(unknown.reason, 'not_found');
});

test('a discard retires the name so its next use is a new workspace', async () => {
  const { tools, log, sessions, conversation } = multiWorkspaceTools();
  await run(tools.workspace_open!, { workspace: 'api' });
  const closed = await run(tools.workspace_close!, { workspace: 'api', discard: true });
  assert.equal(closed.discarded, true);
  assert.ok(log.calls.includes('discard:api'));
  await run(tools.workspace_open!, { workspace: 'api' });
  assert.equal(sessions.get('api')?.id, workspaceIdFor(conversation, 'api', 0));
  assert.equal(sessions.get(workspaceRegistryKey('api', 1))?.id, workspaceIdFor(conversation, 'api', 1));
  assert.notEqual(workspaceIdFor(conversation, 'api', 1), workspaceIdFor(conversation, 'api', 0));
});

test('workspace_list reports every workspace with its state, open flag, and running task', async () => {
  const running = new Set<string>();
  const { tools, log, conversation } = multiWorkspaceTools({
    running,
    describe: {
      main: { running: false, hasCheckpoint: true },
      api: { running: true, hasCheckpoint: false },
      web: { running: false, hasCheckpoint: false },
    },
  });
  await run(tools.workspace_open!, { workspace: 'api' });
  await run(tools.workspace_open!, { workspace: 'web' });
  await run(tools.workspace_close!, { workspace: 'web' });
  running.add(workspaceIdFor(conversation, 'api'));
  log.calls.length = 0;
  const listed = await run(tools.workspace_list!, {});
  assert.equal(listed.ok, true);
  assert.equal(listed.maxOpen, 2);
  const byName = Object.fromEntries((listed.workspaces as Array<Record<string, unknown>>).map((entry) => [entry.workspace, entry]));
  assert.deepEqual(Object.keys(byName), ['main', 'api', 'web'], 'the default first, then the thread\'s names');
  assert.deepEqual(
    { open: byName.main!.open, state: byName.main!.state, taskRunning: byName.main!.taskRunning },
    { open: false, state: 'checkpointed', taskRunning: false },
  );
  assert.deepEqual(
    { open: byName.api!.open, state: byName.api!.state, taskRunning: byName.api!.taskRunning },
    { open: true, state: 'running', taskRunning: true },
  );
  assert.deepEqual(
    { open: byName.web!.open, state: byName.web!.state, taskRunning: byName.web!.taskRunning },
    { open: false, state: 'empty', taskRunning: false },
  );
  assert.equal(typeof byName.api!.lastUsedAt, 'string');
  // Listing reads DO records only and admits nothing.
  assert.deepEqual(log.calls.sort(), ['describe:api', 'describe:main', 'describe:web']);
  assert.equal((await run(tools.workspace_open!, { workspace: 'docs' })).ok, true, 'list never took a slot');
});

test('closing a workspace with a task running in it is refused as busy', async () => {
  const running = new Set<string>();
  const { tools, log, conversation } = multiWorkspaceTools({ running });
  await run(tools.workspace_open!, { workspace: 'api' });
  running.add(workspaceIdFor(conversation, 'api'));
  for (const discard of [false, true]) {
    const refused = await run(tools.workspace_close!, { workspace: 'api', discard });
    assert.equal(refused.reason, 'busy');
  }
  assert.equal(log.calls.includes('discard:api'), false, 'the running task keeps its container');
  // The slot stays taken while the task runs.
  await run(tools.workspace_open!, { workspace: 'web' });
  assert.equal((await run(tools.workspace_open!, { workspace: 'docs' })).reason, 'workspace_limit');
});

test('the coordinator resolver never creates a workspace to inspect, and a use that fails gives its slot back', async () => {
  let stored: WorkspaceRosterState = EMPTY_WORKSPACE_ROSTER;
  const roster = createWorkspaceRoster(stored, (updater) => { stored = updater(stored); });
  const plan = {
    sandbox: { mode: 'bash' },
    codingWorkspace: { available: true },
  } as never;
  const resolve = runtimePlanWorkspaceResolver(plan, { release: false, roster });
  await runWithWorkspaceRegistry(async () => {
    // Off Cloudflare no workspace can be created, which stands in for a
    // workspace that did not come up.
    assert.equal(await resolve('api', 'use'), undefined);
    assert.deepEqual(stored, EMPTY_WORKSPACE_ROSTER, 'the failed open holds no slot');
    assert.equal(await resolve('never-used', 'inspect'), undefined);
    assert.equal(roster.knows('never-used'), false);
  });

  const legacy = runtimePlanWorkspaceResolver({ sandbox: { mode: 'cloudflare' } } as never, { release: false });
  assert.throws(() => legacy('api', 'use'), (error) =>
    error instanceof WorkspaceLimitError && /only the "main" workspace/.test(error.message));
});

test('a retired name keeps its generation however many other names the thread uses', () => {
  let state: WorkspaceRosterState = EMPTY_WORKSPACE_ROSTER;
  state = closeWorkspace(admitWorkspace(state, 'api', 1).state, 'api', { discard: true, now: 1 });
  for (let index = 0; index < 40; index += 1) {
    state = closeWorkspace(admitWorkspace(state, `w${index}`, 2).state, `w${index}`, { discard: false, now: 2 });
  }
  assert.deepEqual(admitWorkspace(state, 'api', 3).admission, { ok: true, generation: 1 });
});
