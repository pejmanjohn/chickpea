import type { Client, Tool } from '@modelcontextprotocol/client';

import { CliError } from './errors.ts';
import { callManagementTool, type ToolEnvelope } from './tools.ts';

/** `list_agents` pages one inspect follows at most; a longer list is refused, never cut short. */
export const MAX_AGENT_PAGES = 50;

interface AgentPage {
  agents: WorkspaceSummary['agents'];
  canCreate: boolean;
  nextCursor?: string;
}

/**
 * Every page of `list_agents`. A Core whose `list_agents` takes `includeArchived`
 * (#761) leaves archived Agents out unless asked; an older one lists them all on
 * one page and refuses the unknown argument, so it is never sent there.
 */
export async function listAllAgents(
  client: Client,
  listAgents: Tool | undefined,
  includeArchived: boolean,
): Promise<ToolEnvelope> {
  const takesArchived = Boolean(listAgents?.inputSchema.properties && 'includeArchived' in listAgents.inputSchema.properties);
  const agents: AgentPage['agents'] = [];
  let canCreate = false;
  let cursor: string | undefined;
  const asked = takesArchived && includeArchived ? { includeArchived: true } : {};
  for (let pages = 0; pages < MAX_AGENT_PAGES; pages += 1) {
    const envelope = await callManagementTool(client, 'list_agents', { ...asked, ...(cursor ? { cursor } : {}) });
    if (!envelope.ok) return envelope;
    const page = envelope.result as AgentPage;
    agents.push(...page.agents);
    canCreate = page.canCreate;
    cursor = page.nextCursor;
    if (!cursor) {
      return { ok: true, result: { agents, canCreate, ...(takesArchived && !includeArchived ? { archivedLeftOut: true } : {}) } };
    }
  }
  const args = JSON.stringify({ ...asked, cursor: '<nextCursor>' });
  throw new CliError('TOO_MANY_PAGES', `list_agents had more than ${MAX_AGENT_PAGES} pages; the CLI stopped instead of printing part of the list`, `Page through it with: chickpea call <deployment-url> list_agents --args '${args}'`);
}

interface WorkspaceSummary {
  workspace: {
    name?: string;
    you: { name?: string; role: string };
    adminUrl?: string;
  };
  agents: Array<{
    agentId: string;
    name: string;
    handle?: string;
    status: string;
    canEdit: boolean;
    needsAttention: string[];
  }>;
  canCreate: boolean;
  archivedLeftOut?: true;
}

export function renderWorkspaceSummary(result: unknown): string {
  const { workspace, agents, canCreate, archivedLeftOut } = result as WorkspaceSummary;
  const lines = [
    `Workspace ${workspace.name ?? '(unnamed)'}`,
    `You: ${workspace.you.name ? `${workspace.you.name}  ` : ''}${workspace.you.role}`,
    '',
    archivedLeftOut
      ? `Agents (${agents.length} shown; archived Agents are left out, --include-archived lists them)`
      : `Agents (${agents.length})`,
  ];
  if (!agents.length) lines.push('  none');
  for (const agent of agents) {
    lines.push(`  ${agent.name}  ${agent.handle ? `@${agent.handle}` : 'no handle'}  id=${agent.agentId}  ${agent.status}  ${agent.canEdit ? 'can edit' : 'read-only'}`);
    for (const reason of agent.needsAttention) lines.push(`    needs attention: ${reason}`);
  }
  lines.push('', `Can create Agents: ${canCreate ? 'yes' : 'no'}`);
  if (workspace.adminUrl) lines.push(`Workspace in Admin: ${workspace.adminUrl}`);
  return lines.join('\n');
}
