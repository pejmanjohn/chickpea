export type SlackParticipationMode = 'ambient' | 'mention_only';

export interface SlackParticipationControl {
  mode: SlackParticipationMode;
  scope: 'thread';
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
  if (!/\b(?:this|the)\s+thread\b/.test(normalized)) return null;
  if (
    /^(?:only|just)\s+(?:respond|reply|answer)\s+when\s+(?:you(?:'re| are)\s+)?(?:mentioned|tagged)\s+in\s+(?:this|the)\s+thread$/.test(direct) ||
    /^(?:go|stay)\s+quiet\s+in\s+(?:this|the)\s+thread$/.test(direct)
  ) {
    return { mode: 'mention_only', scope: 'thread' };
  }
  if (
    /^(?:resume|allow|enable)\s+ambient\s+(?:responses?|participation)\s+in\s+(?:this|the)\s+thread$/.test(direct) ||
    /^(?:respond|reply|answer)\s+(?:again\s+)?without\s+(?:a\s+)?(?:mention|tag)\s+in\s+(?:this|the)\s+thread$/.test(direct)
  ) {
    return { mode: 'ambient', scope: 'thread' };
  }
  return null;
}
