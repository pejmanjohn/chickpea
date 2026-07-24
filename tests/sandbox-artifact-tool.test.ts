import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SandboxFactory, SessionEnv } from '@flue/runtime';

import {
  createWorkspaceArtifactCapability,
  MAX_ARTIFACT_BYTES,
} from '../src/sandbox/artifact-tool.ts';

function fakeSessionEnv(
  readPaths: string[],
  statPaths: string[] = [],
  size = 3,
): SessionEnv {
  return {
    cwd: '/workspace',
    resolvePath(path) {
      return path;
    },
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async readFile() {
      return '';
    },
    async readFileBuffer(path) {
      readPaths.push(path);
      return new Uint8Array([1, 2, 3]);
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
    async rm() {},
  };
}

test('workspace artifact tool reads through SessionEnv and binds the Slack destination', async () => {
  const readPaths: string[] = [];
  const statPaths: string[] = [];
  const uploads: unknown[] = [];
  const base: SandboxFactory = {
    async createSessionEnv() {
      return fakeSessionEnv(readPaths, statPaths);
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
  assert.deepEqual(statPaths, ['/workspace/proof.png']);
  assert.deepEqual(readPaths, ['/workspace/proof.png']);
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
  assert.deepEqual(readPaths, ['proof.png']);

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
