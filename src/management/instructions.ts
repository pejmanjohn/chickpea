/**
 * Server `instructions` for the workspace-management MCP.
 *
 * Coding agents such as Claude Code read this once at session start, so the
 * most important facts come first. Claude Code truncates instructions after
 * 2,000 bytes; `WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_BYTES` guards that cap
 * in tests. The text must stay free of secrets and internal identifiers: it is
 * sent to every authenticated principal.
 */

export const WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_BYTES = 2000;

const ADMIN_PATH = '/admin';
const ADMIN_SETTINGS_SECTIONS = {
  providers: 'Model providers',
  github: 'GitHub',
  sandbox: 'Coding sandbox',
  outbound: 'Outbound access',
} as const;

/**
 * Normalize a deployment base URL to its origin. Returns undefined when the
 * value is missing or unparsable so the instructions fall back to a relative
 * Admin path instead of printing a broken link.
 */
export function workspaceManagementAdminOrigin(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Build the per-principal instructions. `baseUrl` is the deployment's public
 * base URL (the same value the service uses for setup links) so the Admin
 * links are real for this deployment.
 */
export function workspaceManagementInstructions(baseUrl?: string): string {
  const origin = workspaceManagementAdminOrigin(baseUrl);
  const adminUrl = origin ? `${origin}${ADMIN_PATH}` : ADMIN_PATH;
  const admin = origin ? adminUrl : `your Chickpea deployment's ${ADMIN_PATH} page`;
  const settings = (Object.keys(ADMIN_SETTINGS_SECTIONS) as Array<keyof typeof ADMIN_SETTINGS_SECTIONS>)
    .map((id) => `${ADMIN_SETTINGS_SECTIONS[id]} (${ADMIN_PATH}/settings/${id})`)
    .join(', ');

  return [
    'Chickpea gives a Slack workspace AI teammates called Agents. People manage them through three doors: the Admin web app, chatting with @Chickpea in Slack, and this MCP server. You are the coding-agent door, acting as the signed-in member.',
    '',
    '1. Call inspect_workspace before recommending or changing anything. Its connectors field is the setup catalog, not current access.',
    '2. Before propose_workspace_changes, read the resource chickpea://guide/agent-authoring/v1 and pass its version as guideVersion.',
    '3. A sufficiently understood new Agent is created immediately: call apply_workspace_changes with exactly one create_agent operation. Other consequential changes return a proposal; show it to the person, wait for their approval in this conversation, then call confirm_workspace_change with the proposalId.',
    '4. Never ask for, accept, or pass along secrets: API keys, tokens, OAuth codes, passwords. To connect a service, call prepare_connector_setup and give the person its handoff link.',
    `5. Admin-only today: Agent avatars (open the Agent in Admin, then Configure) and these Settings sections under ${adminUrl}: ${settings}. Send the person there with the link; do not try to do these over MCP.`,
    '6. Show each result\'s presentation.markdown, never presentation.slack. After creating or changing an Agent, give the person the receipt\'s links.admin and links.slack and tell them to mention it in Slack (@handle) to try it.',
    '',
    `Admin: ${admin}`,
  ].join('\n');
}
