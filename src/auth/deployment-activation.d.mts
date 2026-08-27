export const DEPLOYMENT_ACTIVATION_TTL_MS: number;
export const DEPLOYMENT_ACTIVATION_CLOCK_SKEW_MS: number;
export const DEPLOYMENT_ACTIVATION_DIGEST_BINDING:
  'CHICKPEA_DEPLOYMENT_ACTIVATION_DIGEST';
export const DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING:
  'CHICKPEA_DEPLOYMENT_ACTIVATION_ISSUED_AT';

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  subtle: SubtleCrypto;
}

export interface DeploymentActivation {
  capability: string;
  digest: string;
  issuedAt: number;
}

export function mintDeploymentActivation(options?: {
  crypto?: CryptoLike;
  now?: () => number;
}): Promise<DeploymentActivation>;

export function digestDeploymentActivation(
  capability: string,
  crypto?: CryptoLike,
): Promise<string>;

export function verifyDeploymentActivation(input: DeploymentActivation & {
  crypto?: CryptoLike;
  now?: () => number;
}): Promise<boolean>;
