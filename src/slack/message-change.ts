/**
 * Whether a `message_changed` changes nothing Chickpea acts on, judged from
 * its own two bodies alone, with the projections each consumer reads: not the
 * words an edit steers with (parseSlackMessageEdit), not the subtype a delete
 * leaves (parseSlackMessageDelete), and not the edit stamp, text or file names
 * the thread record keeps (reconcileSlackPublicContextMutation). Slack sends
 * such a change each time a reply changes its message's thread counts. Kept
 * out of public-context.ts so Worker startup does not load it.
 */
import { isRecord } from '../security/content-validation.ts';
import { slackFileSummaries, slackMessageText } from './message-text.ts';
import { sameFileNames } from './public-context.ts';
import { preserveSlackRichTextLinks } from './rich-text-links.ts';

export function slackMessageChangeIsEmpty(message: Record<string, unknown>, previous: Record<string, unknown>): boolean {
  const acted = (body: Record<string, unknown>) => {
    const source = {
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      ...(Array.isArray(body.blocks) ? { blocks: body.blocks } : {}),
      ...(Array.isArray(body.attachments) ? { attachments: body.attachments } : {}),
    };
    return {
      subtype: body.subtype,
      edited: isRecord(body.edited) ? body.edited.ts : undefined,
      edit: preserveSlackRichTextLinks(source.text, source.blocks),
      text: slackMessageText(source),
      files: slackFileSummaries(body.files),
    };
  };
  const [now, before] = [acted(message), acted(previous)];
  return now.subtype === before.subtype && now.edited === before.edited && now.edit === before.edit &&
    now.text === before.text && sameFileNames(now.files, before.files);
}
