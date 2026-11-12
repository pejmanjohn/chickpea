#!/usr/bin/env node
/**
 * `npm run test:mcp`: the per-PR fast check for the management MCP program.
 * It covers the 5.0 tools, the cards' models and renders, test runs, the
 * confirmations and tool policies behind them, and the Worker startup budget.
 * It does not replace the full suite (`npm test`), which a train still needs.
 *
 * A test file joins by its name. Any file matching a pattern below is in, so
 * a new tests/management-*.test.ts, tests/mcp-*.test.ts or
 * tests/test-run-*.test.ts runs here with no edit. A file with another name
 * joins by adding its path to the list. Every pattern must match at least one
 * file: a rename or a typo stops the run instead of shrinking the subset.
 *
 * Files named `*-workerd.test.ts` start `wrangler dev`, which needs a host
 * reservation (qa/live/operator/host-checks.md). They stay in the full suite,
 * so this check runs anywhere without waiting for a slot.
 *
 * Its arguments go to scripts/run-tests.mjs ahead of the files (--typecheck,
 * --fail-on-retry). `--list` prints the selected files and runs nothing.
 */
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_TEST_PATTERNS = [
  // The management service and MCP server: the 5.0 tools and the answers to
  // removed 4.x names, the card host, confirmations, undo, proposals, previews
  // and the write rules MCP shares with Admin.
  'tests/management-*.test.ts',
  // The cards' models and renders, MCP OAuth and clients, tool policy.
  'tests/mcp-*.test.ts',
  // Test runs and the read-only test turn they start.
  'tests/test-run-*.test.ts',
  'tests/test-turn-*.test.ts',
  // The change tools the management service applies.
  'tests/workspace-change-tools.test.ts',
  // A test run's model access, its call limit and fee, and its Usage rows.
  'tests/model-access.test.ts',
  'tests/run-fees-flue.test.ts',
  'tests/admin-usage-report.test.ts',
  // The startup budget every program PR has grown.
  'tests/worker-startup-imports.test.ts',
];

const HOST_RESERVED = /-workerd\.test\.ts$/;

/** The selected test files, sorted; throws naming every pattern that matched nothing. */
export function selectMcpTests(root, patterns = MCP_TEST_PATTERNS) {
  const empty = [];
  const files = new Set();
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd: root }).filter((file) => !HOST_RESERVED.test(file));
    if (matches.length === 0) empty.push(pattern);
    for (const file of matches) files.add(file);
  }
  if (empty.length > 0) {
    throw new Error(`test:mcp patterns match no test file: ${empty.join(', ')}. ` +
      'Fix or remove each in scripts/test-mcp.mjs.');
  }
  return [...files].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  try {
    const files = selectMcpTests(root);
    if (args.includes('--list')) {
      console.log(files.join('\n'));
    } else {
      console.log(`[test:mcp] ${files.length} files`);
      const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', ...args, ...files], { cwd: root, stdio: 'inherit' });
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
