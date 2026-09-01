import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_LIVE_VARIANTS,
  requiredSuitesForVariant,
  type LiveCatalog,
  type LiveContract,
  validateLiveContract,
} from '../qa/live/schema.ts';
import { compileLiveCatalog } from '../qa/live/compiler.ts';
import { FOUNDATION_LIVE_CASES, PUBLIC_LIVE_CATALOG } from '../qa/live/cases/index.ts';

function readonlyContract(
  id = 'LC-01',
  variantId = 'LC01-V1-create-welcome',
): LiveContract {
  return {
    id,
    title: `Contract ${id}`,
    area: 'agents',
    feature: 'agent_lifecycle',
    entryPoints: ['slack_root'],
    variants: [{
      id: variantId,
      title: `Variant ${variantId}`,
      suites: requiredSuitesForVariant(variantId),
      fixtures: [],
      actions: [{
        id: 'slack.message.inspect',
        message: 'Inspect the message marked {{runMarker}}.',
        mutation: 'none',
        humanGate: 'none',
        fixtureSlots: [],
        cleanup: { strategy: 'not_required', fixtureClass: 'immutable_baseline' },
      }],
      generatedEffects: [],
      observers: ['slack.messages.read'],
      expected: [{ token: 'slack.message_matches', observerId: 'slack.messages.read' }],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'slack.messages.read' }],
      regressions: [{ candidateId: `CAND-${variantId}`, lesson: 'Keep the live boundary observable.' }],
      evidence: ['immutable_id', 'revision', 'observed_state'],
    }],
  };
}

function fullV11Catalog(): LiveCatalog {
  return {
    schemaVersion: 'chickpea-live-catalog/v1',
    release: 'v1.1',
    pendingContractIds: [],
    contracts: Object.entries(REQUIRED_LIVE_VARIANTS).map(([contractId, variantIds]) => ({
      ...readonlyContract(contractId, variantIds[0]!),
      variants: variantIds.map((variantId) => readonlyContract(contractId, variantId).variants[0]!),
    })),
  };
}

function foundationV10Catalog(): LiveCatalog {
  return {
    schemaVersion: 'chickpea-live-catalog/v1',
    release: 'v1.0',
    pendingContractIds: ['LC-02', 'LC-03', 'LC-05', 'LC-06', 'LC-07', 'LC-09', 'LC-10'],
    contracts: [...FOUNDATION_LIVE_CASES],
  };
}

test('a minimal read-only contract retains its stable behavior vocabulary', () => {
  const contract = validateLiveContract(readonlyContract());
  assert.equal(contract.id, 'LC-01');
  assert.equal(contract.variants[0]?.actions[0]?.message, 'Inspect the message marked {{runMarker}}.');
  assert.equal(contract.variants[0]?.observers[0], 'slack.messages.read');
  assert.equal(contract.variants[0]?.expected[0]?.token, 'slack.message_matches');
});

test('catalog construction rejects duplicate stable contract and variant IDs', () => {
  assert.throws(
    () => compileLiveCatalog({
      ...PUBLIC_LIVE_CATALOG,
      contracts: [...PUBLIC_LIVE_CATALOG.contracts, PUBLIC_LIVE_CATALOG.contracts[0]],
    }),
    (error: unknown) => hasCode(error, 'DUPLICATE_ID'),
  );

  const duplicateVariant = structuredClone(PUBLIC_LIVE_CATALOG);
  duplicateVariant.contracts[0]?.variants.push(duplicateVariant.contracts[0].variants[0]!);
  assert.throws(
    () => compileLiveCatalog(duplicateVariant),
    (error: unknown) => hasCode(error, 'DUPLICATE_ID'),
  );
});

test('v1.0 requires exact foundation variants and seven explicit pending contract IDs', () => {
  const foundation = foundationV10Catalog();
  assert.doesNotThrow(() => compileLiveCatalog(foundation));

  const missingPending = structuredClone(foundation);
  missingPending.pendingContractIds.pop();
  assert.throws(
    () => compileLiveCatalog(missingPending),
    (error: unknown) => hasCode(error, 'INVENTORY_MISMATCH'),
  );

  const missingVariant = structuredClone(foundation);
  missingVariant.contracts[0]?.variants.pop();
  assert.throws(
    () => compileLiveCatalog(missingVariant),
    (error: unknown) => hasCode(error, 'INVENTORY_MISMATCH'),
  );
});

test('v1.1 requires the complete minimum live-variant inventory', () => {
  const complete = fullV11Catalog();
  assert.equal(compileLiveCatalog(complete).pendingContractIds.length, 0);

  complete.contracts.at(-1)?.variants.pop();
  assert.throws(
    () => compileLiveCatalog(complete),
    (error: unknown) => hasCode(error, 'INVENTORY_MISMATCH'),
  );
});

test('mutations require cleanup and tombstone-producing actions require exact residue intent', () => {
  const missingCleanup = readonlyContract();
  const action = missingCleanup.variants[0]?.actions[0];
  assert.ok(action);
  Object.assign(action, { id: 'agent.create', mutation: 'create' });
  delete (action as Partial<typeof action>).cleanup;
  assert.throws(
    () => validateLiveContract(missingCleanup),
    (error: unknown) => hasCode(error, 'MISSING_CLEANUP'),
  );

  const wrongResidue = readonlyContract();
  Object.assign(wrongResidue.variants[0]?.actions[0] ?? {}, {
    id: 'slack.message.send',
    mutation: 'create',
    cleanup: {
      strategy: 'exact_reversal',
      fixtureClass: 'run_owned',
      reversalActionId: 'slack.message.delete',
    },
  });
  assert.throws(
    () => validateLiveContract(wrongResidue),
    (error: unknown) => hasCode(error, 'INVALID_RESIDUE'),
  );

  const generatedWithoutResidue = readonlyContract();
  generatedWithoutResidue.variants[0]!.generatedEffects.push({
    id: 'slack.message.generated',
    message: 'Chickpea produces the result marked {{runMarker}}.',
    fixtureSlots: [],
    observerId: 'slack.messages.read',
    cleanup: {
      strategy: 'exact_reversal',
      fixtureClass: 'run_owned',
      reversalActionId: 'slack.message.delete',
    },
  });
  assert.throws(
    () => validateLiveContract(generatedWithoutResidue),
    (error: unknown) => hasCode(error, 'INVALID_RESIDUE'),
  );
});

test('scored assertions require an authoritative registered observer', () => {
  const screenshotOnly = readonlyContract();
  screenshotOnly.variants[0]!.observers = ['browser.screenshot'];
  screenshotOnly.variants[0]!.expected[0]!.observerId = 'browser.screenshot';
  assert.throws(
    () => validateLiveContract(screenshotOnly),
    (error: unknown) => hasCode(error, 'NON_AUTHORITATIVE_ASSERTION'),
  );

  const unknown = structuredClone(readonlyContract()) as unknown as LiveContract;
  unknown.variants[0]!.actions[0]!.id = 'shell.exec' as never;
  assert.throws(
    () => validateLiveContract(unknown),
    (error: unknown) => hasCode(error, 'UNKNOWN_ACTION_ID'),
  );

  const unknownObserver = structuredClone(readonlyContract()) as unknown as LiveContract;
  unknownObserver.variants[0]!.observers[0] = 'custom.observer' as never;
  assert.throws(
    () => validateLiveContract(unknownObserver),
    (error: unknown) => hasCode(error, 'UNKNOWN_OBSERVER_ID'),
  );
});

test('sanitized Slack messages may contain only the generated run-marker slot', () => {
  const valid = readonlyContract();
  assert.doesNotThrow(() => validateLiveContract(valid));

  valid.variants[0]!.actions[0]!.message = 'Inspect {{workspaceId}} and {{runMarker}}.';
  assert.throws(
    () => validateLiveContract(valid),
    (error: unknown) => hasCode(error, 'PRIVATE_COORDINATE'),
  );
});

test('foundation Slack outputs are product-generated effects with attributed residue, not operator actions', () => {
  const generatedVariantIds = new Set([
    'LC01-V1-create-welcome',
    'LC08-V1-create-due',
    'LC08-V3-run-now',
  ]);
  for (const contract of FOUNDATION_LIVE_CASES) {
    for (const variant of contract.variants) {
      assert.equal(variant.actions.some((action) => action.id === 'slack.message.send'), false);
      if (generatedVariantIds.has(variant.id)) {
        assert.equal(variant.generatedEffects.length, 1);
        assert.equal(variant.generatedEffects[0]?.id, 'slack.message.generated');
        assert.equal(variant.generatedEffects[0]?.cleanup.strategy, 'attributed_residue');
      } else {
        assert.equal(variant.generatedEffects.length, 0);
      }
    }
  }
});

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
