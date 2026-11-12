/**
 * Server `instructions` for the workspace-management MCP: the 5.0 text (U2
 * design note §6). Clients read it once at session start, and ChatGPT shows
 * a short text best, so it stays under
 * `WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_CHARACTERS`. The longer guidance
 * lives where a client meets it: each tool's description, `get_workspace`'s
 * Admin-only list, and the playbook `get_guide` serves (management/playbook),
 * which the last sentence sends a client without a Chickpea skill to. It
 * holds no link, so it reads the same on every deployment, and no secret or
 * internal identifier.
 */

export const WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_CHARACTERS = 512;

export const WORKSPACE_MANAGEMENT_INSTRUCTIONS = [
  'Chickpea adds AI teammates, called Agents, to a Slack workspace.',
  'You act as the signed-in person.',
  'Read an Agent with get_agent before changing it.',
  'New Agents: propose_agent, then create_agent once the person agrees.',
  'Never ask for keys or passwords: they go on the page connect_service returns.',
  'On needs_confirmation, show the preview and call confirm_change only after the person agrees.',
  'Share each result\'s links.',
  'For a multi-step job, call get_guide first unless a Chickpea skill is loaded.',
].join(' ');

