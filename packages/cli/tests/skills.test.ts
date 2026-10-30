import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { FakeDeployment, fakeBrowser } from './helpers/fake-deployment.ts';
import { runCli, temporaryStore, type CliRun } from './helpers/run-cli.ts';

type UploadedFile = { name: string; text?: string; base64?: string };

const deployment = new FakeDeployment({
  tools: {
    upload_skills: (args) => {
      const files = args.files as UploadedFile[];
      const conflicts = files.filter(({ name }) => name.startsWith('conflict')).map(() => ({ name: 'alpha', path: 'conflict.md' }));
      return {
        ok: true,
        result: {
          status: conflicts.length ? 'unchanged' : 'updated',
          conflicts,
          presentation: { markdown: `Received ${files.map(({ name }) => name).join(', ')}.` },
          links: { admin: 'http://127.0.0.1:9/admin/agents/agent_support' },
        },
      };
    },
  },
});
const store = temporaryStore();
const dir = mkdtempSync(path.join(tmpdir(), 'chickpea-skills-'));

function fixture(name: string, content: string | Uint8Array): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

before(async () => {
  await deployment.start();
  const login = await runCli(['login', deployment.url], { store, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
});
after(() => deployment.stop());

function upload(argv: string[]): Promise<CliRun> {
  return runCli(['skills', 'upload', deployment.url, 'agent_support', ...argv], { store });
}

function uploadCalls(since: number): UploadedFile[][] {
  return deployment.toolCalls.slice(since)
    .filter(({ name }) => name === 'upload_skills')
    .map(({ args }) => args.files as UploadedFile[]);
}

test('skills upload sends markdown as exact text and an archive as base64 in one call', async () => {
  const markdown = '---\nname: alpha\ndescription: First skill.\n---\nDo the work. Ünïcode stays.\n';
  const archive = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0), 0xff]);
  const calls = deployment.toolCalls.length;
  const result = await upload([fixture('SKILL.md', markdown), fixture('skills.zip', archive)]);
  assert.equal(result.code, 0, result.stderr);
  const call = deployment.toolCalls.at(-1)!;
  assert.equal(deployment.toolCalls.length, calls + 1);
  assert.equal(call.name, 'upload_skills');
  assert.equal(call.args.agentId, 'agent_support');
  assert.match(String(call.args.idempotencyKey), /^cli-skills-upload-[0-9a-f-]{36}$/);
  assert.equal(call.args.replaceExisting, undefined);
  assert.deepEqual(call.args.files, [
    { name: 'SKILL.md', text: markdown },
    { name: 'skills.zip', base64: Buffer.from(archive).toString('base64') },
  ]);
  assert.equal(result.stdout, 'Received SKILL.md, skills.zip.\nAgent in Admin: http://127.0.0.1:9/admin/agents/agent_support\n');
});

test('--replace asks the deployment to replace conflicts, and a conflict says how', async () => {
  const conflicted = await upload([fixture('conflict.md', '# Alpha\n')]);
  assert.equal(conflicted.code, 0, conflicted.stderr);
  assert.match(conflicted.stderr, /^To replace alpha, run the same command with --replace\.$/m);
  assert.equal(deployment.toolCalls.at(-1)!.args.replaceExisting, undefined);

  const replaced = await upload([fixture('conflict.md', '# Alpha\n'), '--replace']);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(deployment.toolCalls.at(-1)!.args.replaceExisting, true);
});

test('files that together pass the request cap go in separate calls', async () => {
  const calls = deployment.toolCalls.length;
  const big = 'x'.repeat(600 * 1024);
  const result = await upload([fixture('one.md', big), fixture('two.md', big), fixture('three.md', '# Small\n')]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(uploadCalls(calls).map((files) => files.map(({ name }) => name)), [['one.md'], ['two.md', 'three.md']]);
});

test('a single file over the request cap or an unsupported file is refused before any call', async () => {
  const calls = deployment.toolCalls.length;
  const huge = await upload([fixture('huge.zip', new Uint8Array(800 * 1024)), fixture('SKILL.md', '# Fine\n')]);
  assert.equal(huge.code, 1);
  assert.match(huge.stderr, /^chickpea: FILE_TOO_LARGE: huge\.zip is \d+ KB once encoded, over the \d+ KB one call carries/);
  assert.ok(huge.stderr.includes(`Upload it in Admin instead: open ${deployment.url}/admin/agents/agent_support, then Skills, then Upload.`), huge.stderr);

  const text = await upload([fixture('notes.txt', 'plain')]);
  assert.equal(text.code, 1);
  assert.match(text.stderr, /^chickpea: INVALID_ARGUMENT: notes\.txt is not a skill file/);

  const missing = await upload([]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^chickpea: MISSING_ARGUMENT: An Agent id and at least one file are required/);
  assert.equal(deployment.toolCalls.length, calls);
});
