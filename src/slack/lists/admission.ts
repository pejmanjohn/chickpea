import type { SlackContextMessage } from '../thread-context.ts';
import { parseSlackListUrl } from './urls.ts';

const MAX_ADMITTED_LISTS = 16;
const MAX_ADMITTED_LIST_ATTRIBUTE = 512;
const LIST_ID = /^F[A-Z0-9]+$/;

export function collectAdmittedSlackListIds(input: {
  workspaceId: string;
  currentText: string;
  activeRootTs: string;
  contextMessages: readonly SlackContextMessage[];
  instructions?: string | undefined;
  memoryPromptBlock?: string | undefined;
}): string[] {
  const sameRoot = input.contextMessages
    .filter(message => !message.isTrigger && message.rootTs === input.activeRootTs)
    .map(message => message.text);
  const sources = [input.currentText, ...sameRoot, input.instructions, input.memoryPromptBlock];
  const ids = new Set<string>();
  for (const source of sources) {
    for (const url of source?.match(/https:\/\/[^\s<>"'|]+/g) ?? []) {
      try {
        ids.add(parseSlackListUrl(url.replace(/[\]),.;!?]+$/, ''), input.workspaceId).listId);
      } catch {
        // Other links and malformed Slack references grant no admission.
      }
      if (ids.size >= MAX_ADMITTED_LISTS) return [...ids].sort();
    }
  }
  return [...ids].sort();
}

export function serializeAdmittedSlackListIds(ids: readonly string[] | undefined): string | undefined {
  if (!ids?.length) return undefined;
  const values = [...new Set(ids)].sort();
  if (values.length > MAX_ADMITTED_LISTS || values.some(value => !LIST_ID.test(value))) return undefined;
  const serialized = JSON.stringify(values);
  return serialized.length <= MAX_ADMITTED_LIST_ATTRIBUTE ? serialized : undefined;
}

export function parseAdmittedSlackListIds(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ADMITTED_LIST_ATTRIBUTE) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ADMITTED_LISTS ||
        parsed.some(id => typeof id !== 'string' || !LIST_ID.test(id)) ||
        new Set(parsed).size !== parsed.length || JSON.stringify([...parsed].sort()) !== value) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
