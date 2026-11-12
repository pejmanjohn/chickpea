import { McpServer, createMcpHandler, type Transport } from '@modelcontextprotocol/server';

import { knownMcpCardClient } from '../auth/mcp-client-name.ts';
import type { McpAuthenticatedPrincipal, McpRequestHandler } from '../auth/mcp-oauth-routes.ts';
import {
  type PlatformEnv,
} from '../config/state-backend.ts';
import { DISCOVERY_GUIDE_URI } from './agent-authoring/index.ts';
import { WorkspaceManagementService } from './service.ts';
import { WORKSPACE_MANAGEMENT_INSTRUCTIONS } from './instructions.ts';
import { createLiveWorkspaceManagementService } from './live-service.ts';
import { playbookSection } from './playbook/index.ts';
import { observeMcpRequests } from './mcp-request-telemetry.ts';
import {
  CARD_REFUSAL_TOOL_NAMES,
  FIVE_ZERO_TOOL_INPUT_SCHEMAS,
  FIVE_ZERO_TOOL_NAMES,
  registerFiveZeroTools,
} from './mcp-v5/tools.ts';
import { declaresCards, withCardSessions } from './mcp-v5/card-host.ts';
import { registerCards } from './mcp-v5/cards.ts';
import { shapeFiveZeroResults } from './mcp-v5/transport.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import type { ManagementActorContext } from './types.ts';

export const WORKSPACE_MANAGEMENT_SERVER_INFO = {
  name: 'chickpea-workspace',
  version: '5.0.0',
} as const;

const FIVE_ZERO_TOOL_NAME_SET: ReadonlySet<string> = new Set(FIVE_ZERO_TOOL_NAMES);

/**
 * Each transport this server connects reports an `mcp.request` metric per
 * message, and gives 5.0 results the shape the SDK cannot express.
 */
class ObservedMcpServer extends McpServer {
  constructor(private readonly clientId: string, private readonly cardSession: boolean) {
    super(WORKSPACE_MANAGEMENT_SERVER_INFO, { instructions: WORKSPACE_MANAGEMENT_INSTRUCTIONS });
  }

  /** A known OAuth card client stays one even when its session or capabilities are missing. */
  cardHost(): boolean {
    return knownMcpCardClient(this.clientId) || this.cardSession || declaresCards(this.server.getClientCapabilities());
  }

  override connect(transport: Transport): Promise<void> {
    // Shaped first, so the request metric reads each result as the tool made it: a refusal
    // that leaves a card session as a result still counts as a refusal, and a call of a
    // removed tool counts as the SDK answered it.
    shapeFiveZeroResults(
      transport,
      FIVE_ZERO_TOOL_NAME_SET,
      { session: () => this.cardHost(), tools: CARD_REFUSAL_TOOL_NAMES },
    );
    observeMcpRequests(transport, FIVE_ZERO_TOOL_INPUT_SCHEMAS);
    return super.connect(transport);
  }
}

interface WorkspaceManagementMcpServerInput {
  principal: McpAuthenticatedPrincipal;
  service: WorkspaceManagementService;
  /** Public base URL of this deployment, used to make the Admin links in results real. */
  baseUrl?: string;
  /** This deployment's env: results name only the Settings sections its Admin shows. */
  env?: PlatformEnv;
  /** The client declared cards at `initialize` (mcp-v5/card-host.ts). */
  cardSession?: boolean;
}

export function createWorkspaceManagementMcpHandler(
  principal: McpAuthenticatedPrincipal,
  env?: PlatformEnv,
  setupBaseUrl?: string,
  productTelemetry?: ProductTelemetryCapture,
): McpRequestHandler {
  const service = createLiveWorkspaceManagementService(env, {
    overrides: {
      ...(setupBaseUrl ? { setupBaseUrl } : {}),
      ...(productTelemetry ? { productTelemetry } : {}),
    },
  });
  return workspaceManagementMcpFetch({
    principal,
    service,
    ...(setupBaseUrl ? { baseUrl: setupBaseUrl } : {}),
    ...(env ? { env } : {}),
  });
}

/** One request to the server, which learns from its session whether the client draws cards. */
export function workspaceManagementMcpFetch(
  input: Omit<WorkspaceManagementMcpServerInput, 'cardSession'>,
): McpRequestHandler {
  return (request) => withCardSessions(request, (served, cardSession) => createMcpHandler(
    () => createWorkspaceManagementMcpServer({ ...input, cardSession }),
    { legacy: 'stateless' },
  ).fetch(served));
}

export function createWorkspaceManagementMcpServer(
  input: WorkspaceManagementMcpServerInput,
): McpServer {
  const server = new ObservedMcpServer(input.principal.clientId, input.cardSession === true);
  registerFiveZeroTools(server, {
    service: input.service,
    context: async () => mcpActorContext(input.principal),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.env ? { env: input.env } : {}),
  }, () => server.cardHost());
  registerCards(server, input.baseUrl);

  // The playbook's research section, under the URI /connect.md and the docs name.
  server.registerResource('discovery-guide', DISCOVERY_GUIDE_URI, {
    title: 'Find the first Chickpea Agent',
    description: 'Read before you propose an Agent whose job the person has not named: how to find one in their own work and propose one specific Agent. The same text as get_guide with topic research.',
    mimeType: 'text/markdown',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: playbookSection('research', server.cardHost() ? 'chat-app' : 'any').guide }],
  }));

  return server;
}

function mcpActorContext(principal: McpAuthenticatedPrincipal): ManagementActorContext {
  return {
    userId: principal.userId,
    membershipId: principal.membershipId,
    organizationId: principal.organizationId,
    origin: { kind: 'mcp', clientId: principal.clientId },
  };
}
