import type { ChannelAssignment, CustomAgentConfig } from './types.ts';

// Canonical default model pair for a brand-new profile, shared by the seed and
// surfaced to the admin UI via /admin/api/models so the client never hardcodes
// a copy that goes stale when this changes.
export const SEED_DEFAULT_MODELS = {
  claude: 'anthropic/claude-sonnet-4-6',
  'workers-ai': '@cf/zai-org/glm-5.2',
} as const;

export const seededAgents: CustomAgentConfig[] = [
  {
    id: 'agent_release_scribe',
    name: 'Release Scribe',
    description: 'Engineering release profile for launch notes and incident-quality detail.',
    instructions:
      [
        'You are Release Scribe, the engineering release profile for this Slack channel.',
        'Use only the configured Slack thread, bounded recent context, and approved tools.',
        'Write visibly markdown-rich engineering replies.',
        'Always lead with a summary table.',
        'Include a fenced code/diff snippet that makes the concrete change easy to inspect.',
        'Call out risks, owners, and verification evidence without inventing facts.',
      ].join(' '),
    enabled: true,
    defaultModels: { ...SEED_DEFAULT_MODELS },
    allowedTools: ['lookup_channel_brief'],
  },
  {
    id: 'agent_exec_brief',
    name: 'Exec Brief',
    description: 'Executive profile for concise launch and business updates.',
    instructions:
      [
        'You are Exec Brief, the executive briefing profile for this Slack channel.',
        'Use only the configured Slack thread, bounded recent context, and approved tools.',
        'Write with bold-led bullets for fast scanning.',
        'Close every answer with a numbered "Next steps" list.',
        'Use business impact, decisions, and owner language.',
        'Use no code, code fences, diffs, or implementation snippets.',
      ].join(' '),
    enabled: true,
    defaultModels: { ...SEED_DEFAULT_MODELS },
    allowedTools: ['lookup_channel_brief'],
  },
];

export const seededAssignments: ChannelAssignment[] = [
  {
    // The global '*,*' wildcard is the DIRECT-conversation default (DMs, App
    // Home) — NOT a channel catch-all. The config resolver excludes it for
    // channel turns, so a fresh install is fail-closed in channels: the bot
    // answers a channel only where a profile is explicitly assigned, but a
    // teammate can still DM it out of the box. See surfaceForChannelId.
    workspaceId: '*',
    channelId: '*',
    agentId: 'agent_exec_brief',
    enabled: true,
  },
];

export const seededChannelBriefs: Record<string, string> = {
  C_ENG:
    'The engineering release channel tracks shipped fixes, launch risks, owners, and verification evidence.',
  C_EXEC:
    'The exec leadership channel tracks board prep, paid acquisition, and weekly customer-proof priorities.',
};
