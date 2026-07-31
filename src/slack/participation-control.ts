export type SlackParticipationMode = 'ambient' | 'mention_only';
export type SlackParticipationScope = 'channel' | 'thread';

export interface SlackParticipationControl {
  mode: SlackParticipationMode;
  scope: SlackParticipationScope;
}

/** Deliberately narrow direct-instruction parser. It recognizes controls, not
 * discussions about controls, and the host applies it only to verified,
 * guaranteed human turns. */
export function parseSlackParticipationControl(text: string): SlackParticipationControl | null {
  const normalized = text
    .replace(/<@[A-Z0-9_-]+>/g, ' ')
    .trim()
    .toLowerCase();
  const direct = normalized
    .replace(/^(?:please\s+|can you\s+|could you\s+)/, '')
    .replace(/[.!]+$/, '')
    .trim();
  const scope: SlackParticipationScope | null = /\b(?:this|the)\s+thread\b/.test(normalized)
    ? 'thread'
    : /\b(?:this|the)\s+channel\b/.test(normalized)
      ? 'channel'
      : null;
  if (!scope) return null;
  if (
    /^(?:only|just)\s+(?:respond|reply|answer)\s+when\s+(?:you(?:'re| are)\s+)?(?:mentioned|tagged)\s+in\s+(?:this|the)\s+(?:thread|channel)$/.test(direct) ||
    /^(?:go|stay)\s+quiet\s+in\s+(?:this|the)\s+(?:thread|channel)$/.test(direct)
  ) {
    return { mode: 'mention_only', scope };
  }
  if (
    /^(?:resume|allow|enable)\s+ambient\s+(?:responses?|participation)\s+in\s+(?:this|the)\s+(?:thread|channel)$/.test(direct) ||
    /^(?:respond|reply|answer)\s+(?:again\s+)?without\s+(?:a\s+)?(?:mention|tag)\s+in\s+(?:this|the)\s+(?:thread|channel)$/.test(direct)
  ) {
    return { mode: 'ambient', scope };
  }
  return null;
}
