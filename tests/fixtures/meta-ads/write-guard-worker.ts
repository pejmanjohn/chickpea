import {
  assertMetaAdsWriteAccountOwnership,
  META_ADS_OWNERSHIP_ORIGIN,
} from '../../../src/config/meta-ads-write-guard.ts';
import { createMcpGuardedFetch } from '../../../src/config/mcp-url.ts';

const ARGUMENTS = {
  ad_account_id: 'act_123',
  entity_id: '987654321',
  entity_type: 'campaign',
  fields: { daily_budget: '22500' },
};

/** Exercise the real ownership guard and guarded fetch under workerd. */
export default {
  async fetch(incoming: Request): Promise<Response> {
    const input = new URL(incoming.url);
    const stub = input.searchParams.get('stub_url');
    const mode = input.searchParams.get('mode');
    if (!stub || !mode) return new Response('stub_url and mode required', { status: 400 });

    let mutationDispatched = false;
    let delegateCalls = 0;
    let delegateInput: Record<string, unknown> | null = null;
    try {
      await assertMetaAdsWriteAccountOwnership({
        name: 'ads_update_entity',
        argumentsValue: ARGUMENTS,
        approvedAccountIds: ['act_123'],
        authorization: 'Bearer synthetic-workerd-token',
        fetch: createMcpGuardedFetch({
          allowedOrigin: META_ADS_OWNERSHIP_ORIGIN,
          maxRedirects: 0,
          cloudflare: true,
          // Preserve the production guard and transport, replacing only the
          // final network boundary with a synthetic Graph response.
          fetch: async (requestInfo, init) => {
            delegateCalls += 1;
            const request = new Request(requestInfo, init);
            delegateInput = {
              url: request.url,
              method: request.method,
              redirect: request.redirect,
              authorization: request.headers.get('authorization'),
            };
            const response = await fetch(`${stub}/${mode}`, {
              method: request.method,
              headers: request.headers,
              redirect: 'manual',
              signal: request.signal,
            });
            const body = await response.arrayBuffer();
            return new Response(body, { status: response.status, headers: response.headers });
          },
        }),
      });
      // Represents the subsequent MCP tools/call, reached only after ownership.
      mutationDispatched = true;
      return Response.json({ ok: true, mutationDispatched, delegateCalls, delegateInput });
    } catch (error) {
      return Response.json({
        ok: false,
        mutationDispatched,
        delegateCalls,
        delegateInput,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
