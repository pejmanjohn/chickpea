import type { WebClient } from '@slack/web-api';

import { isRecord } from '../../security/content-validation.ts';
import { slackPlatformErrorCode } from '../errors.ts';
import { slackUserKind } from '../reading/service.ts';
import type { RequesterTextSource } from '../requester-text-source.ts';

const USER_MENTION = /<@([UW][A-Z0-9]{2,30})(?:\|[^>]*)?>/g;

export type NamedPeopleRefusal = 'requester_required' | 'not_named' | 'too_many';

export type NamedPeopleAdmission =
  | { ok: true; requester: string; others: string[] }
  | { ok: false; code: NamedPeopleRefusal; people?: string[] };

export function admitNamedPeople(input: {
  requesterSlackUserId: string;
  requesterText: string | undefined;
  requesterTextSource: RequesterTextSource | undefined;
  people: readonly string[];
  maxOthers: number;
}): NamedPeopleAdmission {
  const requesterTyped = input.requesterTextSource === undefined ? input.requesterText : undefined;
  if (!requesterTyped) return { ok: false, code: 'requester_required' };
  const named = new Set([...requesterTyped.matchAll(USER_MENTION)].map((match) => match[1]!));
  const others = [...new Set(input.people.map(slackUserFromMention))]
    .filter((id) => id !== input.requesterSlackUserId);
  const notNamed = others.filter((id) => !named.has(id));
  if (notNamed.length) return { ok: false, code: 'not_named', people: notNamed };
  if (others.length > input.maxOthers) return { ok: false, code: 'too_many' };
  return { ok: true, requester: input.requesterSlackUserId, others };
}

export type NamedPersonRefusal = 'not_named' | 'bot' | 'deactivated' | 'outside_workspace' | 'guest' | 'not_found';

export async function refusedPeople(
  client: { users: Pick<WebClient['users'], 'info'> },
  workspaceId: string,
  people: readonly string[],
  options: { guests: 'allowed' | 'refused' },
): Promise<{ id: string; reason: NamedPersonRefusal }[]> {
  return (await Promise.all(people.map(async (id) => {
    const reason = await personRefusal(client, workspaceId, id, options);
    return reason ? [{ id, reason }] : [];
  }))).flat();
}

async function personRefusal(
  client: { users: Pick<WebClient['users'], 'info'> },
  workspaceId: string,
  id: string,
  options: { guests: 'allowed' | 'refused' },
): Promise<NamedPersonRefusal | undefined> {
  let user: unknown;
  try {
    user = (await client.users.info({ user: id })).user;
  } catch (error) {
    if (slackPlatformErrorCode(error) === 'user_not_found') return 'not_found';
    throw error;
  }
  if (!isRecord(user) || user.id !== id) return 'not_found';
  const kind = slackUserKind(user, workspaceId);
  if (kind === 'external' || user.team_id !== workspaceId) return 'outside_workspace';
  if (kind === 'app') return 'bot';
  if (kind === 'deactivated') return 'deactivated';
  if (kind === 'guest' && options.guests === 'refused') return 'guest';
  return undefined;
}

function slackUserFromMention(value: string): string {
  const trimmed = value.trim();
  return /^<@([^|>]+)(\|[^>]*)?>$/.exec(trimmed)?.[1] ?? trimmed;
}
