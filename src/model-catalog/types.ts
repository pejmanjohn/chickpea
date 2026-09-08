export type CatalogProviderId = 'anthropic' | 'openai';

export type ModelAuthLane =
  | 'anthropic_api_key'
  | 'openai_api_key'
  | 'openai_subscription';

export type CompiledModelProfileId =
  | 'anthropic-messages-opus-tier@1'
  | 'anthropic-messages-sonnet-tier@1'
  | 'openai-codex-responses-standard@1'
  | 'openai-codex-responses-text-only@1'
  | 'openai-platform-responses-luna-tier@1'
  | 'openai-platform-responses-sol-tier@1'
  | 'openai-platform-responses-terra-tier@1';

/**
 * Data-only release metadata. Behavioral fields live in reviewed, compiled
 * profiles and cannot be supplied by the bundled or hosted catalog.
 */
export interface ModelCatalogEntry {
  /** Canonical profile/UI id, always `<provider>/<model-id>`. */
  id: `${CatalogProviderId}/${string}`;
  displayName?: string;
  lanes: Partial<Record<ModelAuthLane, CompiledModelProfileId>>;
  /** Optional shrink-only override of the compiled profile ceiling. */
  contextWindow?: number;
  /** Optional shrink-only override of the compiled profile ceiling. */
  maxTokens?: number;
}
