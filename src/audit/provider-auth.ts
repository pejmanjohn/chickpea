import type {
  FlueEventContext,
  FlueExecutionInterceptor,
  FlueObservation,
} from '@flue/runtime';

import type { ProviderAuthRoute } from '../config/runtime-model.ts';

export const providerAuthRouteInterceptor: FlueExecutionInterceptor = async (
  _operation,
  _context,
  next,
) => next();

/** Derive the only safe billing-lane fact from Flue's credential-free provider id. */
export function providerAuthRouteFromProviderId(
  providerId: string,
): ProviderAuthRoute | undefined {
  if (providerId === 'openai-subscription') return 'openai_subscription';
  if (providerId === 'openai') return 'openai_api_key';
  return undefined;
}

export function observeProviderAuthRoute(
  event: FlueObservation,
  context: FlueEventContext,
): void {
  if (event.type !== 'turn_request') return;
  const providerAuthRoute = providerAuthRouteFromProviderId(event.request.providerId);
  if (providerAuthRoute) {
    context.log.info('provider_auth_route', { providerAuthRoute });
  }
}
