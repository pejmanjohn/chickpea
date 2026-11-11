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
}

export function renderWorkspaceSummary(result: unknown): string {
  const { workspace, agents, canCreate } = result as WorkspaceSummary;
  const lines = [
    `Workspace ${workspace.name ?? '(unnamed)'}`,
    `You: ${workspace.you.name ? `${workspace.you.name}  ` : ''}${workspace.you.role}`,
    '',
    `Agents (${agents.length})`,
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
