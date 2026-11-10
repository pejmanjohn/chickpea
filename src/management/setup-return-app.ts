import type { BetterAuthMcpOAuthClients } from '../auth/better-auth-backend.ts';
import { resolveBetterAuthEnvironment } from '../auth/better-auth-environment.ts';
import { displayMcpClientName, knownMcpAppName } from '../auth/mcp-client-name.ts';
import type { SetupDependencies } from './setup-routes.ts';

type ReturnAppDependencies = Pick<SetupDependencies, 'identity' | 'platformEnv'>;

/**
 * The app a finished MCP setup link sends the person back to: Chickpea's
 * name for a known app, else the name the person's own client registered.
 * Any failure leaves the name out, and the page says "your app".
 */
export async function mcpReturnApp(
  clientId: string,
  membershipId: string,
  dependencies: ReturnAppDependencies,
  mcpOAuthClients: () => Promise<BetterAuthMcpOAuthClients | undefined> = () => betterAuthClients(dependencies),
): Promise<{ app?: string }> {
  const app = knownMcpAppName(clientId) ??
    await registeredName(clientId, membershipId, dependencies, mcpOAuthClients).catch(() => undefined);
  return app ? { app } : {};
}

async function registeredName(
  clientId: string,
  membershipId: string,
  dependencies: ReturnAppDependencies,
  mcpOAuthClients: () => Promise<BetterAuthMcpOAuthClients | undefined>,
): Promise<string | undefined> {
  const betterAuthUserId = (await dependencies.identity.listExternalIdentities())
    .find((binding) => binding.membershipId === membershipId)?.betterAuthUserId;
  if (!betterAuthUserId) return undefined;
  const client = (await (await mcpOAuthClients())?.listOAuthClientsForUser(betterAuthUserId))
    ?.find((entry) => entry.clientId === clientId);
  return displayMcpClientName(client?.name ?? undefined);
}

async function betterAuthClients(dependencies: ReturnAppDependencies): Promise<BetterAuthMcpOAuthClients | undefined> {
  const control = await dependencies.identity.getAuthControl();
  return control
    ? (await resolveBetterAuthEnvironment({ control, platformEnv: dependencies.platformEnv }))?.backend
    : undefined;
}
