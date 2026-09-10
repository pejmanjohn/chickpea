import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SandboxFactory, SessionEnv } from '@flue/runtime';

import {
  createWorkspaceArtifactCapability,
  MAX_ARTIFACT_BYTES,
} from '../src/sandbox/artifact-tool.ts';

const TOOL_RUN_CONTEXT = {
  toolCallId: 'artifact-test-call',
  log: { info() {}, warn() {}, error() {} },
} as const;

function fakeSessionEnv(
  readPaths: string[],
  statPaths: string[] = [],
  size = 3,
  options: {
    execCommands?: string[];
    removedPaths?: string[];
    readBytes?: Uint8Array;
  } = {},
): SessionEnv {
  return {
    cwd: '/workspace',
    resolvePath(path) {
      return path;
    },
    async exec(command) {
      options.execCommands?.push(command);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async readFile() {
      return '';
    },
    async readFileBuffer(path) {
      readPaths.push(path);
      return options.readBytes ?? new Uint8Array([1, 2, 3]);
    },
    async writeFile() {},
    async stat(path) {
      statPaths.push(path);
      return { isFile: true, isDirectory: false, size };
    },
    async readdir() {
      return [];
    },
    async exists() {
      return true;
    },
    async mkdir() {},
    async rm(path) {
      options.removedPaths?.push(path);
    },
  };
}

test('workspace artifact tool reads through SessionEnv and binds the Slack destination', async () => {
  const readPaths: string[] = [];
  const statPaths: string[] = [];
  const execCommands: string[] = [];
  const removedPaths: string[] = [];
  const uploads: unknown[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths, statPaths, 3, {
        execCommands,
        removedPaths,
      });
    },
  };
  const capability = createWorkspaceArtifactCapability({
    sandbox: base,
    sandboxKind: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact(input) {
      uploads.push(input);
      return { uploaded: true };
    },
  });

  await capability.sandbox.createSessionEnv({ id: 'thread-1' });
  const result = await capability.tool.run({
    ...TOOL_RUN_CONTEXT,
    data: {
      path: '/workspace/proof.png',
      filename: 'proof.png',
      title: 'Proof',
    },
  });

  assert.deepEqual(result, { output: { uploaded: true } });
  assert.equal(statPaths[0], '/workspace/proof.png');
  const frozenPath = statPaths[1];
  assert.match(
    frozenPath ?? '',
    /^\/workspace\/\.chickpea-artifact-[a-f0-9]{32}\.tmp$/,
  );
  assert.deepEqual(readPaths, [frozenPath]);
  assert.deepEqual(removedPaths, [frozenPath]);
  assert.equal(execCommands.length, 1);
  assert.match(
    execCommands[0] ?? '',
    new RegExp(
      `head -c ${MAX_ARTIFACT_BYTES + 1} -- '/workspace/proof\\.png' > '/workspace/\\.chickpea-artifact-[a-f0-9]{32}\\.tmp'$`,
    ),
  );
  assert.deepEqual(uploads, [
    {
      channel: 'C_BOUND',
      threadTs: '1782770400.000100',
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'proof.png',
      title: 'Proof',
    },
  ]);
});

test('workspace artifact tool rejects over-cap files without reading or posting them', async () => {
  const readPaths: string[] = [];
  const statPaths: string[] = [];
  const uploads: unknown[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths, statPaths, MAX_ARTIFACT_BYTES + 1);
    },
  };
  const capability = createWorkspaceArtifactCapability({
    sandbox: base,
    sandboxKind: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact(input) {
      uploads.push(input);
      return { uploaded: true };
    },
  });

  await capability.sandbox.createSessionEnv({ id: 'thread-1' });
  await assert.rejects(
    async () =>
      capability.tool.run({
        ...TOOL_RUN_CONTEXT,
        data: {
          path: '/workspace/oversized.zip',
          filename: 'oversized.zip',
        },
      }),
    /artifact exceeds the 8 MB upload limit/,
  );
  assert.deepEqual(statPaths, ['/workspace/oversized.zip']);
  assert.deepEqual(readPaths, []);
  assert.deepEqual(uploads, []);
});

test('workspace artifact copy-freeze bounds a source that grows after the pre-stat', async () => {
  const readPaths: string[] = [];
  const statPaths: string[] = [];
  const execCommands: string[] = [];
  const removedPaths: string[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths, statPaths, 1, {
        execCommands,
        removedPaths,
        readBytes: new Uint8Array(MAX_ARTIFACT_BYTES),
      });
    },
  };
  let uploadedBytes = -1;
  const capability = createWorkspaceArtifactCapability({
    sandbox: base,
    sandboxKind: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact(input) {
      uploadedBytes = input.bytes.byteLength;
      return { uploaded: true };
    },
  });

  await capability.sandbox.createSessionEnv({ id: 'thread-race' });
  await capability.tool.run({
    ...TOOL_RUN_CONTEXT,
    data: {
      path: '/workspace/racing.bin',
      filename: 'racing.bin',
    },
  });

  assert.equal(uploadedBytes, MAX_ARTIFACT_BYTES);
  assert.equal(execCommands.length, 1);
  assert.match(execCommands[0] ?? '', new RegExp(`head -c ${MAX_ARTIFACT_BYTES + 1}`));
  assert.deepEqual(removedPaths, readPaths);
});

test('workspace artifact tool rejects post-read oversize bytes and cleans up', async () => {
  const readPaths: string[] = [];
  const statPaths: string[] = [];
  const removedPaths: string[] = [];
  const uploads: unknown[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths, statPaths, 1, {
        removedPaths,
        readBytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1),
      });
    },
  };
  const capability = createWorkspaceArtifactCapability({
    sandbox: base,
    sandboxKind: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact(input) {
      uploads.push(input);
      return { uploaded: true };
    },
  });

  await capability.sandbox.createSessionEnv({ id: 'thread-post-read' });
  await assert.rejects(
    async () =>
      capability.tool.run({
        ...TOOL_RUN_CONTEXT,
        data: {
          path: '/workspace/racing.bin',
          filename: 'racing.bin',
        },
      }),
    /artifact exceeds the 8 MB upload limit/,
  );
  assert.equal(readPaths.length, 1);
  assert.deepEqual(removedPaths, readPaths);
  assert.deepEqual(uploads, []);
});

test('workspace artifact temp name is random and independent of model input', async () => {
  const readPaths: string[] = [];
  const execCommands: string[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths, [], 3, { execCommands });
    },
  };
  const capability = createWorkspaceArtifactCapability({
    sandbox: base,
    sandboxKind: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact() {
      return { uploaded: true };
    },
  });

  await capability.sandbox.createSessionEnv({ id: 'thread-random' });
  await capability.tool.run({
    ...TOOL_RUN_CONTEXT,
    data: {
      path: "/workspace/model-controlled-'-$HOME.bin",
      filename: 'model-controlled.bin',
    },
  });

  assert.equal(execCommands.length, 1);
  assert.equal(
    (execCommands[0] ?? '').includes(
      "head -c 8388609 -- '/workspace/model-controlled-'\\''-$HOME.bin'",
    ),
    true,
  );
  const frozenPath = readPaths[0] ?? '';
  assert.match(
    frozenPath,
    /^\/workspace\/\.chickpea-artifact-[a-f0-9]{32}\.tmp$/,
  );
  assert.equal(frozenPath.includes('model-controlled'), false);
});

test('workspace artifact tool keeps the container root and rejects paths outside it', async () => {
  const readPaths: string[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths);
    },
  };
  const capability = createWorkspaceArtifactCapability({
    sandbox: base,
    sandboxKind: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact() {
      return { uploaded: true };
    },
  });
  await capability.sandbox.createSessionEnv({ id: 'thread-1' });

  assert.deepEqual(
    await capability.tool.run({
      ...TOOL_RUN_CONTEXT,
      data: {
        path: '/workspace/proof.png',
        filename: 'proof.png',
      },
    }),
    { output: { uploaded: true } },
  );
  assert.equal(readPaths.length, 1);
  assert.match(
    readPaths[0] ?? '',
    /^\/workspace\/\.chickpea-artifact-[a-f0-9]{32}\.tmp$/,
  );

  await assert.rejects(
    async () =>
      capability.tool.run({
        ...TOOL_RUN_CONTEXT,
        data: {
          path: '/workspace/../secret',
          filename: 'secret',
        },
      }),
    /normalized file under \/workspace/,
  );
});

test('in-memory sandbox artifacts are read directly, byte for byte, with no shell copy', async () => {
  const { bash } = await import('@flue/runtime');
  const { Bash, InMemoryFs } = await import('just-bash');
  const uploads: { bytes: Uint8Array; filename: string }[] = [];
  const capability = createWorkspaceArtifactCapability({
    sandbox: bash(() => new Bash({ fs: new InMemoryFs() })),
    sandboxKind: 'bash',
    channel: 'C_BOUND',
    threadTs: '1782770400.000300',
    async postArtifact(input) {
      uploads.push({ bytes: input.bytes, filename: input.filename });
      return { uploaded: true };
    },
  });
  const env = await capability.sandbox.createSessionEnv({ id: 'thread-bash' });

  // A text file the model would write with the shell, addressed relative to cwd.
  const csv = 'exam,net_bookings\nGRE,2400\nTOEFL,800\n';
  await env.writeFile('bookings.csv', csv);
  const textResult = await capability.tool.run({
    ...TOOL_RUN_CONTEXT,
    data: { path: 'bookings.csv', filename: 'bookings.csv' },
  });
  assert.deepEqual(textResult, { output: { uploaded: true } });
  assert.deepEqual(uploads[0]?.bytes, new TextEncoder().encode(csv));

  // Binary bytes survive untouched, which the string-based shell pipe cannot
  // guarantee: just-bash re-encodes non-UTF-8 bytes and rejects `head -- path`.
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x7f]);
  await env.writeFile('/tmp/out/chart.png', png);
  await capability.tool.run({
    ...TOOL_RUN_CONTEXT,
    data: { path: '/tmp/out/chart.png', filename: 'chart.png', title: 'Chart' },
  });
  assert.deepEqual(uploads[1]?.bytes, png);
  await env.writeFile('/home/normalized.txt', 'isolated');
  await capability.tool.run({
    ...TOOL_RUN_CONTEXT,
    data: { path: '../normalized.txt', filename: 'normalized.txt' },
  });
  assert.deepEqual(uploads[2]?.bytes, new TextEncoder().encode('isolated'));
  const shellProbe = await env.exec('head -c 4 -- bookings.csv');
  assert.notEqual(shellProbe.exitCode, 0, 'shell freeze command is not portable to just-bash');
});

test('in-memory sandbox artifacts stat before reading and reject malformed resolver results and oversize files', async () => {
  const readPaths: string[] = [];
  const statPaths: string[] = [];
  const execCommands: string[] = [];
  const uploads: unknown[] = [];
  const build = (size: number, readBytes?: Uint8Array) => createWorkspaceArtifactCapability({
    sandbox: {
      async createSessionEnv() {
        const env = fakeSessionEnv(readPaths, statPaths, size, {
          execCommands,
          ...(readBytes ? { readBytes } : {}),
        });
        return { ...env, cwd: '/home/user', resolvePath: (path) => (path.startsWith('/') ? path : `/home/user/${path}`) };
      },
    },
    sandboxKind: 'bash',
    channel: 'C_BOUND',
    threadTs: '1782770400.000400',
    async postArtifact(input) {
      uploads.push(input);
      return { uploaded: true };
    },
  });

  const ok = build(3);
  await ok.sandbox.createSessionEnv({ id: 'thread-a' });
  await ok.tool.run({ ...TOOL_RUN_CONTEXT, data: { path: 'notes/report.md', filename: 'report.md' } });
  assert.deepEqual(statPaths, ['/home/user/notes/report.md']);
  assert.deepEqual(readPaths, ['/home/user/notes/report.md']);
  assert.deepEqual(execCommands, []);
  assert.equal(uploads.length, 1);

  // This fake deliberately returns unnormalized paths. The real adapter
  // normalizes traversal within its isolated virtual filesystem.
  for (const path of ['../secrets', '/home/user/../etc/passwd', '/home//user/x', '   ']) {
    await assert.rejects(
      async () => ok.tool.run({ ...TOOL_RUN_CONTEXT, data: { path, filename: 'x' } }),
      /artifact path/,
      path,
    );
  }

  const tooLarge = build(MAX_ARTIFACT_BYTES + 1);
  await tooLarge.sandbox.createSessionEnv({ id: 'thread-b' });
  readPaths.length = 0;
  await assert.rejects(
    async () => tooLarge.tool.run({ ...TOOL_RUN_CONTEXT, data: { path: '/big.bin', filename: 'big.bin' } }),
    /exceeds the 8 MB upload limit/,
  );
  assert.deepEqual(readPaths, [], 'oversize files are refused before any read');

  const grown = build(3, new Uint8Array(MAX_ARTIFACT_BYTES + 1));
  await grown.sandbox.createSessionEnv({ id: 'thread-c' });
  await assert.rejects(
    async () => grown.tool.run({ ...TOOL_RUN_CONTEXT, data: { path: '/grown.bin', filename: 'grown.bin' } }),
    /exceeds the 8 MB upload limit/,
  );
  assert.equal(uploads.length, 1, 'post-read oversize bytes are never posted');
});

test('the hook-agent artifact tool reads the in-memory sandbox through the harness', async () => {
  const { createWorkspaceArtifactTool } = await import('../src/sandbox/artifact-tool.ts');
  const readPaths: string[] = [];
  const uploads: unknown[] = [];
  const tool = createWorkspaceArtifactTool({
    sandboxKind: 'bash',
    channel: 'C_PLAN',
    threadTs: '1782770400.000500',
    async postArtifact(input) {
      uploads.push(input);
      return { uploaded: true };
    },
  });
  const env = fakeSessionEnv(readPaths, [], 3);
  const result = await tool.run({
    ...TOOL_RUN_CONTEXT,
    data: { path: '/home/user/summary.json', filename: 'summary.json' },
    harness: { sandbox: env },
  } as never);
  assert.deepEqual(result, { output: { uploaded: true } });
  assert.deepEqual(readPaths, ['/home/user/summary.json']);
  assert.equal(uploads.length, 1);
});
