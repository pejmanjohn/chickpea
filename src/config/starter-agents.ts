/**
 * Ready-made Agents on Admin's Agents page. Choosing one fills the New Agent
 * form; nothing is created until the person saves it.
 */
export interface StarterAgent {
  id: string;
  name: string;
  handle: string;
  description: string;
  instructions: string;
  /** A default avatar under assets/chickpea-avatars/agent-defaults/. */
  avatar: string;
}

export const STARTER_AGENTS: readonly StarterAgent[] = Object.freeze([
  {
    id: 'support',
    name: 'Support',
    handle: 'helpdesk',
    description: 'Answers customer questions from your help center and drafts replies.',
    instructions: 'Help the team answer customer questions. Find the answer in the help center and documents you can read, then draft a short, friendly reply the person can send. Say when you are not sure, and never promise refunds, dates or features.',
    avatar: '01-sage.png',
  },
  {
    id: 'code-helper',
    name: 'Code helper',
    handle: 'builder',
    description: 'Fixes bugs, reviews pull requests and explains code in your repositories.',
    instructions: 'Help the team with code in the repositories you can use. Explain how code works, review pull requests with specific suggestions, and fix bugs in small changes with a clear summary. Ask before making a large change.',
    avatar: '02-coral.png',
  },
  {
    id: 'weekly-digest',
    name: 'Weekly digest',
    handle: 'digest',
    description: 'Sums up a channel’s week: decisions, shipped work and open questions.',
    instructions: 'Write a short summary of the week in the channel you are asked about: decisions made, work shipped, and open questions with who owns them. Keep it to a few bullets and link to the original messages.',
    avatar: '03-lilac.png',
  },
]);
