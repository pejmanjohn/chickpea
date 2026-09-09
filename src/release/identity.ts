export interface ApplicationIdentity {
  version: string;
  sourceCommit: string | null;
}

// Direct source execution has no release build. Never borrow the CLI version
// or an operator environment variable to fabricate application provenance.
export const applicationIdentity: Readonly<ApplicationIdentity> = Object.freeze(
  typeof __CHICKPEA_BUILD_IDENTITY__ === 'undefined'
    ? { version: 'development', sourceCommit: null }
    : __CHICKPEA_BUILD_IDENTITY__,
);

/**
 * True only in a Vite serve lane (local Worker development). Provenance above
 * stays real there; this flag is what tells metered-schema code that the
 * working tree, not the committed identity, defines the schema.
 */
export const viteServeLane: boolean =
  typeof __CHICKPEA_VITE_SERVE__ !== 'undefined' && __CHICKPEA_VITE_SERVE__ === true;
