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
