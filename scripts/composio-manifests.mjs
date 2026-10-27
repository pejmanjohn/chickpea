#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseComposioManifest } from '../src/connections/catalog/composio-manifests.ts';
import {
  MANIFEST_DIRECTORY,
  SNAPSHOT_DIRECTORY,
  checkComposioManifestDirectory,
  draftComposioManifest,
  fetchComposioToolkit,
  readSnapshot,
  renderDraftReport,
  reviewedTools,
  snapshotFromComposio,
} from './lib/composio-manifests.ts';

const USAGE = `Usage:
  npm run connectors:composio -- snapshot <toolkit> --from <export-directory>
  npm run connectors:composio -- snapshot <toolkit> --fetch   (reads COMPOSIO_API_KEY; GET requests only)
  npm run connectors:composio -- draft <toolkit> [--report <file>] [--validation-arguments <json>]
  npm run connectors:composio -- check`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    fetch: { type: 'boolean' },
    report: { type: 'string' },
    'validation-arguments': { type: 'string' },
  },
});
const [command, toolkit] = positionals;

if (command === 'check') {
  const problems = await checkComposioManifestDirectory();
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log('Composio manifests match their pinned snapshots.');
} else if (command === 'snapshot' && toolkit && (values.fetch || values.from)) {
  const previous = await readManifest(toolkit);
  const [detail, tools] = values.fetch
    ? await fetchComposio(toolkit)
    : await readComposioExport(values.from, toolkit);
  const snapshot = snapshotFromComposio(detail, tools, new Set(previous ? reviewedTools(previous) : []));
  const directory = path.join(SNAPSHOT_DIRECTORY, toolkit);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${snapshot.toolkit.version}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), file)} with ${snapshot.tools.length} tools.`);
} else if (command === 'draft' && toolkit) {
  const versions = (await readdir(path.join(SNAPSHOT_DIRECTORY, toolkit)).catch(() => []))
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (versions.length !== 1) {
    throw new Error(`Expected exactly one snapshot for ${toolkit}; run the snapshot command first`);
  }
  const snapshot = await readSnapshot(toolkit, versions[0].slice(0, -'.json'.length));
  const validationArguments = values['validation-arguments'] === undefined
    ? undefined : JSON.parse(values['validation-arguments']);
  const { manifest, report } = draftComposioManifest(snapshot, await readManifest(toolkit), { validationArguments });
  await writeFile(
    path.join(MANIFEST_DIRECTORY, `${toolkit}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const text = renderDraftReport(report);
  if (values.report) await writeFile(values.report, text);
  else process.stdout.write(text);
} else {
  console.error(USAGE);
  process.exit(2);
}

async function readManifest(name) {
  const raw = await readFile(path.join(MANIFEST_DIRECTORY, `${name}.json`), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  return raw === undefined ? undefined : parseComposioManifest(JSON.parse(raw));
}

async function readComposioExport(directory, name) {
  return Promise.all([
    readFile(path.join(directory, 'composio-details', `${name}.json`), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'composio-tools', `${name}.json`), 'utf8').then(JSON.parse),
  ]);
}

async function fetchComposio(name) {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
  return fetchComposioToolkit(name, apiKey);
}
