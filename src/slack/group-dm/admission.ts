/** A Slack group DM holds nine members: this app and eight people. */
export const MAX_GROUP_DM_PEOPLE = 8;

const USER_MENTION = /<@([UW][A-Z0-9]{2,30})(?:\|[^>]*)?>/g;

export type GroupDmAdmissionRefusal = 'requester_required' | 'not_named' | 'too_few' | 'too_many';

export type GroupDmAdmission =
  | { ok: true; people: string[] }
  | { ok: false; code: GroupDmAdmissionRefusal; people?: string[] };

export function admitGroupDmPeople(input: {
  requesterSlackUserId: string;
  requestText: string | undefined;
  people: readonly string[];
}): GroupDmAdmission {
  if (!input.requestText) return { ok: false, code: 'requester_required' };
  const named = new Set([...input.requestText.matchAll(USER_MENTION)].map((match) => match[1]!));
  const others = [...new Set(input.people.map(slackUserFromMention))]
    .filter((id) => id !== input.requesterSlackUserId);
  const notNamed = others.filter((id) => !named.has(id));
  if (notNamed.length) return { ok: false, code: 'not_named', people: notNamed };
  if (others.length === 0) return { ok: false, code: 'too_few' };
  if (others.length > MAX_GROUP_DM_PEOPLE - 1) return { ok: false, code: 'too_many' };
  return { ok: true, people: [input.requesterSlackUserId, ...others] };
}

function slackUserFromMention(value: string): string {
  const trimmed = value.trim();
  return /^<@([^|>]+)(\|[^>]*)?>$/.exec(trimmed)?.[1] ?? trimmed;
}
