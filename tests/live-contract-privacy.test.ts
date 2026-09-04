import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compileLiveCatalog } from '../qa/live/compiler.ts';
import { PUBLIC_LIVE_CATALOG } from '../qa/live/cases/index.ts';
import {
  assertPublicData,
  LiveContractValidationError,
  requiredActorAliasesForTarget,
  requiredObserverIdsForTarget,
  validateTargetOverlay,
} from '../qa/live/privacy.ts';
import { validateGitHubSourceBinding } from '../qa/live/public-sources.ts';

const manifest = compileLiveCatalog(PUBLIC_LIVE_CATALOG);
const targetExample = JSON.parse(readFileSync(new URL('../qa/live/target.example.json', import.meta.url), 'utf8')) as unknown;

test('the alias-only Phase 1 target binds the exact smoke inventory without credentials', () => {
  const target = validateTargetOverlay(manifest, targetExample);
  assert.equal(target.targetAlias, 'amber');
  assert.notEqual(target.bindings['LC04-V1-personal-read']?.fixtures.agent,
    target.bindings['LC01-V2-update-approve']?.fixtures.agent);
  assert.deepEqual(Object.keys(target.bindings).sort(), [...manifest.requiredVariants.smoke].sort());
  assert.deepEqual(target.allowedSuites, ['case', 'smoke']);
  assert.equal(target.fixtures['qa-routine'], undefined);
  assert.equal(JSON.stringify(target).includes('xoxb-'), false);
});

test('a private overlay cannot add, omit, downgrade, or redefine manifest variants', () => {
  const base = structuredClone(targetExample) as Record<string, unknown>;
  const bindings = (base.bindings ?? {}) as Record<string, unknown>;

  const added = structuredClone(base);
  (added.bindings as Record<string, unknown>)['LC99-V1-private'] = { fixtures: {} };
  assertCode(() => validateTargetOverlay(manifest, added), 'OVERLAY_VARIANT_MISMATCH');

  const omitted = structuredClone(base);
  delete (omitted.bindings as Record<string, unknown>)[Object.keys(bindings)[0]!];
  assertCode(() => validateTargetOverlay(manifest, omitted), 'OVERLAY_VARIANT_MISMATCH');

  for (const attemptedField of ['required', 'actionId']) {
    const redefined = structuredClone(base);
    const first = Object.values(redefined.bindings as Record<string, Record<string, unknown>>)[0]!;
    first[attemptedField] = attemptedField === 'required' ? false : 'agent.delete';
    assertCode(() => validateTargetOverlay(manifest, redefined), 'UNKNOWN_FIELD');
  }
});

test('a target may bind one nonempty manifest subset without redefining it', () => {
  const subset = structuredClone(targetExample) as Record<string, any>;
  const variantId = 'LC01-V1-create-welcome';
  subset.allowedSuites = ['case'];
  subset.allowedVariants = [variantId];
  subset.bindings = { [variantId]: subset.bindings[variantId] };

  const target = validateTargetOverlay(manifest, subset);
  assert.deepEqual(target.allowedVariants, [variantId]);
  assert.deepEqual(Object.keys(target.bindings), [variantId]);
  assert.deepEqual(requiredActorAliasesForTarget(manifest, target), ['owner-browser-profile']);
  assert.deepEqual(requiredObserverIdsForTarget(manifest, target), ['agent.read', 'slack.messages.read']);

  subset.allowedVariants = ['LC99-V1-private'];
  assertCode(() => validateTargetOverlay(manifest, subset), 'INVALID_VALUE');
});

test('public target contracts remain role-agnostic while the example declares Phase 1 policy', () => {
  const continuation = structuredClone(targetExample) as Record<string, unknown>;
  continuation.targetAlias = 'dedicated-qa';
  continuation.allowedSuites = ['case', 'smoke', 'deep'];
  assert.deepEqual(validateTargetOverlay(manifest, continuation).allowedSuites, ['case', 'smoke', 'deep']);

  const phaseOne = structuredClone(targetExample) as Record<string, unknown>;
  phaseOne.targetAlias = 'amber';
  assert.deepEqual(validateTargetOverlay(manifest, phaseOne).allowedSuites, ['case', 'smoke']);
});

test('public and target data reject secret, executable, private, and raw-content fields without echoing values', () => {
  const sentinel = 'xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwxyz';
  const invalid: Array<[unknown, string]> = [
    [{ apiToken: sentinel }, 'SECRET_FIELD'],
    [{ harmless: sentinel }, 'SECRET_VALUE'],
    [{ cookie: 'session=private' }, 'SECRET_FIELD'],
    [{ setupCapability: 'write' }, 'EXECUTABLE_FIELD'],
    [{ command: 'rm something' }, 'EXECUTABLE_FIELD'],
    [{ dynamicImport: './adapter.ts' }, 'EXECUTABLE_FIELD'],
    [{ modulePath: './adapter.ts' }, 'EXECUTABLE_FIELD'],
    [{ rawTranscript: 'private words' }, 'RAW_CONTENT_FIELD'],
    [{ screenshot: 'proof.png' }, 'RAW_CONTENT_FIELD'],
    [{ workspaceId: 'T01234567' }, 'PRIVATE_COORDINATE'],
    [{ localPath: ['', 'Users', 'example', 'private'].join('/') }, 'ABSOLUTE_PATH'],
    [{ endpoint: 'https://example.invalid/action' }, 'FREEFORM_URL'],
    [{ handler: () => undefined }, 'DATATYPE_NOT_ALLOWED'],
  ];

  for (const [value, expectedCode] of invalid) {
    let observed: unknown;
    try {
      assertPublicData(value);
    } catch (error) {
      observed = error;
    }
    assert.equal(observed instanceof LiveContractValidationError, true);
    assert.equal((observed as LiveContractValidationError).code, expectedCode);
    assert.doesNotMatch((observed as Error).message, /xoxb-|private words|example\/private/);
  }
});

test('private source bindings are closed, pinned, relative, and digest-bound', () => {
  const valid = {
    repository: 'chickpea-fixtures/calendar-skill',
    commit: 'a'.repeat(40),
    path: 'skills/calendar/SKILL.md',
    digest: `sha256:${'b'.repeat(64)}`,
  };
  assert.deepEqual(validateGitHubSourceBinding(valid, valid.digest), valid);
  assertCode(() => validateGitHubSourceBinding({ ...valid, commit: 'main' }, valid.digest), 'SOURCE_NOT_PINNED');
  assertCode(() => validateGitHubSourceBinding({ ...valid, repository: 'https://github.com/acme/repo' }, valid.digest), 'FREEFORM_URL');
  assertCode(
    () => validateGitHubSourceBinding({ ...valid, path: ['', 'Users', 'example', 'skill'].join('/') }, valid.digest),
    'ABSOLUTE_PATH',
  );
  assertCode(() => validateGitHubSourceBinding({ ...valid, digest: `sha256:${'c'.repeat(64)}` }, valid.digest), 'SOURCE_DIGEST_MISMATCH');
  assertCode(() => validateGitHubSourceBinding({ ...valid, command: 'git clone' }, valid.digest), 'EXECUTABLE_FIELD');
});

function assertCode(callback: () => unknown, code: string): void {
  assert.throws(callback, (error: unknown) =>
    error instanceof LiveContractValidationError && error.code === code
  );
}
