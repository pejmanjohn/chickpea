import type { z } from 'zod';

import type * as schemas from '../management/mcp-v5/schemas.ts';

type Check = z.infer<typeof schemas.checkAgentOutput>['checks'][number];

/**
 * What a card says about one part of check_agent: the server's plain words.
 * A row without them, from an older server or of a shape the card does not
 * know, gets a sentence for its part and status. Never `detail`, which may
 * carry a status code, the service's own error text or an ID.
 */
export function plainWords(check: Pick<Check, 'part' | 'status'> & { plain?: unknown }): string {
  return typeof check.plain === 'string' && check.plain !== '' ? check.plain : FALLBACK[check.part][check.status];
}

const FALLBACK: Record<Check['part'], Record<Check['status'], string>> = {
  connection: {
    ok: 'Connected.',
    warning: 'Connected, but something needs a look.',
    failing: 'It is not working.',
    unknown: 'The check could not tell whether it works.',
  },
  model: {
    ok: 'It can run.',
    warning: 'It may not run as expected.',
    failing: 'It cannot run now.',
    unknown: 'The check could not tell whether it can run.',
  },
  slack: {
    ok: 'Ready in Slack.',
    warning: 'Not ready in Slack yet.',
    failing: 'It has a problem in Slack.',
    unknown: 'The check could not tell whether it is ready in Slack.',
  },
  channel: {
    ok: 'Answers here.',
    warning: 'Not answering here yet.',
    failing: 'It cannot answer here.',
    unknown: 'The check could not tell whether it answers here.',
  },
  schedule: {
    ok: 'On schedule.',
    warning: 'Some of its runs need a look.',
    failing: 'Its runs are failing.',
    unknown: 'The check could not tell whether it runs.',
  },
  repository: {
    ok: 'GitHub access is installed.',
    warning: 'GitHub access needs a look.',
    failing: 'It cannot reach this repository.',
    unknown: 'The check could not tell whether it can reach this repository.',
  },
  website_login: {
    ok: 'Ready to sign in.',
    warning: 'This login needs a look.',
    failing: 'It cannot sign in.',
    unknown: 'The check could not tell whether it can sign in.',
  },
  admission: {
    ok: 'A message reaches it.',
    warning: 'A message may not reach it.',
    failing: 'A message does not reach it.',
    unknown: 'Slack decides when the message arrives.',
  },
};
