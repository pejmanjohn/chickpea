import {
  formatChangeSetProposal,
  formatSkillImportProposal,
  type ChangeSetPresentationDialect,
} from './change-set-presentation.ts';
import type { ManagementChangeSetPreview } from './types.ts';

/** A generous cap; coding agents read the whole proposal, not a Slack block. */
const MARKDOWN_PRESENTATION_TEXT_LIMIT = 20_000;

/** The line for the person that closes a preview: whatever door shows it confirms in its own way. */
const MARKDOWN_APPROVAL_INSTRUCTION = 'Nothing changes until you confirm.';

/** Portable Markdown: double-asterisk bold, list bullets, and stored text escaped as CommonMark. */
export const MARKDOWN_PRESENTATION_DIALECT: ChangeSetPresentationDialect = {
  header: '**Proposed changes**',
  approvalInstruction: MARKDOWN_APPROVAL_INSTRUCTION,
  truncatedApprovalInstruction: MARKDOWN_APPROVAL_INSTRUCTION,
  truncationNotice: '… (preview truncated; confirmation applies the full proposal)',
  textLimit: MARKDOWN_PRESENTATION_TEXT_LIMIT,
  bold: (text) => `**${text}**`,
  bullet: '-',
  // Stored text reads as written: it cannot open a link, image, emphasis, code span, heading, table, HTML
  // or entity. An `_` between two letters or digits can't open emphasis, so it stays, as in URL paths.
  escape: (text) => text.replace(/[\\`*_[\]<>#|~&]/g, (character, at: number, all: string) =>
    character === '_' && /[A-Za-z0-9]/.test(all[at - 1] ?? '') && /[A-Za-z0-9]/.test(all[at + 1] ?? '')
      ? character
      : `\\${character}`),
  code: markdownCodeSpan,
  // An autolink: CommonMark applies no backslash escapes inside it, and URL parsing encodes `<`, `>` and spaces.
  link: (url) => `<${new URL(url).href}>`,
};

/** A CommonMark code span whose fence outlasts every backtick run in the value. */
function markdownCodeSpan(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function formatMarkdownChangeSetProposal(preview: ManagementChangeSetPreview): string {
  return formatChangeSetProposal(preview, MARKDOWN_PRESENTATION_DIALECT);
}

export function formatMarkdownSkillImportProposal(
  preview: ManagementChangeSetPreview,
  sourceUrl: string,
): string {
  return formatSkillImportProposal(preview, sourceUrl, MARKDOWN_PRESENTATION_DIALECT);
}
