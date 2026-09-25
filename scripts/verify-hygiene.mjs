#!/usr/bin/env node
/**
 * Source hygiene in seconds: everything the release gate can prove from a
 * commit before installing or building anything. Runs first in every
 * `verify:regression` plan, in the pre-push hook, and inside `verify:oss-export`.
 *
 *   npm run verify:hygiene                     # HEAD, from a fresh git archive
 *   npm run verify:hygiene -- --revision SHA   # any commit, e.g. each pushed ref
 *   npm run verify:hygiene -- --working-tree   # index paths with working-tree bytes
 *
 * Checks: tracked manifest safety, forbidden public-source paths and private
 * docs, tracked docs deliberately un-ignored, archive bytes equal tracked blobs,
 * leak scan (private names, local user paths, binaries, verifier secrets),
 * live-verification docs references (every backticked or linked `.md` in the
 * skill entrypoints and qa/live/operator names a tracked file), the tracked
 * .mcp.json allowlist (only the lane browser servers through
 * scripts/lane-browser.mjs), release manifest and version agreement, lockfile
 * integrity hashes, package metadata, the authentication export contract, and
 * the npm pack manifest.
 * Exit 1 on any finding, 2 on a usage or structural error.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource } from './lib/source-export-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseHygieneArgs(argv) {
  const options = { revision: 'HEAD', workingTree: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--working-tree') { options.workingTree = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--revision') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error('--revision requires a commit');
      options.revision = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.workingTree && options.revision !== 'HEAD') throw new Error('--working-tree scans the index; it cannot combine with --revision');
  return options;
}

export function formatHygieneReport(result, { workingTree, revision }) {
  const lines = [];
  for (const { name, findings, durationMs } of result.checks) {
    lines.push(`  ${findings.length === 0 ? 'ok  ' : 'FAIL'} ${name} (${durationMs} ms)`);
    for (const finding of findings) lines.push(`       ${finding}`);
  }
  const target = workingTree ? 'index and working tree' : `${revision} (${result.sourceCommit ?? 'unresolved'})`;
  lines.push(result.ok
    ? `Hygiene passed for ${target} in ${result.durationMs} ms.`
    : `Hygiene failed for ${target}: ${result.checks.filter(({ findings }) => findings.length).map(({ name }) => name).join(', ')}.`);
  return lines.join('\n');
}

export function main(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: npm run verify:hygiene -- [--revision REV] [--working-tree] [--json]\nFast source hygiene for one commit (default HEAD) or the index plus working tree. No install, build, or network.');
    return 0;
  }
  let options;
  try { options = parseHygieneArgs(argv); } catch (error) { console.error(error.message); return 2; }
  let result;
  try {
    result = inspectSource({ root: ROOT, revision: options.revision, workingTree: options.workingTree });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.json) {
    console.log(JSON.stringify({ ok: result.ok, sourceCommit: result.sourceCommit, entries: result.entries.length, durationMs: result.durationMs, checks: result.checks }, null, 2));
  } else {
    console.log(formatHygieneReport(result, options));
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
