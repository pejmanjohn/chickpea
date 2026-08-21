export type MemoryCommand =
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'show'; target: string }
  | { kind: 'remember'; name: string; description: string; body: string }
  | { kind: 'update'; target: string; description: string; body: string }
  | { kind: 'clear_request' }
  | { kind: 'invalid'; hint: string };

export type ParsedMemoryCommand = MemoryCommand | { kind: 'candidate' };

const TARGET = '[a-z0-9][a-z0-9/-]{0,128}';
const DASH = '\\s+(?:—|-)\\s+';

export function parseMemoryCommand(
  rawText: string,
  resolvedBotUserId?: string,
): ParsedMemoryCommand | undefined {
  if (resolvedBotUserId === undefined) {
    const withoutUnresolvedMentions = rawText.replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '');
    if (withoutUnresolvedMentions !== rawText) {
      // run-turn uses this truthy sentinel only to enter the authoritative
      // handler, which resolves Chickpea's user ID and reparses. Do not expose
      // a mutation-shaped command before that identity check.
      return parseMemoryCommand(withoutUnresolvedMentions, '')
        ? { kind: 'candidate' }
        : undefined;
    }
  }
  const text = stripLeadingMentions(rawText, resolvedBotUserId).trim().replace(/\r\n?/g, '\n');
  if (!text) return undefined;

  if (/^!memory(?:\s+list)?\s*$/i.test(text) || /^what do you remember\??$/i.test(text)) {
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
  if (!match) {
    match = text.match(
      new RegExp(`^update memory\\s+[\u0060]?(${TARGET})[\u0060]?:\\s*([^\\n]+)(?:\\n([\\s\\S]+))?$`, 'i'),
    );
  }
  if (match) {
    const description = match[2]!.trim();
    return {
      kind: 'update',
      target: match[1]!.toLowerCase(),
      description,
      body: match[3]?.trim() || description,
    };
  }

  match = text.match(
    new RegExp(
      `^(?:please\\s+)?update\\s+(?:the\\s+)?memory\\s+[\u0060]?(${TARGET})[\u0060]?\\s+(?:to\\s+(?:say\\s+)?(?:that\\s+)?|so\\s+(?:that\\s+)?)([\\s\\S]+)$`,
      'i',
    ),
  );
  if (match) {
    const content = conversationalContent(match[2]!);
    if (!content) return invalid('Say what the memory should contain.');
    return { kind: 'update', target: match[1]!.toLowerCase(), description: content, body: content };
  }

  if (/^!forget\s+memory\s*$/i.test(text) || /^forget (?:the )?(?:agent )?memory\.?$/i.test(text)) {
    return { kind: 'clear_request' };
  }

  if (/^!(?:memory|remember|forget)\b/i.test(text) || /^(?:update memory|forget memory)\b/i.test(text)) {
    return invalid('Use `!memory help` to see the exact memory commands.');
  }
  return undefined;
}

function stripLeadingMentions(text: string, resolvedBotUserId: string | undefined): string {
  // Once an identity is supplied, never consume a teammate's mention as
  // though it addressed Chickpea. Empty means no mention stripping (used only
  // while classifying the suffix of an unresolved mention as a candidate).
  if (!resolvedBotUserId) return text;
  const escapedBotUserId = resolvedBotUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*(?:<@${escapedBotUserId}>\\s*)+`), '');
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

function conversationalContent(rawContent: string): string {
  return rawContent.trim().replace(/\?\s*$/u, '').trim();
}

function invalid(hint: string): MemoryCommand {
  return { kind: 'invalid', hint };
}
