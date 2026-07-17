import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The preflight both `npm test` (pretest) and `npm run flue:build` run before
// the node lane. It must FAIL LOUDLY when a Cloudflare build was interrupted
// and left src/db.ts parked as src/db.ts.node-lane. Driven against a scratch
// --root so it never touches the real checkout.
const GUARD = fileURLToPath(new URL('../scripts/preflight-node-lane.mjs', import.meta.url));

function runGuard(root: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [GUARD, '--root', root], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

test('node-lane preflight fails loudly with a recovery hint when db.ts is parked', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-parked-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'db.ts.node-lane'), '// parked by an interrupted CF build\n');

    const { status, stderr } = runGuard(root);
    assert.equal(status, 1, 'the guard must exit non-zero when db.ts is parked');
    assert.match(stderr, /db\.ts\.node-lane/);
    // A one-line, actionable recovery hint.
    assert.match(stderr, /mv src\/db\.ts\.node-lane src\/db\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node-lane preflight passes when db.ts is not parked', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-unparked-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'db.ts'), 'export {};\n');

    const { status } = runGuard(root);
    assert.equal(status, 0, 'the guard must exit zero on a healthy node lane');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
