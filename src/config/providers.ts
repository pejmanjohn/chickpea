// Providers usable in this install. src/app.ts records every registerProvider()
// call here, and built-in catalog providers count as known when their standard
// credential is present — per the Flue models guide they need no registration
// (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY alone enable them).
// Consumers treat an EMPTY set as "registry unavailable" (e.g. unit tests that
// exercise route modules without booting src/app.ts) and skip validation.
const appRegistered = new Set<string>();

export function recordRegisteredProvider(id: string): void {
  appRegistered.add(id);
}

const BUILTIN_ENV_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
];

export function knownProviderIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ids = new Set(appRegistered);
  for (const [id, envVar] of BUILTIN_ENV_PROVIDERS) {
    if (env[envVar]) {
      ids.add(id);
    }
  }
  return ids;
}
