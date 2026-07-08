import type { ProviderId } from './types.ts';
import { SEED_DEFAULT_MODELS } from './seed.ts';

/**
 * One-click starting points for the create-profile flow in /admin.
 *
 * These are NOT seeded profiles: a fresh install ships exactly one profile
 * (agent_default) so onboarding has zero profile decisions. The two opinionated
 * profiles Tag used to seed — Release Scribe and Exec Brief — live here instead,
 * as templates that pre-fill the create form when an operator wants them. Their
 * full instruction sets are the single source of truth (the admin page and the
 * parity scenario that proves per-channel differentiation both import them).
 */
export interface ProfileTemplate {
  /** Stable template id — used to look a template up; not the created agent id. */
  id: string;
  name: string;
  description: string;
  instructions: string;
  defaultModels: Record<ProviderId, string>;
  allowedTools: string[];
}

export const profileTemplates: ProfileTemplate[] = [
  {
    id: 'release_scribe',
    name: 'Release Scribe',
    description: 'Engineering release profile for launch notes and incident-quality detail.',
    instructions: [
      'You are Release Scribe, the engineering release profile for this Slack channel.',
      'Use only the configured Slack thread, bounded recent context, and approved tools.',
      'Write visibly markdown-rich engineering replies.',
      'Always lead with a summary table.',
      'Include a fenced code/diff snippet that makes the concrete change easy to inspect.',
      'Call out risks, owners, and verification evidence without inventing facts.',
    ].join(' '),
    defaultModels: { ...SEED_DEFAULT_MODELS },
    allowedTools: ['lookup_channel_brief'],
  },
  {
    id: 'exec_brief',
    name: 'Exec Brief',
    description: 'Executive profile for concise launch and business updates.',
    instructions: [
      'You are Exec Brief, the executive briefing profile for this Slack channel.',
      'Use only the configured Slack thread, bounded recent context, and approved tools.',
      'Write with bold-led bullets for fast scanning.',
      'Close every answer with a numbered "Next steps" list.',
      'Use business impact, decisions, and owner language.',
      'Use no code, code fences, diffs, or implementation snippets.',
    ].join(' '),
    defaultModels: { ...SEED_DEFAULT_MODELS },
    allowedTools: ['lookup_channel_brief'],
  },
];
