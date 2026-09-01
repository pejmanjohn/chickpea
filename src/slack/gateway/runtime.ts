import {
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
  getSlackCredentialDependencies,
  type PlatformEnv,
} from '../../config/state-backend.ts';
import { GatewayDeploymentClient } from './client.ts';
import { createPlatformProductTelemetry } from '../../telemetry/platform.ts';

export const DEFAULT_CHICKPEA_GATEWAY_URL =
  'https://chickpea-slack-gateway.pejmanjohn.workers.dev';

export function resolveChickpeaGatewayUrl(env?: PlatformEnv): string {
  const configured = typeof env?.CHICKPEA_GATEWAY_URL === 'string'
    ? env.CHICKPEA_GATEWAY_URL
    : process.env.CHICKPEA_GATEWAY_URL;
  const url = new URL(configured?.trim() || DEFAULT_CHICKPEA_GATEWAY_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.search || url.pathname !== '/') {
    throw new Error('CHICKPEA_GATEWAY_URL must be an HTTPS origin.');
  }
  return url.toString();
}

export function createGatewayDeploymentClient(env?: PlatformEnv): GatewayDeploymentClient {
  const settings = getSettingsStore(env);
  const config = getConfigStore(env);
  return new GatewayDeploymentClient({
    settings,
    config,
    identity: getIdentityStore(env),
    keyring: getSlackCredentialDependencies(env).keyring,
    gatewayBaseUrl: resolveChickpeaGatewayUrl(env),
    productTelemetry: createPlatformProductTelemetry({
      ...(env ? { env } : {}),
      settings,
      config,
    }),
  });
}
