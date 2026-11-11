/**
 * The words a practice result and the cards share. A practice run's `off`
 * names a connection it left out with `leftOutLine`, and its fix for a
 * custom MCP connection is labelled `markReadsLabel`, so a card finds the
 * service and its fix in a result without a field of its own.
 */

const LEFT_OUT_TAIL = ' was not available in this practice run, so an answer that needs it can\'t be judged here.';

export function leftOutLine(service: string): string {
  return `${service}${LEFT_OUT_TAIL}`;
}

/** The service a `leftOutLine` names, or undefined for any other line. */
export function leftOutService(line: string): string | undefined {
  return line.endsWith(LEFT_OUT_TAIL) && line.length > LEFT_OUT_TAIL.length ? line.slice(0, -LEFT_OUT_TAIL.length) : undefined;
}

export function markReadsLabel(service: string): string {
  return `Mark ${service}'s read tools`;
}
