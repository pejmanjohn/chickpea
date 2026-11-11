/**
 * The words a practice result uses for a connection it left out: its `off`
 * line, and the label of the fix that marks a custom or catalog MCP
 * connection's read tools. A card reads the result's `leftOut` field, never
 * these sentences.
 */

const LEFT_OUT_TAIL = ' was not available in this practice run, so an answer that needs it can\'t be judged here.';

export function leftOutLine(service: string): string {
  return `${service}${LEFT_OUT_TAIL}`;
}

export function markReadsLabel(service: string): string {
  return `Mark ${service}'s read tools`;
}
