/** Keep previously published Configure links pointing at their named Agent. */
export function legacyAgentAdminRedirect(requestUrl: string): string | undefined {
  const url = new URL(requestUrl);
  if (url.pathname !== '/admin' && url.pathname !== '/admin/') return undefined;
  const agentId = url.searchParams.get('agent');
  if (!agentId) return undefined;
  url.pathname = `/admin/agents/${encodeURIComponent(agentId)}`;
  url.searchParams.delete('agent');
  return `${url.pathname}${url.search}${url.hash}`;
}
