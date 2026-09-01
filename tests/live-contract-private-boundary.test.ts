import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runLiveCli } from '../qa/live/cli.ts';
import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from '../qa/live/manifest.ts';
import { assertPublicData, validateTargetOverlay } from '../qa/live/privacy.ts';
import { createEvidenceRun } from '../qa/live/safety/evidence.ts';

test('live suite entrypoints stop before reading private inputs when required files are absent', () => {
  const stdout: string[] = [];
  let reads = 0;
  const exit = runLiveCli(['smoke'], {
    stdout: (value) => stdout.push(value),
    stderr: () => undefined,
    readJson: () => {
      reads += 1;
      throw new Error('should not read');
    },
  });
  assert.equal(exit, 64);
  assert.equal(reads, 0);
  assert.deepEqual(JSON.parse(stdout.join('')), { kind: 'error', code: 'REQUIRED_TARGET' });
});

test('doctor reports an invalid alias-only overlay without invoking a live coordinator', () => {
  const files: Record<string, unknown> = {
    target: { schemaVersion: 'chickpea-live-target/v1' },
    snapshot: {
      schemaVersion: 'chickpea-live-doctor-snapshot/v1',
      manifestDigest: LIVE_MANIFEST_DIGEST,
      targetFingerprint: 'sha256:target-fixture',
      repositoryRevision: 'revision-fixture',
      servingVersion: 'version-fixture',
      missingActorAliases: [],
      workspaceMatches: true,
      unavailableObserverIds: [],
      evidenceRootSafe: true,
      targetMatches: true,
      lock: { status: 'clear' },
    },
  };
  const stdout: string[] = [];
  const exit = runLiveCli(
    ['doctor', '--target', 'target', '--snapshot', 'snapshot'],
    {
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      readJson: (path) => files[path],
    },
  );
  const record = JSON.parse(stdout.join('')) as {
    kind: string;
    ready: boolean;
    diagnostics: Array<{ code: string }>;
  };
  assert.equal(exit, 2);
  assert.equal(record.kind, 'doctor');
  assert.equal(record.ready, false);
  assert.deepEqual(record.diagnostics.map(({ code }) => code), ['invalid_target_overlay']);
});

test('public data rejects coordinates, secrets, content captures, local paths, and unknown fixtures', () => {
  for (const input of [
    { workspaceId: 'private-workspace-coordinate' },
    { apiToken: 'not-a-real-token' },
    { rawTranscript: 'private conversation' },
    { screenshot: 'capture.png' },
    { output: ['', 'Users', 'example', 'private-evidence'].join('/') },
  ]) {
    assert.throws(() => assertPublicData(input));
  }

  const example = JSON.parse(readFileSync(
    new URL('../qa/live/target.example.json', import.meta.url),
    'utf8',
  )) as Record<string, any>;
  assert.doesNotThrow(() => validateTargetOverlay(LIVE_MANIFEST, example));
  example.fixtures['unclassified-fixture'] = {
    kind: 'database',
    resourceAlias: 'not-classified',
  };
  assert.throws(() => validateTargetOverlay(LIVE_MANIFEST, example));
});

test('evidence root inside the repository or package root is rejected', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-live-boundary-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createEvidenceRun({ parent: root, runId: 'run-boundary', repositoryRoot: root }),
    /UNSAFE_EVIDENCE_ROOT/,
  );
});
