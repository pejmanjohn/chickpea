/**
 * Server `instructions` for the workspace-management MCP.
 *
 * Coding agents such as Claude Code read this once at session start, so the
 * most important facts come first. Claude Code truncates instructions after
 * 2,000 bytes; `WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_BYTES` guards that cap
 * in tests. The text must stay free of secrets and internal identifiers: it is
 * sent to every authenticated principal.
 */

import {
  ADMIN_PATH,
  ADMIN_SETTINGS_SECTIONS,
  adminOnlySettingsSections,
  adminOrigin,
  adminSettingsPath,
} from './admin-links.ts';

export const WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_BYTES = 2000;

/**
 * Normalize a deployment base URL to its origin. Returns undefined when the
 * value is missing or unparsable so the instructions fall back to a relative
 * Admin path instead of printing a broken link.
 */
export function workspaceManagementAdminOrigin(baseUrl?: string): string | undefined {
  return adminOrigin(baseUrl);
}

/**
 * Build the per-principal instructions. `baseUrl` is the deployment's public
 * base URL (the same value the service uses for setup links) so the Admin
 * links are real for this deployment; `env` leaves out the Settings sections
 * its Admin does not show.
 */
export function workspaceManagementInstructions(baseUrl?: string, env?: Record<string, unknown>): string {
  const origin = workspaceManagementAdminOrigin(baseUrl);
  const adminUrl = origin ? `${origin}${ADMIN_PATH}` : ADMIN_PATH;
  const admin = origin ? adminUrl : `your Chickpea deployment's ${ADMIN_PATH} page`;
  const settings = adminOnlySettingsSections(env)
    .map((id) => `${ADMIN_SETTINGS_SECTIONS[id]} (${adminSettingsPath(id)})`)
    .join(', ');

  return [
    'Chickpea gives a Slack workspace AI teammates called Agents. People manage them through three doors: the Admin web app, chatting with @Chickpea in Slack, and this MCP server. You are the coding-agent door, acting as the signed-in member.',
    '',
    '1. Call inspect_workspace before recommending or changing anything. Its connectors field is the setup catalog, not current access.',
    '2. Before designing or editing an Agent, read the resource chickpea://guide/agent-authoring/v1; import_skill takes its version as guideVersion.',
    '3. You have the person\'s Admin authority: apply_workspace_changes applies each change they may make (a new Agent is one create_agent operation). As in Admin, a destructive change returns confirmation_required: show its presentation.markdown, ask, then call confirm_workspace_change.',
    '4. Never ask for, accept, or relay secrets: API keys, tokens, OAuth codes, passwords. To connect a service, call prepare_connector_setup; for a model provider key (Owner or Admin), prepare_provider_setup. Give the person the handoff link.',
    `5. Admin-only, beyond the handoffs in 4: Agent avatars (click the avatar on the Agent page) and these Settings sections under ${adminUrl}: ${settings}. Send the link; results touching them carry links.admin.`,
    '6. Show each result\'s presentation.markdown, never presentation.slack. After creating or changing an Agent, give the person the receipt\'s links.admin and links.slack and tell them to mention it in Slack (@handle).',
    '',
    `Admin: ${admin}`,
  ].join('\n');
}
