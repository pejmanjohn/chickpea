import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SandboxFactory, SessionEnv } from '@flue/runtime';

import {
  buildArtifactToolsInstruction,
  createWorkspaceArtifactCapability,
  MAX_ARTIFACT_BYTES,
} from '../src/sandbox/artifact-tool.ts';
import { GENERATE_IMAGE_TOOL_NAME } from '../src/sandbox/image-tool.ts';
import { buildThreadImageInventory } from '../src/slack/thread-images.ts';

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
    async stageArtifact(input) {
      uploads.push(input);
      return { attached: true, byteLength: input.bytes.byteLength };
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

  assert.deepEqual(result, { output: { attached: true, filename: 'proof.png', byteLength: 3 } });
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
  // The tool hands the host only the bytes and the model's naming; the frozen
  // Slack destination is bound by the host receipt, never by tool input.
  assert.deepEqual(uploads, [
    {
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'proof.png',
      title: 'Proof',
      kind: 'file',
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
    async stageArtifact(input) {
      uploads.push(input);
      return { attached: true, byteLength: input.bytes.byteLength };
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
    async stageArtifact(input) {
      uploadedBytes = input.bytes.byteLength;
      return { attached: true, byteLength: input.bytes.byteLength };
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
    async stageArtifact(input) {
      uploads.push(input);
      return { attached: true, byteLength: input.bytes.byteLength };
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
    async stageArtifact(input) {
      return { attached: true, byteLength: input.bytes.byteLength };
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
    async stageArtifact(input) {
      return { attached: true, byteLength: input.bytes.byteLength };
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
    { output: { attached: true, filename: 'proof.png', byteLength: 3 } },
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
    async stageArtifact(input) {
      uploads.push({ bytes: input.bytes, filename: input.filename });
      return { attached: true, byteLength: input.bytes.byteLength };
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
  assert.deepEqual(textResult, {
    output: { attached: true, filename: 'bookings.csv', byteLength: new TextEncoder().encode(csv).byteLength },
  });
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
    async stageArtifact(input) {
      uploads.push(input);
      return { attached: true, byteLength: input.bytes.byteLength };
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
    async stageArtifact(input) {
      uploads.push(input);
      return { attached: true, byteLength: input.bytes.byteLength };
    },
  });
  const env = fakeSessionEnv(readPaths, [], 3);
  const result = await tool.run({
    ...TOOL_RUN_CONTEXT,
    data: { path: '/home/user/summary.json', filename: 'summary.json' },
    harness: { sandbox: env },
  } as never);
  assert.deepEqual(result, { output: { attached: true, filename: 'summary.json', byteLength: 3 } });
  assert.deepEqual(readPaths, ['/home/user/summary.json']);
  assert.equal(uploads.length, 1);
});


const MANIFEST = buildThreadImageInventory({
  conversationKey: 'T_TEST:C_TEST:1787000000.000100',
  threadRecords: [{
    conversationKey: 'T_TEST:C_TEST:1787000000.000100',
    fileId: 'F0IMAGE1',
    origin: 'person',
    filename: 'logo.png',
    mimeType: 'image/png',
    messageTs: '1787000000.000200',
  }],
}).manifest;

test('the image-capable instruction names the tool, handles, and the call rules', () => {
  const instruction = buildArtifactToolsInstruction({ imageTool: true, canEdit: true });
  assert.match(instruction, new RegExp(`\`${GENERATE_IMAGE_TOOL_NAME}\``));
  assert.match(instruction, /`img:N` handle/);
  assert.match(instruction, /at most 4 images across every `generate_image` call/);
  assert.match(instruction, /make one call with count/);
  assert.match(instruction, /one call per subject/);
  // Live QA: "3 variations" wording carried into the image prompt made each file a collage.
  assert.match(instruction, /describe one single image in the prompt and never mention variations/);
  assert.match(instruction, /before declaring a streamed answer/);
  assert.match(instruction, /locks out every later tool call/);
  assert.match(instruction, /names the model, size, and format the provider applied/);
  // The result promises no handle for the new image; the next turn lists it.
  assert.match(
    instruction,
    /appears in the next turn’s listing with origin=agent under the filename you chose/,
  );
  assert.doesNotMatch(instruction, /its own `img:N` handle/);
  assert.doesNotMatch(instruction, /intent/);
  // The frozen denial is gone; the rest of the artifact contract is unchanged.
  assert.doesNotMatch(instruction, /do not claim a general image-generation or SVG-to-PNG capability/);
  assert.doesNotMatch(instruction, /PNG charts are built in/);
  assert.match(instruction, /Use `render_chart` for charts, graphs, plots, or images of numbers/);
  assert.match(instruction, /If the reason is too-large, explain the returned size limit/);
  assert.match(instruction, /Never claim a file is attached without an attached: true tool result\./);
});

test('with no image model the instruction states the limit, Settings, and the substitutes', () => {
  const instruction = buildArtifactToolsInstruction({ imageTool: false, canEdit: false });
  assert.match(instruction, /no image model set up/);
  assert.match(instruction, /say that first, before offering anything else/);
  assert.match(instruction, /an Owner enables it in Settings → Model providers \(Default image model\)/);
  assert.match(instruction, /a chart PNG with `render_chart`/);
  assert.match(instruction, /an SVG mockup or diagram with `post_artifact`/);
  assert.match(instruction, /written copy in the reply/);
  assert.match(
    instruction,
    /Never describe an SVG mockup, diagram, or chart as a finished, generated, or edited image/,
  );
  assert.doesNotMatch(instruction, new RegExp(GENERATE_IMAGE_TOOL_NAME));
  assert.doesNotMatch(instruction, /img:N/);
  assert.doesNotMatch(instruction, /do not claim a general image-generation or SVG-to-PNG capability/);
});

test('a generate-only image model discloses that it cannot edit before offering generation', () => {
  const instruction = buildArtifactToolsInstruction({ imageTool: true, canEdit: false });
  assert.match(
    instruction,
    /can generate a new image but cannot edit, retouch, or combine an image that is already here/,
  );
  assert.match(instruction, /say that plainly first, then offer to generate a new image/);
  assert.doesNotMatch(instruction, /intent/);
  // The disclosure precedes the offer to generate instead of trailing it.
  assert.ok(
    instruction.indexOf('cannot edit, retouch, or combine') <
      instruction.indexOf('offer to generate a new image'),
  );
});

test('the image-capable instruction names every failure reason honestly', () => {
  const instruction = buildArtifactToolsInstruction({ imageTool: true, canEdit: true });
  // Every reason `generate_image` can return, including the two an image can
  // never satisfy through the file wording that follows this paragraph.
  for (const reason of [
    'input-unavailable',
    'too-large',
    'rejected',
    'timeout',
    'missing-scope',
    'misconfigured',
    'limit',
  ]) {
    assert.match(instruction, new RegExp(`reason ${reason} means`), reason);
  }
  assert.match(instruction, /reason unavailable carries a source/);
  for (const detail of ['not_found', 'transport', 'missing_scope', 'unsupported_type', 'too_large']) {
    assert.match(instruction, new RegExp(`detail ${detail} means`), detail);
  }
  // The live lane could not tell an unreachable provider from a file that
  // would not attach; the instruction now forces the reply to say which.
  assert.match(
    instruction,
    /source provider means the image provider rejected the request or could not be reached/,
  );
  assert.match(
    instruction,
    /source staging means the image was produced but the file could not be attached through this Slack connection/,
  );
  assert.match(
    instruction,
    /Never report an unavailable result without saying which of those two happened\./,
  );
  assert.match(instruction, /the result’s detail says why; say what the detail means in plain words/);
  assert.match(instruction, /never claim to include the image’s content in the reply/);
  // The generic file wording must not claim a provider failure was a Slack one.
  assert.match(
    instruction,
    /If `render_chart` or `post_artifact` reports reason unavailable, say file attachments are temporarily unavailable/,
  );
  assert.match(
    instruction,
    /reason missing-scope means this workspace does not permit Slack file uploads: say an Owner needs to grant that permission and never claim an image was attached/,
  );
  assert.match(instruction, /detail unsupported_type means that file type cannot be used as an image input: ask for a PNG, JPEG, or WebP instead/);
  assert.match(instruction, /never say an image was generated, attached, or edited/);
  assert.match(
    instruction,
    /ask the member who shared it to re-upload it in this conversation/,
  );
  assert.match(instruction, /do not retry that handle or describe the edit as done/);
  assert.match(
    instruction,
    /exceeded this workspace’s upload limit even after compression: say so and offer a simpler image instead of claiming an attachment/,
  );
});

test('a listed handle survives a failed attachment analysis in the instruction', () => {
  const instruction = buildArtifactToolsInstruction({
    imageTool: true,
    canEdit: true,
    imageManifest: MANIFEST,
  });
  // The live lane stopped at "the attachment failed" while img:1 was listed
  // and usable; the two rules have to compose.
  assert.match(
    instruction,
    /stays usable even when the attachment manifest reports that same file’s analysis as failed/,
  );
  assert.match(
    instruction,
    /a failed analysis means its contents could not be read into this conversation, not that the file is missing/,
  );
  assert.match(
    instruction,
    new RegExp(`pass its handle to \`${GENERATE_IMAGE_TOOL_NAME}\` rather than saying the attachment failed or asking for a re-upload`),
  );
  // No such promise exists when there is no image tool to take the handle.
  assert.doesNotMatch(
    buildArtifactToolsInstruction({ imageTool: false, canEdit: false }),
    /stays usable even when the attachment manifest/,
  );
});

test('the image instruction renders the turn manifest, or says the thread has none', () => {
  const withImages = buildArtifactToolsInstruction({
    imageTool: true,
    canEdit: true,
    imageManifest: MANIFEST,
  });
  // The inventory owns the listing's own header lines; the instruction only
  // introduces it and must keep the entries verbatim.
  assert.match(withImages, /Images already in this conversation:\n/);
  assert.ok(withImages.includes(MANIFEST));
  assert.match(withImages, /- handle=img:1 \| origin=person/);
  assert.match(withImages, /filename=.?logo\.png.? \| mime=image\/png/);
  assert.doesNotMatch(withImages, /F0IMAGE1/);
  assert.doesNotMatch(withImages, /No images are in this conversation yet/);

  for (const empty of [undefined, '', '   ']) {
    const withoutImages = buildArtifactToolsInstruction({
      imageTool: true,
      canEdit: true,
      ...(empty === undefined ? {} : { imageManifest: empty }),
    });
    assert.match(
      withoutImages,
      /No images are in this conversation yet, so there is no handle to reference this turn\./,
    );
    assert.doesNotMatch(withoutImages, /Images already in this conversation:/);
  }
});
