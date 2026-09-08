import { LIVE_MANIFEST } from './manifest.ts';
import { SMOKE_VARIANT_IDS, type LiveManifest, type Suite } from './schema.ts';

const DEEP_CONTRACT_IDS = Array.from({ length: 10 }, (_, index) => `LC-${String(index + 1).padStart(2, '0')}`);

export class SuiteInventoryError extends Error {
  readonly code: 'INVALID_CASE_SELECTION' | 'SMOKE_SELECTION_FORBIDDEN' | 'INCOMPLETE_DEEP_INVENTORY';

  constructor(code: SuiteInventoryError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'SuiteInventoryError';
    this.code = code;
  }
}

export function selectSuiteVariants(suite: Suite, selectedVariantIds?: readonly string[]): string[] {
  if (suite === 'case') {
    if (selectedVariantIds === undefined || selectedVariantIds.length === 0) {
      throw new SuiteInventoryError('INVALID_CASE_SELECTION', 'case requires at least one manifest variant');
    }
    const unique = new Set(selectedVariantIds);
    if (unique.size !== selectedVariantIds.length
      || selectedVariantIds.some((id) => !LIVE_MANIFEST.requiredVariants.case.includes(id))) {
      throw new SuiteInventoryError('INVALID_CASE_SELECTION', 'case selection must contain unique manifest variants');
    }
    return [...selectedVariantIds];
  }
  if (selectedVariantIds !== undefined && selectedVariantIds.length > 0) {
    throw new SuiteInventoryError('SMOKE_SELECTION_FORBIDDEN', `${suite} uses the exact manifest-owned inventory`);
  }
  if (suite === 'smoke') {
    assertExactInventory(LIVE_MANIFEST.requiredVariants.smoke, SMOKE_VARIANT_IDS, 'smoke');
    return [...LIVE_MANIFEST.requiredVariants.smoke];
  }
  assertStrictDeepInventory(LIVE_MANIFEST);
  return [...LIVE_MANIFEST.requiredVariants.deep];
}

export function assertStrictDeepInventory(manifest: LiveManifest): void {
  const contractIds = manifest.contracts.map((contract) => contract.id).sort();
  const missingContract = DEEP_CONTRACT_IDS.find((id) => !contractIds.includes(id));
  if (missingContract !== undefined || contractIds.length !== DEEP_CONTRACT_IDS.length || manifest.pendingContractIds.length > 0) {
    throw new SuiteInventoryError(
      'INCOMPLETE_DEEP_INVENTORY',
      `complete deep inventory requires LC-01 through LC-10${missingContract === undefined ? '' : `; missing ${missingContract}`}`,
    );
  }
  const manifestVariantIds = manifest.contracts.flatMap((contract) =>
    contract.variants.filter((variant) => variant.suites.includes('deep')).map((variant) => variant.id)
  );
  assertExactInventory(manifest.requiredVariants.deep, manifestVariantIds, 'deep');
  const unknown = manifest.requiredVariants.deep.find((variantId) =>
    !manifest.contracts.some((contract) => contract.variants.some((variant) => variant.id === variantId))
  );
  if (unknown !== undefined) {
    throw new SuiteInventoryError('INCOMPLETE_DEEP_INVENTORY', `unknown required variant ${unknown}`);
  }
}

function assertExactInventory(actual: readonly string[], expected: readonly string[], suite: string): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (sortedActual.length !== sortedExpected.length
    || sortedActual.some((value, index) => value !== sortedExpected[index])) {
    throw new SuiteInventoryError('INCOMPLETE_DEEP_INVENTORY', `${suite} inventory must be exact`);
  }
}
