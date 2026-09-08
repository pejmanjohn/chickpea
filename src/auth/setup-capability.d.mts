export const SETUP_CAPABILITY_TTL_MS: number;
export const SETUP_CAPABILITY_CLOCK_SKEW_MS: number;
export const SETUP_CAPABILITY_DIGEST_BINDING: 'CHICKPEA_SETUP_CAPABILITY_DIGEST';
export const SETUP_CAPABILITY_ISSUED_AT_BINDING: 'CHICKPEA_SETUP_CAPABILITY_ISSUED_AT';

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  subtle: SubtleCrypto;
}

export interface SetupCapability {
  capability: string;
  digest: string;
  issuedAt: number;
}

export function mintSetupCapability(options?: {
  crypto?: CryptoLike;
  now?: () => number;
}): Promise<SetupCapability>;

export function digestSetupCapability(
  capability: string,
  crypto?: CryptoLike,
): Promise<string>;

export function verifySetupCapability(input: SetupCapability & {
  crypto?: CryptoLike;
  now?: () => number;
}): Promise<boolean>;

export function setupCapabilityUrl(baseUrl: string | URL, capability: string): string;
