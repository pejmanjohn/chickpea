import type { IdentityStore } from '../identity/types.ts';
import { activeAdmission } from './admission-operation.ts';
import { createBetterAuth, type ReconcileSlackIdentityInput, requireSupportedOrigin } from './better-auth.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { SlackOidcError } from './slack-oidc.ts';

/**
 * Better Auth for a host signing people into one installation at its Admin
 * origin: a session is issued only for an operation that installation's
 * store activated. Built on first use, so a refusal starts nothing.
 */
export function installationBetterAuth(identity: IdentityStore, environment: BetterAuthEnvironment) {
  const origin = requireSupportedOrigin(environment.baseURL);
  let auth: ReturnType<typeof createBetterAuth> | undefined;
  const betterAuth = () => auth ??= createBetterAuth({
    ...environment,
    baseURL: origin,
    privateSeam: {
      resolveAdmissionOperation: async (id) => activeAdmission(await identity.getAuthOperation(id)),
    },
  });
  return {
    /** The normalized Admin origin sessions are issued for. */
    origin,
    reconcileSlackIdentity: (input: ReconcileSlackIdentityInput) => betterAuth().chickpea.reconcileSlackIdentity(input),
    async issueSession(operationId: string, request: Request): Promise<Response> {
      const response = await betterAuth().chickpea.issueSession(operationId, request);
      if (!response.ok) throw new SlackOidcError('session_unavailable');
      return response;
    },
  };
}
