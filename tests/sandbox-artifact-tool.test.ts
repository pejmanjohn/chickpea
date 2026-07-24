import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { SandboxFactory, SessionEnv } from '@flue/runtime';
import { local } from '@flue/runtime/node';

import {
  createWorkspaceArtifactCapability,
  MAX_ARTIFACT_BYTES,
} from '../src/sandbox/artifact-tool.ts';

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
    selection: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact(input) {
      uploads.push(input);
      return { uploaded: true };
    },
  });

  await capability.sandbox.createSessionEnv({ id: 'thread-1' });
  const result = await capability.tool.run({
    input: {
      path: '/workspace/proof.png',
      filename: 'proof.png',
      title: 'Proof',
    },
  });

  assert.deepEqual(result, { uploaded: true });
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
      `head -c ${MAX_ARTIFACT_BYTES} -- '/workspace/proof\\.png' > '/workspace/\\.chickpea-artifact-[a-f0-9]{32}\\.tmp'$`,
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
    selection: 'cloudflare',
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
        input: {
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
  const workspace = await mkdtemp(join(tmpdir(), 'chickpea-artifact-'));
  try {
    await writeFile(
      join(workspace, 'racing.bin'),
      new Uint8Array(MAX_ARTIFACT_BYTES + 1),
    );
    const base = local({ cwd: workspace });
    const sandbox: SandboxFactory = {
      async createSessionEnv(createOptions) {
        const session = await base.createSessionEnv(createOptions);
        let sourceStats = 0;
        return {
          ...session,
          async stat(path) {
            if (path === 'racing.bin' && sourceStats++ === 0) {
              return { isFile: true, isDirectory: false, size: 1 };
            }
            return session.stat(path);
          },
        };
      },
    };
    let uploadedBytes = -1;
    const capability = createWorkspaceArtifactCapability({
      sandbox,
      selection: 'local',
      channel: 'C_BOUND',
      threadTs: '1782770400.000100',
      async postArtifact(input) {
        uploadedBytes = input.bytes.byteLength;
        return { uploaded: true };
      },
    });

    await capability.sandbox.createSessionEnv({ id: 'thread-race' });
    await capability.tool.run({
      input: {
        path: '/workspace/racing.bin',
        filename: 'racing.bin',
      },
    });

    assert.equal(uploadedBytes, MAX_ARTIFACT_BYTES);
    assert.deepEqual(
      (await readdir(workspace)).filter((name) =>
        name.startsWith('.chickpea-artifact-'),
      ),
      [],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
    selection: 'cloudflare',
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
        input: {
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
    selection: 'cloudflare',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact() {
      return { uploaded: true };
    },
  });

  await capability.sandbox.createSessionEnv({ id: 'thread-random' });
  await capability.tool.run({
    input: {
      path: "/workspace/model-controlled-'-$HOME.bin",
      filename: 'model-controlled.bin',
    },
  });

  assert.equal(execCommands.length, 1);
  assert.equal(
    (execCommands[0] ?? '').includes(
      "head -c 8388608 -- '/workspace/model-controlled-'\\''-$HOME.bin'",
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

test('workspace artifact tool maps the logical root locally and rejects paths outside it', async () => {
  const readPaths: string[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths);
    },
  };
  const capability = createWorkspaceArtifactCapability({
    sandbox: base,
    selection: 'local',
    channel: 'C_BOUND',
    threadTs: '1782770400.000100',
    async postArtifact() {
      return { uploaded: true };
    },
  });
  await capability.sandbox.createSessionEnv({ id: 'thread-1' });

  assert.deepEqual(
    await capability.tool.run({
      input: {
        path: '/workspace/proof.png',
        filename: 'proof.png',
      },
    }),
    { uploaded: true },
  );
  assert.equal(readPaths.length, 1);
  assert.match(
    readPaths[0] ?? '',
    /^\.chickpea-artifact-[a-f0-9]{32}\.tmp$/,
  );

  await assert.rejects(
    async () =>
      capability.tool.run({
        input: {
          path: '/workspace/../secret',
          filename: 'secret',
        },
      }),
    /normalized file under \/workspace/,
  );
});
