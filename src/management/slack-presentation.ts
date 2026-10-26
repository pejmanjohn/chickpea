import {
  escapeSlackControlCharacters,
  slackMarkdownBlockTextLimit,
} from '../slack/message-format.ts';
import {
  formatChangeSetProposal,
  formatSkillImportProposal,
  type ChangeSetPresentationDialect,
} from './change-set-presentation.ts';
import type { ManagementChangeSetPreview } from './types.ts';

/** Slack mrkdwn: single-asterisk bold, control-character escaping, block limit. */
export const SLACK_PRESENTATION_DIALECT: ChangeSetPresentationDialect = {
  header: '*Proposed changes*',
  approvalInstruction: 'Reply `approve` to apply these exact changes, or tell me what to adjust.',
  truncatedApprovalInstruction:
    'Reply `approve` to apply the full proposed changes, or tell me what to adjust.',
  truncationNotice: '_Preview truncated to fit Slack. Approval applies the full proposed changes._',
  textLimit: slackMarkdownBlockTextLimit,
  bold: (text) => `*${text}*`,
  escape: escapeSlackControlCharacters,
  // Slack code spans cannot hold a backtick; a look-alike keeps the value inside one.
  code: (text) => `\`${escapeSlackControlCharacters(text.replaceAll('`', '\u02cb'))}\``,
};

export function formatSlackChangeSetProposal(preview: ManagementChangeSetPreview): string {
  return formatChangeSetProposal(preview, SLACK_PRESENTATION_DIALECT);
}

export function formatSlackSkillImportProposal(
  preview: ManagementChangeSetPreview,
  sourceUrl: string,
): string {
  return formatSkillImportProposal(preview, sourceUrl, SLACK_PRESENTATION_DIALECT);
}
