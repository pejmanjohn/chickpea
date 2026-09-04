/** Readable summary of an `inspect_workspace` snapshot; the JSON shape is the contract, this is a courtesy. */
export function renderWorkspaceSummary(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return JSON.stringify(snapshot, null, 2);
  const record = snapshot as Record<string, unknown>;
  const lines: string[] = [];
  const agents = asArray(record.agents);
  const channels = asArray(record.channels);
  const providers = asArray(record.providers);
  const connectors = asArray(record.connectors);
  const team = record.team && typeof record.team === 'object' ? asArray((record.team as Record<string, unknown>).members) : undefined;

  lines.push(`Workspace ${String(record.organizationId ?? '')} (revision ${String(record.effectiveRevision ?? '?')})`);

  lines.push('', `Agents (${agents.length})`);
  if (!agents.length) lines.push('  none');
  for (const agent of agents) {
    const presence = agent.slackPresence as Record<string, unknown> | undefined;
    const handle = typeof presence?.requestedHandle === 'string' ? `@${presence.requestedHandle}` : 'no handle';
    const health = typeof presence?.health === 'string' ? presence.health : undefined;
    const state = agent.enabled === false ? 'disabled' : String(agent.lifecycle ?? 'active');
    lines.push(`  ${String(agent.name)}  ${handle}  id=${String(agent.id)}  rev=${String(agent.revision)}  ${state}${health ? `  presence=${health}` : ''}`);
    if (agent.model) lines.push(`    model: ${String(agent.model)}`);
    const skills = asArray(agent.skills);
    if (skills.length) lines.push(`    skills: ${skills.map((skill) => String(skill.name ?? '?')).join(', ')}`);
    const connections = asArray(agent.connections);
    const mcp = asArray(agent.mcpServers);
    const api = asArray(agent.apiConnections);
    if (connections.length || mcp.length || api.length) {
      const parts: string[] = [];
      for (const connection of connections) {
        parts.push(`${String(connection.label ?? connection.providerId)} (${String(connection.ownerKind)}, ${String(connection.lifecycle)})`);
      }
      if (mcp.length) parts.push(`${mcp.length} MCP server${mcp.length === 1 ? '' : 's'}`);
      if (api.length) parts.push(`${api.length} API connection${api.length === 1 ? '' : 's'}`);
      lines.push(`    connections: ${parts.join(', ')}`);
    }
    const repositories = asArray(agent.repositories);
    if (repositories.length) {
      lines.push(`    repositories: ${repositories.map((repo) => String(repo.name ?? repo.repositoryId ?? repo.id ?? '?')).join(', ')}`);
    }
  }

  lines.push('', `Channels (${channels.length})`);
  if (!channels.length) lines.push('  none');
  for (const channel of channels) {
    const grants = asArray(channel.grants);
    const label = typeof channel.label === 'string' ? `${channel.label} ` : '';
    const granted = grants.map((grant) => `${String(grant.agentId)}:${String(grant.status)}`).join(', ');
    lines.push(`  ${label}${String(channel.channelId)}  ${String(channel.lifecycle ?? '')}  grants: ${granted || 'none'}`);
  }

  lines.push('', `Providers (${providers.length})`);
  if (!providers.length) lines.push('  none');
  for (const provider of providers) {
    const source = String(provider.source);
    const availability = source === 'missing' ? 'not configured' : `configured (${source}${provider.mutable ? '' : ', read-only'})`;
    const inheriting = Number(provider.inheritingAgentCount ?? 0);
    lines.push(`  ${String(provider.id)}: ${availability}${inheriting ? `, ${inheriting} inheriting Agent${inheriting === 1 ? '' : 's'}` : ''}`);
  }

  if (connectors.length) {
    lines.push('', `Connector catalog (${connectors.length}): ${connectors.map((connector) => String(connector.id)).join(', ')}`);
  }

  if (team) {
    lines.push('', `Team (${team.length})`);
    for (const member of team) {
      lines.push(`  ${String(member.displayName ?? member.userId)}  ${String(member.role)}  ${String(member.status)}`);
    }
  }
  return lines.join('\n');
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
}
