/**
 * The MCP SDK, loaded on first use and never at Worker startup. A Slack turn
 * calls an MCP tool through Flue's own client; Chickpea's SDK use is setting
 * a connection up (its test and identity probe) and the OAuth flows (start,
 * exchange, refresh, registration). Both load at seams that are already
 * async. The OAuth record schemas (`shared/auth.js`, zod only) stay static:
 * reading a stored token parses with them synchronously.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

import { onDemand } from '../runtime/on-demand.ts';

export interface McpClientSdk {
  Client: typeof Client;
  CfWorkerJsonSchemaValidator: typeof CfWorkerJsonSchemaValidator;
  SSEClientTransport: typeof SSEClientTransport;
  StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport;
}

/** The SDK client and its transports, for a connection test or identity probe. */
export const mcpClientSdk = onDemand<McpClientSdk>('MCP client SDK', async () => {
  const [client, sse, streamableHttp, validation] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/validation/cfworker'),
  ]);
  return {
    Client: client.Client,
    CfWorkerJsonSchemaValidator: validation.CfWorkerJsonSchemaValidator,
    SSEClientTransport: sse.SSEClientTransport,
    StreamableHTTPClientTransport: streamableHttp.StreamableHTTPClientTransport,
  };
});

type OAuthClientModule = typeof import('@modelcontextprotocol/sdk/client/auth.js');
type OAuthUtilsModule = typeof import('@modelcontextprotocol/sdk/shared/auth-utils.js');

export type McpOAuthSdk =
  & Pick<OAuthClientModule,
    | 'discoverAuthorizationServerMetadata'
    | 'discoverOAuthProtectedResourceMetadata'
    | 'exchangeAuthorization'
    | 'refreshAuthorization'
    | 'registerClient'
    | 'startAuthorization'>
  & Pick<OAuthUtilsModule, 'checkResourceAllowed' | 'resourceUrlFromServerUrl'>;

/** The SDK's OAuth client flows, for an authorization's start, exchange, refresh or client registration. */
export const mcpOAuthSdk = onDemand<McpOAuthSdk>('MCP OAuth SDK', async () => {
  const [client, utils] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/auth.js'),
    import('@modelcontextprotocol/sdk/shared/auth-utils.js'),
  ]);
  return {
    checkResourceAllowed: utils.checkResourceAllowed,
    discoverAuthorizationServerMetadata: client.discoverAuthorizationServerMetadata,
    discoverOAuthProtectedResourceMetadata: client.discoverOAuthProtectedResourceMetadata,
    exchangeAuthorization: client.exchangeAuthorization,
    refreshAuthorization: client.refreshAuthorization,
    registerClient: client.registerClient,
    resourceUrlFromServerUrl: utils.resourceUrlFromServerUrl,
    startAuthorization: client.startAuthorization,
  };
});
