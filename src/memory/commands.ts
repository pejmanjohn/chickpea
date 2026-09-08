import {
  stripResolvedSlackCommandAddress,
  stripUnresolvedSlackCommandAddress,
} from '../slack/command-address.ts';

export type MemoryCommand =
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'show'; target: string }
  | { kind: 'remember'; name: string; description: string; body: string }
  | { kind: 'update'; target: string; description: string; body: string }
  | { kind: 'clear_request' }
  | { kind: 'invalid'; hint: string };

type ParsedMemoryCommand = MemoryCommand | { kind: 'candidate' };

const TARGET = '[a-z0-9][a-z0-9/-]{0,128}';
const DASH = '\\s+(?:—|-)\\s+';

export function parseMemoryCommand(
  rawText: string,
  resolvedBotUserId?: string,
  resolvedAgentUserGroupId?: string,
): ParsedMemoryCommand | undefined {
  if (resolvedBotUserId === undefined && resolvedAgentUserGroupId === undefined) {
    const withoutUnresolvedAddress = stripUnresolvedSlackCommandAddress(rawText);
    if (withoutUnresolvedAddress !== rawText) {
      // run-turn uses this truthy sentinel only to enter the authoritative
      // handler, which resolves the base app and Agent IDs and reparses. Do
      // not expose a mutation-shaped command before that identity check.
      return parseMemoryCommand(withoutUnresolvedAddress, '', '')
        ? { kind: 'candidate' }
        : undefined;
    }
  }
  const text = stripResolvedSlackCommandAddress(rawText, {
    botUserId: resolvedBotUserId,
    agentUserGroupId: resolvedAgentUserGroupId,
  }).trim().replace(/\r\n?/g, '\n');
  if (!text) return undefined;

  if (/^!memory(?:\s+list)?\s*$/i.test(text)) {
    return { kind: 'list' };
  }
  if (/^!memory\s+help\s*$/i.test(text)) return { kind: 'help' };

  let match: RegExpMatchArray | null;

  match = text.match(new RegExp(`^!memory\\s+show\\s+(${TARGET})\\s*$`, 'i'));
  if (match) return { kind: 'show', target: match[1]!.toLowerCase() };

  match = text.match(new RegExp(`^!remember\\s+(.+?)${DASH}([^\\n]+)(?:\\n([\\s\\S]+))?$`, 'i'));
  if (match) {
    return contentCommand('remember', match[1]!, match[2]!, match[3]);
  }

  match = text.match(
    new RegExp(`^!memory\\s+update\\s+(${TARGET})${DASH}([^\\n]+)(?:\\n([\\s\\S]+))?$`, 'i'),
  );
  if (match) {
    const description = match[2]!.trim();
    return {
      kind: 'update',
      target: match[1]!.toLowerCase(),
      description,
      body: match[3]?.trim() || description,
    };
  }

  if (/^!forget\s+memory\s*$/i.test(text)) {
    return { kind: 'clear_request' };
  }

  if (/^!(?:memory|remember|forget)\b/i.test(text)) {
    return invalid('Use `!memory help` to see the exact memory commands.');
  }
  return undefined;
}

function contentCommand(
  kind: 'remember',
  name: string,
  descriptionInput: string,
  bodyInput: string | undefined,
): MemoryCommand {
  const description = descriptionInput.trim();
  return {
    kind,
    name: name.trim(),
    description,
    body: bodyInput?.trim() || description,
  };
}

function invalid(hint: string): MemoryCommand {
  return { kind: 'invalid', hint };
}
