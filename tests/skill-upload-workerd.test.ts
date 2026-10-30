import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { reserveVerificationPort } from '../scripts/lib/verification-ports.mjs';
import { buildZip, skillMarkdown } from './helpers/zip.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const WORKER_FIXTURE = join(ROOT, 'tests', 'fixtures', 'skill-upload', 'upload-worker.ts');

test('uploaded skill archives inflate under workerd, including the early stop for an oversized entry', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-skill-upload-workerd-'));
  const configPath = join(root, 'wrangler.json');
  const port = await reserveVerificationPort() as number;
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  const flagsSource = productionConfig.match(/"compatibility_flags"\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-skill-upload-workerd-probe',
    main: WORKER_FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: [...flagsSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]!),
  }, null, 2));

  const archive = buildZip([
    { path: 'skills/deflated/SKILL.md', content: skillMarkdown('deflated', 'Inflated by workerd.', 'Step one.\n'.repeat(2000)) },
    { path: 'skills/stored/SKILL.md', content: skillMarkdown('stored', 'Stored as-is.'), method: 0 },
    { path: 'skills/bomb/SKILL.md', content: skillMarkdown('bomb', 'Lies.', 'z'.repeat(4 * 1024 * 1024)), declaredSize: 2048 },
  ]);
  const worker = startWorker(configPath, port);
  try {
    const resolution = await postArchive(worker, port, archive);
    assert.deepEqual(resolution.skills.map(({ name, instructions }) => [name, instructions.length]), [
      ['deflated', 'Step one.\n'.length * 2000],
      ['stored', '# Steps\nDo the work.\n'.length],
    ]);
    assert.deepEqual(resolution.issues, [{
      path: 'upload.zip/skills/bomb', code: 'invalid_archive', message: 'This file does not match its declared size.',
    }]);
  } finally {
    await stopWorker(worker);
    rmSync(root, { recursive: true, force: true });
  }
});

interface WorkerHandle {
  child: ChildProcess;
  output(): string;
}

function startWorker(configPath: string, port: number): WorkerHandle {
  const child = spawn(
    WRANGLER,
    ['dev', '--config', configPath, '--port', String(port), '--inspector-port', '0'],
    { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  return { child, output: () => output };
}

async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      handle.child.kill('SIGKILL');
      resolve();
    }, 5_000);
    handle.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    handle.child.kill('SIGTERM');
  });
}

async function postArchive(handle: WorkerHandle, port: number, archive: Uint8Array<ArrayBuffer>): Promise<{
  skills: Array<{ name: string; instructions: string }>;
  issues: Array<{ path: string; code: string; message: string }>;
}> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: archive });
      if (response.ok) return await response.json() as Awaited<ReturnType<typeof postArchive>>;
      throw new Error(`worker answered ${response.status}: ${await response.text()}\n${handle.output()}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('worker answered')) throw error;
      // wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev never served the probe:\n${handle.output()}`);
}
