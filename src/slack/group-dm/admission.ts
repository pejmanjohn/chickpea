import { admitNamedPeople, type NamedPeopleRefusal } from '../requested-conversations/people.ts';
import type { RequesterTextSource } from '../requester-text-source.ts';

/** A Slack group DM holds nine members: this app and eight people. */
export const MAX_GROUP_DM_PEOPLE = 8;

export type GroupDmAdmissionRefusal = NamedPeopleRefusal | 'too_few';

export type GroupDmAdmission =
  | { ok: true; people: string[] }
  | { ok: false; code: GroupDmAdmissionRefusal; people?: string[] };

export function admitGroupDmPeople(input: {
  requesterSlackUserId: string;
  requesterText: string | undefined;
  requesterTextSource: RequesterTextSource | undefined;
  people: readonly string[];
}): GroupDmAdmission {
  const admission = admitNamedPeople({ ...input, maxOthers: MAX_GROUP_DM_PEOPLE - 1 });
  if (!admission.ok) return admission;
  if (admission.others.length === 0) return { ok: false, code: 'too_few' };
  return { ok: true, people: [admission.requester, ...admission.others] };
}
