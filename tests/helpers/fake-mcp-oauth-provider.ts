/** A Linear MCP server whose authorization server takes either CIMD or dynamic registration, never both. */
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';
export const FAKE_AUTH_SERVER = 'https://auth.example.test';

export function fakeMcpOAuthProvider(registration: 'cimd' | 'dcr') {
  const registeredRedirects: string[][] = [];
  const exchanges: Array<{ clientId: string | null; redirectUri: string | null }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp') {
      return Response.json({ resource: LINEAR_MCP_URL, authorization_servers: [FAKE_AUTH_SERVER] });
    }
    if (request.url === `${FAKE_AUTH_SERVER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: FAKE_AUTH_SERVER,
        authorization_endpoint: `${FAKE_AUTH_SERVER}/authorize`,
        token_endpoint: `${FAKE_AUTH_SERVER}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(registration === 'cimd'
          ? { client_id_metadata_document_supported: true }
          : { registration_endpoint: `${FAKE_AUTH_SERVER}/register` }),
      });
    }
    if (registration === 'dcr' && request.url === `${FAKE_AUTH_SERVER}/register`) {
      const metadata = await request.json() as { redirect_uris: string[] };
      registeredRedirects.push(metadata.redirect_uris);
      return Response.json({ ...metadata, client_id: 'registered-client' });
    }
    if (request.url === `${FAKE_AUTH_SERVER}/token`) {
      const body = new URLSearchParams(await request.text());
      exchanges.push({ clientId: body.get('client_id'), redirectUri: body.get('redirect_uri') });
      return Response.json({
        access_token: 'linear-access',
        refresh_token: 'linear-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected OAuth request: ${request.url}`);
  };
  return { fetchFn, registeredRedirects, exchanges };
}
