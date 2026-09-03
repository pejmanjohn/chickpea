import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EvidenceSafetyError,
  createEvidenceRun,
  writeFailureCapsule,
  writeRunSummary,
} from '../qa/live/safety/evidence.ts';

function roots(context: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-live-evidence-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, 'repository');
  const packageRoot = join(root, 'package');
  const evidenceRoot = join(root, 'private-evidence');
  mkdirSync(repositoryRoot);
  mkdirSync(packageRoot);
  mkdirSync(evidenceRoot);
  return { root, repositoryRoot, packageRoot, evidenceRoot };
}

const capsule = {
  schemaVersion: 'chickpea-live-failure/v1' as const,
  runId: 'run-evidence-001',
  result: 'fail' as const,
  variantId: 'LC04-V1-personal-read',
  stepId: 'observe-provider-binding',
  observerIds: ['connection.read', 'provider.read'] as const,
  expectedTokens: ['connection.owner_personal'] as const,
  observedTokens: [] as const,
  revisions: { before: 'revision-2', observed: 'revision-3' },
  attempt: 2,
  pollTiming: { attempts: 4, elapsedMs: 2_400, deadlineMs: 5_000 },
  upstreamErrorCategory: 'provider_unavailable' as const,
  cleanup: {
    beforeAliases: ['connection:run-owned:1'],
    afterAliases: ['connection:unresolved:1'],
  },
};

test('evidence creates one private run directory and no-overwrite files with strict modes', (context) => {
  const { repositoryRoot, packageRoot, evidenceRoot } = roots(context);
  const run = createEvidenceRun({
    parent: evidenceRoot,
    runId: capsule.runId,
    repositoryRoot,
    packageRoots: [packageRoot],
  });
  assert.equal(statSync(run.directory).mode & 0o777, 0o700);
  const file = writeFailureCapsule(run, capsule);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writeFailureCapsule(run, capsule), (error: unknown) =>
    error instanceof EvidenceSafetyError && error.code === 'EVIDENCE_EXISTS');
  assert.throws(() => createEvidenceRun({
    parent: evidenceRoot, runId: capsule.runId, repositoryRoot, packageRoots: [packageRoot],
  }), (error: unknown) => error instanceof EvidenceSafetyError && error.code === 'EVIDENCE_EXISTS');
});

test('evidence rejects repository/package roots and symlink aliases into them', (context) => {
  const { root, repositoryRoot, packageRoot } = roots(context);
  for (const parent of [repositoryRoot, packageRoot]) {
    assert.throws(() => createEvidenceRun({
      parent, runId: capsule.runId, repositoryRoot, packageRoots: [packageRoot],
    }), (error: unknown) => error instanceof EvidenceSafetyError && error.code === 'UNSAFE_EVIDENCE_ROOT');
  }
  const link = join(root, 'repo-alias');
  symlinkSync(repositoryRoot, link);
  assert.throws(() => createEvidenceRun({
    parent: link, runId: capsule.runId, repositoryRoot, packageRoots: [packageRoot],
  }), (error: unknown) => error instanceof EvidenceSafetyError && error.code === 'UNSAFE_EVIDENCE_ROOT');
});

test('failure capsules are diagnosable but reject extra fields, secrets, URLs, coordinates, and raw captures', (context) => {
  const { repositoryRoot, packageRoot, evidenceRoot } = roots(context);
  const run = createEvidenceRun({
    parent: evidenceRoot, runId: capsule.runId, repositoryRoot, packageRoots: [packageRoot],
  });
  for (const unsafe of [
    { ...capsule, body: 'private response' },
    { ...capsule, upstreamErrorCategory: 'Bearer xoxb-secret' },
    { ...capsule, stepId: 'https://private.example.test/setup' },
    { ...capsule, cleanup: { ...capsule.cleanup, beforeAliases: ['C012PRIVATE'] } },
    { ...capsule, screenshot: 'capture.png' },
    { ...capsule, stack: 'Error at private path' },
    { ...capsule, headers: { authorization: 'secret' } },
  ]) {
    assert.throws(() => writeFailureCapsule(run, unsafe as never), (error: unknown) =>
      error instanceof EvidenceSafetyError && ['UNSAFE_EVIDENCE', 'INVALID_EVIDENCE'].includes(error.code));
  }
});

test('accepted run summary contains only the portable allowlisted inventory', (context) => {
  const { repositoryRoot, packageRoot, evidenceRoot } = roots(context);
  const run = createEvidenceRun({
    parent: evidenceRoot, runId: 'run-summary-001', repositoryRoot, packageRoots: [packageRoot],
  });
  const path = writeRunSummary(run, {
    schemaVersion: 'chickpea-live-summary/v1',
    runId: 'run-summary-001',
    suite: 'smoke',
    manifestDigest: 'sha256:manifest',
    targetFingerprint: 'sha256:target',
    repositoryRevision: '0123456789abcdef',
    servingVersion: 'version-1',
    aggregate: 'pass',
    declaredVariantIds: ['LC01-V1-create-welcome'],
    executedVariantIds: ['LC01-V1-create-welcome'],
    primaryCounts: { pass: 1, fail: 0, blocked: 0, ambiguous: 0, infrastructure_error: 0 },
    cleanupCounts: { not_required: 0, pass: 1, failed: 0 },
    postflight: {
      targetIdentityMatches: true,
      missingCount: 0,
      unexpectedCount: 0,
      unresolvedCount: 0,
    },
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => writeRunSummary(run, {
    schemaVersion: 'chickpea-live-summary/v1',
    runId: 'run-summary-001',
    suite: 'smoke',
    manifestDigest: 'sha256:manifest',
    targetFingerprint: 'sha256:target',
    repositoryRevision: '0123456789abcdef',
    servingVersion: 'version-1',
    aggregate: 'pass',
    declaredVariantIds: [], executedVariantIds: [],
    primaryCounts: { pass: 1, fail: 0, blocked: 0, ambiguous: 0, infrastructure_error: 0 },
    cleanupCounts: { not_required: 0, pass: 1, failed: 0 },
    postflight: { targetIdentityMatches: true, missingCount: 0, unexpectedCount: 0, unresolvedCount: 0 },
    rawResponse: 'not allowed',
  } as never), (error: unknown) => error instanceof EvidenceSafetyError);
});

test('a passing summary rejects partial inventory, non-pass cases, cleanup failure, or dirty postflight', (context) => {
  const { repositoryRoot, packageRoot, evidenceRoot } = roots(context);
  const base = {
    schemaVersion: 'chickpea-live-summary/v1' as const,
    suite: 'case' as const,
    manifestDigest: 'sha256:manifest', targetFingerprint: 'sha256:target',
    repositoryRevision: '0123456789abcdef', servingVersion: 'version-1',
    aggregate: 'pass' as const,
    declaredVariantIds: ['LC01-V1-create-welcome'],
    executedVariantIds: ['LC01-V1-create-welcome'],
    primaryCounts: { pass: 1, fail: 0, blocked: 0, ambiguous: 0, infrastructure_error: 0 },
    cleanupCounts: { not_required: 0, pass: 1, failed: 0 },
    postflight: { targetIdentityMatches: true, missingCount: 0, unexpectedCount: 0, unresolvedCount: 0 },
  };
  const invalid = [
    { ...base, executedVariantIds: [] as string[], primaryCounts: { ...base.primaryCounts, pass: 0 }, cleanupCounts: { ...base.cleanupCounts, pass: 0 } },
    { ...base, primaryCounts: { ...base.primaryCounts, pass: 0, fail: 1 } },
    { ...base, cleanupCounts: { ...base.cleanupCounts, pass: 0, failed: 1 } },
    { ...base, postflight: { ...base.postflight, unresolvedCount: 1 } },
  ];
  invalid.forEach((summary, index) => {
    const runId = `run-invalid-summary-${index + 1}`;
    const run = createEvidenceRun({
      parent: evidenceRoot, runId, repositoryRoot, packageRoots: [packageRoot],
    });
    assert.throws(
      () => writeRunSummary(run, { ...summary, runId }),
      (error: unknown) => error instanceof EvidenceSafetyError && error.code === 'INVALID_EVIDENCE',
    );
  });
});
