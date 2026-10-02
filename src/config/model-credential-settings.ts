/**
 * Where an installation's settings store keeps one provider's model
 * credential: version metadata in ordinary settings, and the key either as a
 * standalone plaintext setting or, on an installation of a deployment serving
 * many, only as an encrypted revision. A leaf module, so the store and the
 * credential code share one definition without importing each other.
 */
export interface ModelCredentialSettingKeys {
  /** Standalone's saved key. Never written for an installation of a deployment serving many. */
  readonly apiKey: string;
  readonly credentialRefId: string;
  readonly version: string;
  readonly active: string;
  readonly activeFrom: string;
  /** The encrypted realm's key for the current envelope. */
  readonly envelope: string;
}

export function modelCredentialSettingKeys(providerId: string): ModelCredentialSettingKeys {
  return {
    apiKey: `provider.${providerId}.apiKey`,
    credentialRefId: `provider.${providerId}.credentialRefId`,
    version: `provider.${providerId}.credentialVersion`,
    active: `provider.${providerId}.credentialActive`,
    activeFrom: `provider.${providerId}.credentialActiveFrom`,
    envelope: `model_provider.${providerId}`,
  };
}

/** The encrypted revision name of the envelope published for `version`. */
export function modelCredentialRevision(version: number): string {
  return `v${version}`;
}
