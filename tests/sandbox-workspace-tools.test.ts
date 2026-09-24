import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FlueExecutionOperation, Sandbox } from '@flue/runtime';

import { runtimePlanWorkspaceToolsMounted } from '../src/agents/slack-thread.ts';
import { createWorkspaceArtifactTool } from '../src/sandbox/artifact-tool.ts';
import { SandboxUnavailableError } from '../src/sandbox/errors.ts';
import { sandboxThreadKey } from '../src/sandbox/thread-key.ts';
import {
  currentWorkspaceRegistry,
  runWithWorkspaceRegistry,
  workspaceRegistryInterceptor,
} from '../src/sandbox/workspace-registry.ts';
import {
  DEFAULT_WORKSPACE_NAME,
  WorkspaceSession,
  defaultWorkspaceId,
  type WorkspaceSandboxStub,
} from '../src/sandbox/workspace-session.ts';
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
  options: { restorable?: boolean; state?: 'warm' | 'fresh' | 'retired'; turnId?: string } = {},
): WorkspaceSandboxStub {
  return {
    async getTurnId() {
      log.calls.push('getTurnId');
      return options.turnId ?? 'turn-1';
    },
    async prepareTurn() {
      log.calls.push('prepareTurn');
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
  const tools = createWorkspaceTools({
    resolve: (name) => (name === DEFAULT_WORKSPACE_NAME ? target : undefined),
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
    workspaces: [{ workspace: 'main', open: true, running: false, hasCheckpoint: true }],
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

  const other = await run(toolsFor(session({ calls: [] })).workspace_exec!, {
    workspace: 'second',
    command: 'ls',
  });
  assert.equal(other.reason, 'unknown_workspace');
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
  // This suite runs on Node, where no plan mounts them even in cloudflare mode.
  assert.equal(runtimePlanWorkspaceToolsMounted({ sandbox: { mode: 'cloudflare' } } as never, false), false);
  assert.deepEqual([...WORKSPACE_TOOL_NAMES].every((name) => name.startsWith('workspace_')), true);
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
