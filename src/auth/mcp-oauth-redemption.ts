import { createHash } from 'node:crypto';

import { sha256HexNode } from '../security/digest.ts';

/**
 * The PKCE challenges the token endpoint redeemed within one authorization
 * lifetime, kept in Better Auth's verification table as a digest of client ID
 * and challenge, never the verifier. A tab still open on that authorization's
 * consent page would otherwise send a second code to a native client's
 * loopback listener, which closed after the first exchange.
 */
interface VerificationTable {
  $context: Promise<{
    internalAdapter: {
      createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
      findVerificationValue(identifier: string): Promise<{ expiresAt: Date | string | number } | null>;
    };
  }>;
}

const MARKER_PREFIX = 'chickpea:mcp-redeemed:';
/** The oauth-provider's `codeExpiresIn`: how long a signed consent query stays valid. */
const AUTHORIZATION_LIFETIME_MS = 10 * 60_000;

/** Records the S256 challenge of a successful `authorization_code` exchange's form body. */
export async function recordRedeemedChallenge(auth: VerificationTable, tokenRequest: URLSearchParams): Promise<void> {
  const clientId = tokenRequest.get('client_id');
  const verifier = tokenRequest.get('code_verifier');
  if (tokenRequest.get('grant_type') !== 'authorization_code' || !clientId || !verifier) return;
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const { internalAdapter } = await auth.$context;
  await internalAdapter.createVerificationValue({
    identifier: markerIdentifier(clientId, challenge),
    value: '',
    expiresAt: new Date(Date.now() + AUTHORIZATION_LIFETIME_MS),
  });
}

/** Whether a signed authorization query's PKCE challenge was already redeemed by its client. */
export async function challengeRedeemed(auth: VerificationTable, query: URLSearchParams): Promise<boolean> {
  const clientId = query.get('client_id');
  const challenge = query.get('code_challenge');
  if (!clientId || !challenge || query.get('code_challenge_method') !== 'S256') return false;
  const { internalAdapter } = await auth.$context;
  const marker = await internalAdapter.findVerificationValue(markerIdentifier(clientId, challenge));
  // Better Auth returns the row it found before pruning expired ones.
  return marker !== null && new Date(marker.expiresAt).getTime() > Date.now();
}

function markerIdentifier(clientId: string, challenge: string): string {
  return `${MARKER_PREFIX}${sha256HexNode(`${clientId}\n${challenge}`)}`;
}
