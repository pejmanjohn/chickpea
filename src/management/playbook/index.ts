import PLAYBOOK from './playbook.json' with { type: 'json' };

/**
 * Chickpea's playbook: how a client does each multi-step job with the 5.0
 * tools, one section per job, in the order a new workspace meets them. The
 * Markdown files beside this module are the source, and `npm run
 * playbook:build` writes playbook.json from them. The plugin's skills vendor
 * the same files, so a skill and `get_guide` cannot disagree. A section pulls
 * in a shared partial with a `<!-- include: name -->` line, as the plugin's
 * build does.
 */
export const PLAYBOOK_TOPICS = [
  'start',
  'research',
  'scope',
  'connect',
  'test-drive',
  'edit',
  'schedule',
  'roll-out',
  'check-in',
] as const;
export type PlaybookTopic = typeof PLAYBOOK_TOPICS[number];

/** One line per topic, for the list a client gets when it names none. */
export const PLAYBOOK_TOPIC_ABOUT = {
  start: 'Set up a first Agent for a chore the person names: one proposal, then create it.',
  research: 'Find a first Agent in the person\'s own work before proposing it.',
  scope: 'Agree on an Agent\'s job and write test questions, each with what a good answer does.',
  connect: 'Connect a service, sign one in again, add a custom API or MCP server, or mark which tools only read.',
  'test-drive': 'Practice an Agent on its test questions, judge each answer, and fix one thing at a time.',
  edit: 'Change an Agent: its instructions, name, model, memory, skills or Channels, or turn it off.',
  schedule: 'Make an Agent post on a schedule, after practicing its task once.',
  'roll-out': 'Share an Agent with the team: its Channels, who can change it, and an announcement the person posts.',
  'check-in': 'See how Agents are doing and how the team uses them, and turn failed real asks into tests.',
} as const satisfies Record<PlaybookTopic, string>;

const SECTIONS: Readonly<Record<PlaybookTopic, string>> = PLAYBOOK.sections;
const PARTIALS: Readonly<Record<string, string>> = PLAYBOOK.partials;
const INCLUDE = /^<!-- include: ([a-z-]+) -->$/gm;

/** One section as a client reads it, its partials in place, and its title from its heading. */
export function playbookSection(topic: PlaybookTopic, reader: PlaybookReader = 'any'): { title: string; guide: string } {
  const guide = forReader(SECTIONS[topic]
    .replace(INCLUDE, (line, name: string) => PARTIALS[name]?.trimEnd() ?? line), reader)
    .trimEnd();
  return { title: guide.slice('# '.length, guide.indexOf('\n')), guide };
}

/**
 * Who reads a section. A chat app (a client that draws cards: ChatGPT,
 * claude.ai) gets no `<!-- coding-agent -->` block, so it never sees the rules
 * for reading local files, past sessions or connected sources (maintainer
 * ruling D6: ChatGPT works only from the chat). Any other client gets every
 * block, without the fence lines.
 */
export type PlaybookReader = 'chat-app' | 'any';
const CODING_AGENT_BLOCK = /^<!-- coding-agent -->\n[\s\S]*?^<!-- \/coding-agent -->\n\n?/gm;
const CODING_AGENT_FENCE = /^<!-- \/?coding-agent -->\n/gm;

function forReader(text: string, reader: PlaybookReader): string {
  return text.replace(reader === 'chat-app' ? CODING_AGENT_BLOCK : CODING_AGENT_FENCE, '');
}

/** The topic a client meant, in any case and with spaces or underscores for hyphens. */
export function playbookTopic(input: string | undefined): PlaybookTopic | undefined {
  const normalized = input?.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return PLAYBOOK_TOPICS.find((topic) => topic === normalized);
}
