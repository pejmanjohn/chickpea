import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Test tooling JavaScript helper.
import { MCP_TEST_PATTERNS, selectMcpTests } from '../scripts/test-mcp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('test:mcp selects the program\'s test files by name and leaves the workerd ones to the full suite', () => {
  const files: string[] = selectMcpTests(ROOT);
  for (const file of [
    'tests/management-mcp-v5-writes.test.ts', 'tests/mcp-agent-card-model.test.ts', 'tests/test-run-tools.test.ts',
    'tests/test-turn-mounts.test.ts', 'tests/management-policy.test.ts', 'tests/mcp-tool-policy.test.ts',
    'tests/management-provider-handoff.test.ts', 'tests/management-receipts.test.ts', 'tests/workspace-change-tools.test.ts',
    'tests/model-access.test.ts', 'tests/run-fees-flue.test.ts', 'tests/admin-usage-report.test.ts',
    'tests/worker-startup-imports.test.ts',
  ]) assert.ok(files.includes(file), file);
  assert.deepEqual(files.filter((file) => file.endsWith('-workerd.test.ts')), []);
  assert.deepEqual(files, [...new Set(files)].sort());
});

test('a test:mcp pattern that matches nothing stops the run instead of passing empty', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-test-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests/mcp-one.test.ts'), '');
  writeFileSync(join(root, 'tests/mcp-host-workerd.test.ts'), '');
  assert.deepEqual(selectMcpTests(root, ['tests/mcp-*.test.ts']), ['tests/mcp-one.test.ts']);
  assert.throws(() => selectMcpTests(root, ['tests/mcp-*.test.ts', 'tests/renamed.test.ts', 'tests/test-run-*.test.ts']),
    /match no test file: tests\/renamed\.test\.ts, tests\/test-run-\*\.test\.ts\. Fix or remove each in scripts\/test-mcp\.mjs/);
  // A pattern whose only match needs a host reservation is empty here too.
  assert.throws(() => selectMcpTests(root, ['tests/mcp-host-*.test.ts']), /match no test file/);
  assert.ok(MCP_TEST_PATTERNS.length > 0);
});

test('--list prints the selection and runs nothing', () => {
  const listed = spawnSync(process.execPath, ['scripts/test-mcp.mjs', '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n'), selectMcpTests(ROOT));
});
