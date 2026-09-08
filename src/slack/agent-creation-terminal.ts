import * as v from 'valibot';

export const SLACK_AGENT_CREATION_TERMINAL_DATA_NAME = 'slackAgentCreationTerminal';

const SlackAgentCreationFollowOnNoticeSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('proposal'),
    text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(3_000)),
  }),
  v.strictObject({
    kind: v.picklist(['pending', 'declined', 'failure']),
    text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  }),
]);

export const SlackAgentCreationTerminalIntentSchema = v.strictObject({
  schemaVersion: v.literal(1),
  operationId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  creationItemId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
  agentId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
  connectorMentions: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
    v.maxLength(12),
  ),
  followOnNotices: v.pipe(v.array(SlackAgentCreationFollowOnNoticeSchema), v.maxLength(8)),
});

export type SlackAgentCreationTerminalIntent = v.InferOutput<
  typeof SlackAgentCreationTerminalIntentSchema
>;

/**
 * Reply data is an untrusted compatibility seam. Invalid creation metadata
 * must leave the ordinary model final in control instead of failing the turn
 * or suppressing its reply.
 */
export function parseSlackAgentCreationTerminalIntents(
  value: unknown,
): SlackAgentCreationTerminalIntent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 9) return [];
  const intents: SlackAgentCreationTerminalIntent[] = [];
  for (const item of value) {
    const parsed = v.safeParse(SlackAgentCreationTerminalIntentSchema, item);
    if (!parsed.success) return [];
    intents.push(parsed.output);
  }

  const first = intents[0]!;
  for (let index = 1; index < intents.length; index += 1) {
    const previous = intents[index - 1]!;
    const current = intents[index]!;
    if (!sameTerminalIdentity(first, current) ||
        previous.followOnNotices.length > current.followOnNotices.length ||
        !previous.followOnNotices.every((notice, noticeIndex) => {
          const next = current.followOnNotices[noticeIndex];
          return next?.kind === notice.kind && next.text === notice.text;
        })) {
      return [];
    }
  }
  return [intents.at(-1)!];
}

function sameTerminalIdentity(
  first: SlackAgentCreationTerminalIntent,
  current: SlackAgentCreationTerminalIntent,
): boolean {
  return first.operationId === current.operationId &&
    first.creationItemId === current.creationItemId &&
    first.agentId === current.agentId &&
    first.connectorMentions.length === current.connectorMentions.length &&
    first.connectorMentions.every((mention, index) => current.connectorMentions[index] === mention);
}
