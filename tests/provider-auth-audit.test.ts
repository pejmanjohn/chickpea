import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  observeProviderAuthRoute,
  providerAuthRouteFromProviderId,
} from '../src/audit/provider-auth.ts';

test('provider route auditing maps only explicit OpenAI lanes to safe facts', () => {
  assert.equal(providerAuthRouteFromProviderId('openai-subscription'), 'openai_subscription');
  assert.equal(
    providerAuthRouteFromProviderId('chickpea-openai-subscription-r7-abcdef012345'),
    'openai_subscription',
  );
  assert.equal(providerAuthRouteFromProviderId('openai'), 'openai_api_key');
  assert.equal(
    providerAuthRouteFromProviderId('chickpea-openai-platform-bundled-v1'),
    'openai_api_key',
  );
  assert.equal(
    providerAuthRouteFromProviderId('chickpea-openai-platform-r7-abcdef012345'),
    'openai_api_key',
  );
  assert.equal(providerAuthRouteFromProviderId('anthropic'), undefined);
  assert.equal(providerAuthRouteFromProviderId(''), undefined);
  assert.doesNotMatch(
    JSON.stringify([
      providerAuthRouteFromProviderId('openai-subscription'),
      providerAuthRouteFromProviderId('openai'),
    ]),
    /token|account|credential|apiKey/i,
  );
});

test('every OpenAI turn request emits one route-only trace fact', () => {
  const logs: unknown[] = [];
  const context = {
    log: {
      info(message: string, attributes?: Record<string, unknown>) {
        logs.push({ message, attributes });
      },
    },
  } as Parameters<typeof observeProviderAuthRoute>[1];
  const event = (providerId: string) => ({
    type: 'turn_request',
    request: { providerId },
  }) as Parameters<typeof observeProviderAuthRoute>[0];

  observeProviderAuthRoute(event('openai-subscription'), context);
  observeProviderAuthRoute(event('openai'), context);
  observeProviderAuthRoute(event('anthropic'), context);

  assert.deepEqual(logs, [
    { message: 'provider_auth_route', attributes: { providerAuthRoute: 'openai_subscription' } },
    { message: 'provider_auth_route', attributes: { providerAuthRoute: 'openai_api_key' } },
  ]);
});
