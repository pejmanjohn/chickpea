/**
 * Revisioned provider alias ids.
 *
 * A hosted catalog snapshot registers immutable provider aliases named after
 * the snapshot that produced them (`…-r<revision>-<sha256 prefix>`), so an
 * in-flight Run keeps resolving against the snapshot it started on. The builder
 * and the recognizer live here so the id shape is written once: the alias
 * builder, the modelSpecifier that routing hands to Flue, and the predicates
 * that map an alias back to its canonical provider can never drift apart.
 */

export const ALIAS_FAMILIES = {
  openaiPlatform: {
    providerPrefix: 'chickpea-openai-platform',
    apiPrefix: 'chickpea-openai-platform-responses',
  },
  anthropic: {
    providerPrefix: 'chickpea-anthropic-api',
    apiPrefix: 'chickpea-anthropic-messages',
  },
  openaiSubscription: {
    providerPrefix: 'chickpea-openai-subscription',
    apiPrefix: 'chickpea-openai-subscription-responses',
  },
} as const;

export type AliasFamily = keyof typeof ALIAS_FAMILIES;

/** Hosted alias registrations retained per process before a restart is required. */
export const MAX_HOSTED_ALIAS_REGISTRATIONS = 16;

const ALIAS_PATTERNS = new Map<AliasFamily, RegExp>(
  (Object.keys(ALIAS_FAMILIES) as AliasFamily[]).map((family) => [
    family,
    new RegExp(`^${ALIAS_FAMILIES[family].providerPrefix}-r[1-9][0-9]*-[a-f0-9]{12}$`),
  ]),
);

/**
 * Build the alias pair for one snapshot identity. The identity is validated
 * here rather than at each call site: a hosted snapshot always carries a
 * positive revision and a 64-hex digest, so an invalid pair means the caller
 * skipped the catalog boundary.
 */
export function revisionedAlias(
  family: AliasFamily,
  revision: number,
  sha256: string,
): { providerId: string; api: string } {
  if (!Number.isSafeInteger(revision) || revision <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid model catalog alias identity.');
  }
  const suffix = `r${revision}-${sha256.slice(0, 12)}`;
  const prefixes = ALIAS_FAMILIES[family];
  return {
    providerId: `${prefixes.providerPrefix}-${suffix}`,
    api: `${prefixes.apiPrefix}-${suffix}`,
  };
}

/** Whether `providerId` is a revisioned alias of this family (never a bundled id). */
export function isRevisionedAlias(family: AliasFamily, providerId: string): boolean {
  return ALIAS_PATTERNS.get(family)!.test(providerId);
}
