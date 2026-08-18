import type { Model } from '@earendil-works/pi-ai';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';

import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
  registerCapturedModelCompatibilityProvider,
  resetCapturedModelCompatibilityProvidersForTests,
} from '../model-compat/provider.ts';
import {
  BUNDLED_MODEL_CATALOG,
  isPiNativeModel,
  materializeCatalogModel,
} from './bundled.ts';
import { revisionedAlias } from './provider-alias.ts';
import {
  externalEntryToInternal,
  type ModelCatalogDocumentV1,
} from './schema.ts';
import type { ModelAuthLane, ModelCatalogEntry } from './types.ts';

export interface HostedModelCatalogCandidate {
  document: ModelCatalogDocumentV1;
  sha256: string;
}

export interface ActiveModelCatalogSnapshot {
  source: 'bundled' | 'hosted';
  revision: number;
  sha256: string;
  entries: readonly ModelCatalogEntry[];
}

export interface ActiveModelCatalogRoute {
  source: 'pi_native' | 'catalog';
  snapshot: ActiveModelCatalogSnapshot;
  canonicalModel: string;
  lane: ModelAuthLane;
  modelSpecifier: string;
  model: Model<string>;
}

export type ModelCatalogActivationResult =
  | { status: 'activated'; snapshot: ActiveModelCatalogSnapshot }
  | { status: 'restart_required'; snapshot: ActiveModelCatalogSnapshot };

interface InternalSnapshot extends ActiveModelCatalogSnapshot {
  models: ReadonlyMap<string, ReadonlyMap<ModelAuthLane, Model<string>>>;
  aliases: Partial<Record<'anthropic' | 'openai', string>>;
}

const MAX_HOSTED_ACTIVATIONS = 16;
const BUNDLED_HASH = 'bundled-v1';
const activatedHostedIdentities = new Set<string>();
const bundledSnapshot = buildSnapshot('bundled', 0, BUNDLED_HASH, BUNDLED_MODEL_CATALOG);
let activeSnapshot: InternalSnapshot = bundledSnapshot;

export function activateBundledModelCatalog(): ActiveModelCatalogSnapshot {
  activeSnapshot = bundledSnapshot;
  return publicSnapshot(activeSnapshot);
}

export function activateModelCatalog(
  candidate: HostedModelCatalogCandidate,
): ModelCatalogActivationResult {
  if (!/^[a-f0-9]{64}$/.test(candidate.sha256)) {
    throw new Error('Hosted model catalog hash is invalid.');
  }
  if (activeSnapshot.source === 'hosted') {
    if (candidate.document.revision < activeSnapshot.revision) {
      return { status: 'activated', snapshot: publicSnapshot(activeSnapshot) };
    }
    if (candidate.document.revision === activeSnapshot.revision) {
      if (candidate.sha256 !== activeSnapshot.sha256) {
        throw new Error('Hosted model catalog revision is equivocal.');
      }
      return { status: 'activated', snapshot: publicSnapshot(activeSnapshot) };
    }
  }
  const identity = `${candidate.document.revision}:${candidate.sha256}`;
  if (!activatedHostedIdentities.has(identity) &&
      activatedHostedIdentities.size >= MAX_HOSTED_ACTIVATIONS) {
    return { status: 'restart_required', snapshot: publicSnapshot(activeSnapshot) };
  }

  // A hosted document is a complete compatibility snapshot, not an additive
  // patch. Omission must be able to withdraw a bad bundled model or lane in a
  // higher revision; the bundled snapshot remains the outage/cold-start
  // fallback when no validated hosted document is active.
  const entries = candidate.document.entries.map(externalEntryToInternal);
  const snapshot = buildSnapshot(
    'hosted',
    candidate.document.revision,
    candidate.sha256,
    entries,
  );
  const aliases: InternalSnapshot['aliases'] = {};
  for (const provider of ['openai', 'anthropic'] as const) {
    const lane = provider === 'openai' ? 'openai_api_key' : 'anthropic_api_key';
    const models = [...snapshot.models.entries()].flatMap(([canonical, lanes]) => {
      if (!canonical.startsWith(`${provider}/`) || isPiNativeModel(canonical)) return [];
      const model = lanes.get(lane);
      return model ? [model] : [];
    });
    const registered = registerCapturedModelCompatibilityProvider({
      provider,
      revision: candidate.document.revision,
      sha256: candidate.sha256,
      models,
    });
    if (registered) aliases[provider] = registered.providerId;
  }
  const activated: InternalSnapshot = Object.freeze({ ...snapshot, aliases: Object.freeze(aliases) });
  activatedHostedIdentities.add(identity);
  activeSnapshot = activated;
  return { status: 'activated', snapshot: publicSnapshot(activated) };
}

export function activeModelCatalogSnapshot(): ActiveModelCatalogSnapshot {
  return publicSnapshot(activeSnapshot);
}

/** Materialized models admitted by the active snapshot for Settings/pickers.
 * This reports catalog compatibility, not vendor-account availability. */
export function listActiveCatalogModels(lane: ModelAuthLane): Model<string>[] {
  return [...activeSnapshot.models.values()].flatMap((lanes) => {
    const model = lanes.get(lane);
    return model ? [structuredClone(model)] : [];
  });
}

/** Runtime-only read. This function never performs refresh or network work. */
export function resolveActiveCatalogRoute(
  canonicalModel: string,
  lane: ModelAuthLane,
): ActiveModelCatalogRoute | undefined {
  if (!laneMatchesCanonicalProvider(canonicalModel, lane)) return undefined;
  if (lane !== 'openai_subscription' && isPiNativeModel(canonicalModel)) {
    const model = readPiNativeModel(canonicalModel);
    if (!model) return undefined;
    return {
      source: 'pi_native',
      snapshot: publicSnapshot(activeSnapshot),
      canonicalModel,
      lane,
      modelSpecifier: canonicalModel,
      model,
    };
  }
  const model = activeSnapshot.models.get(canonicalModel)?.get(lane);
  if (!model) return undefined;
  let modelSpecifier: string;
  if (lane === 'openai_subscription') {
    const providerId = activeSnapshot.source === 'hosted'
      ? revisionedAlias(
        'openaiSubscription',
        activeSnapshot.revision,
        activeSnapshot.sha256,
      ).providerId
      : 'openai-subscription';
    modelSpecifier = `${providerId}/${model.id}`;
  } else {
    const provider = lane === 'openai_api_key' ? 'openai' : 'anthropic';
    const alias = compatibilityAlias(activeSnapshot, provider);
    if (!alias) return undefined;
    modelSpecifier = `${alias}/${model.id}`;
  }
  return {
    source: 'catalog',
    snapshot: publicSnapshot(activeSnapshot),
    canonicalModel,
    lane,
    modelSpecifier,
    model: structuredClone(model),
  };
}

function compatibilityAlias(
  snapshot: InternalSnapshot,
  provider: 'anthropic' | 'openai',
): string | undefined {
  if (snapshot.source === 'hosted') return snapshot.aliases[provider];
  return provider === 'openai'
    ? OPENAI_PLATFORM_COMPAT_PROVIDER_ID
    : ANTHROPIC_COMPAT_PROVIDER_ID;
}

export function resetModelCatalogActivationForTests(): void {
  activatedHostedIdentities.clear();
  resetCapturedModelCompatibilityProvidersForTests();
  activeSnapshot = bundledSnapshot;
}

function buildSnapshot(
  source: 'bundled' | 'hosted',
  revision: number,
  sha256: string,
  entries: readonly ModelCatalogEntry[],
): InternalSnapshot {
  const clonedEntries = entries.map(cloneEntry);
  const models = new Map<string, ReadonlyMap<ModelAuthLane, Model<string>>>();
  for (const entry of clonedEntries) {
    const lanes = new Map<ModelAuthLane, Model<string>>();
    for (const lane of Object.keys(entry.lanes) as ModelAuthLane[]) {
      lanes.set(lane, Object.freeze(materializeCatalogModel(entry, lane)));
    }
    models.set(entry.id, lanes);
  }
  return Object.freeze({
    source,
    revision,
    sha256,
    entries: Object.freeze(clonedEntries.map((entry) => Object.freeze(entry))),
    models,
    aliases: Object.freeze({}),
  });
}

function publicSnapshot(snapshot: InternalSnapshot): ActiveModelCatalogSnapshot {
  return {
    source: snapshot.source,
    revision: snapshot.revision,
    sha256: snapshot.sha256,
    entries: snapshot.entries,
  };
}

function laneMatchesCanonicalProvider(canonicalModel: string, lane: ModelAuthLane): boolean {
  return lane === 'anthropic_api_key'
    ? canonicalModel.startsWith('anthropic/')
    : canonicalModel.startsWith('openai/');
}

function readPiNativeModel(canonicalModel: string): Model<string> | undefined {
  const slash = canonicalModel.indexOf('/');
  if (slash <= 0) return undefined;
  const readBuiltin = getBuiltinModel as unknown as (
    provider: string,
    modelId: string,
  ) => Model<string> | undefined;
  const model = readBuiltin(canonicalModel.slice(0, slash), canonicalModel.slice(slash + 1));
  return model ? structuredClone(model) : undefined;
}

function cloneEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
  return Object.freeze({
    ...entry,
    lanes: Object.freeze({ ...entry.lanes }),
  });
}
