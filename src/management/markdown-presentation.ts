import {
  formatChangeSetProposal,
  formatSkillImportProposal,
  type ChangeSetPresentationDialect,
} from './change-set-presentation.ts';
import type { ManagementChangeSetPreview } from './types.ts';

/** A generous cap; coding agents read the whole proposal, not a Slack block. */
const MARKDOWN_PRESENTATION_TEXT_LIMIT = 20_000;

const MARKDOWN_APPROVAL_INSTRUCTION =
  'Show these changes to the person. When they approve, call confirm_workspace_change with the ' +
  'proposalId; if they want something different, inspect again and send a new change.';

/** Portable Markdown: double-asterisk bold and no Slack mrkdwn escaping. */
export const MARKDOWN_PRESENTATION_DIALECT: ChangeSetPresentationDialect = {
  header: '**Proposed changes**',
  approvalInstruction: MARKDOWN_APPROVAL_INSTRUCTION,
  truncatedApprovalInstruction: MARKDOWN_APPROVAL_INSTRUCTION,
  truncationNotice: '… (preview truncated; confirmation applies the full proposal)',
  textLimit: MARKDOWN_PRESENTATION_TEXT_LIMIT,
  bold: (text) => `**${text}**`,
  escape: (text) => text,
  code: markdownCodeSpan,
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
