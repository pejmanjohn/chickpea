/**
 * Dynamic client registration bodies that real MCP clients send, in their own
 * key order. Loopback ports are the ephemeral ones from each capture.
 */
export const REAL_MCP_CLIENT_REGISTRATIONS = {
  /** Claude Code 2.1.311 `claude mcp login`, captured against a local Chickpea. */
  'Claude Code': {
    client_name: 'Claude Code (chickpea)',
    redirect_uris: ['http://localhost:55822/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
    scope: 'chickpea:workspace offline_access',
  },
  /** Codex CLI 0.160.1 `codex mcp login`, captured against a local Chickpea. */
  'Codex CLI': {
    client_name: 'Codex',
    redirect_uris: ['http://127.0.0.1:54256/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    response_types: ['code'],
    scope: 'chickpea:workspace offline_access',
    application_type: 'native',
  },
  /** MCP Inspector 0.19.0 `clientMetadata` before a scope is chosen, on its default port. */
  'MCP Inspector': {
    redirect_uris: ['http://localhost:6274/oauth/callback', 'http://localhost:6274/oauth/callback/debug'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'MCP Inspector',
    client_uri: 'https://github.com/modelcontextprotocol/inspector',
  },
  /**
   * A claude.ai custom connector. It registers with client_secret_post whenever
   * the server advertises it, and with none when none is all it advertises.
   */
  'claude.ai': {
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Claude',
  },
} as const;
