export type MemoryReportReason = 'stale' | 'incorrect' | 'unsafe' | 'unclear';

export type MemoryCommand =
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'show'; target: string }
  | { kind: 'remember'; name: string; description: string; body: string }
  | { kind: 'update'; target: string; description: string; body: string }
  | {
      kind: 'merge';
      targets: string[];
      name: string;
      description: string;
      body: string;
    }
  | { kind: 'forget_request'; target: string }
  | { kind: 'forget_confirm'; token: string }
  | { kind: 'report'; target: string; reason: MemoryReportReason }
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

  if (/^!memory(?:\s+list)?\s*$/i.test(text) || /^what do you remember about this channel\??$/i.test(text)) {
    return { kind: 'list' };
  }
  if (/^!memory\s+help\s*$/i.test(text)) return { kind: 'help' };

  let match = text.match(new RegExp(`^!memory\\s+show\\s+(${TARGET})\\s*$`, 'i'));
  if (match) return { kind: 'show', target: match[1]!.toLowerCase() };

  match = text.match(new RegExp(`^!remember\\s+(.+?)${DASH}([^\\n]+)(?:\\n([\\s\\S]+))?$`, 'i'));
  if (!match) {
    match = text.match(/^remember for this channel:\s*(.+?)\s+(?:—|-)\s+([^\n]+)(?:\n([\s\S]+))?$/i);
  }
  if (match) {
    return contentCommand('remember', match[1]!, match[2]!, match[3]);
  }

  match = text.match(/^can you remember(?:\s+that|:)\s+([\s\S]+)$/i);
  if (match) return conversationalRememberCommand(match[1]!);
  match = text.match(/^(?:please\s+)?remember(?:\s+that|:)\s+([\s\S]+)$/i);
  if (match) {
    // "Remember that ...?" is commonly a recall question, not mutation
    // intent. The explicit !remember grammar remains available when the
    // content itself genuinely needs to end in a question mark.
    if (/\?\s*$/u.test(match[1]!)) return undefined;
    return conversationalRememberCommand(match[1]!);
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

  match = text.match(
    /^!memory\s+merge\s+(.+?)\s+as\s+(.+?)\s+(?:—|-)\s+([^\n]+)\n([\s\S]+)$/i,
  );
  if (match) {
    const targets = match[1]!
      .trim()
      .split(/\s+/)
      .map((target) => target.toLowerCase());
    if (targets.length < 2 || targets.some((target) => !new RegExp(`^${TARGET}$`).test(target))) {
      return invalid('Use `!memory merge <slug-a> <slug-b> as <new-name> — <description>` followed by a body.');
    }
    return {
      kind: 'merge',
      targets,
      name: match[2]!.trim(),
      description: match[3]!.trim(),
      body: match[4]!.trim(),
    };
  }

  match = text.match(/^!forget\s+confirm\s+([A-Za-z0-9._-]{4,512})\s*$/i);
  if (match) return { kind: 'forget_confirm', token: match[1]! };
  match = text.match(new RegExp(`^!forget\\s+(${TARGET})\\s*$`, 'i'));
  if (!match) {
    match = text.match(new RegExp(`^forget memory\\s+[\u0060]?(${TARGET})[\u0060]?\\.?$`, 'i'));
  }
  if (match) return { kind: 'forget_request', target: match[1]!.toLowerCase() };

  match = text.match(
    new RegExp(`^!memory\\s+report\\s+(${TARGET})\\s+(stale|incorrect|unsafe|unclear)\\s*$`, 'i'),
  );
  if (match) {
    return {
      kind: 'report',
      target: match[1]!.toLowerCase(),
      reason: match[2]!.toLowerCase() as MemoryReportReason,
    };
  }

  if (/^!(?:memory|remember|forget)\b/i.test(text) || /^(?:remember for this channel|update memory|forget memory)\b/i.test(text)) {
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

function conversationalRememberCommand(rawContent: string): MemoryCommand {
  const body = conversationalContent(rawContent);
  if (!body) return invalid('Say what Chickpea should remember.');
  const description = body.split('\n', 1)[0]!.trim();
  const name = description
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,:;!?]+$/u, '')
    .split(' ')
    .slice(0, 8)
    .join(' ')
    .slice(0, 80)
    .trim();
  if (!name) return invalid('Say what Chickpea should remember.');
  return { kind: 'remember', name, description, body };
}

function conversationalContent(rawContent: string): string {
  return rawContent.trim().replace(/\?\s*$/u, '').trim();
}

function invalid(hint: string): MemoryCommand {
  return { kind: 'invalid', hint };
}
