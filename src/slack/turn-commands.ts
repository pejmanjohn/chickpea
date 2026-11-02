import { parseMemoryCommand } from '../memory/commands.ts';
import { parseRoutineCommand } from '../routines/commands.ts';
import { isRoutineSlackTurn } from '../routines/slack-context.ts';
import { isLaterCoAddressedTurn } from './agent-asks.ts';
import type { SlackCommandAddress } from './command-address.ts';
import type { NormalizedSlackTurn } from './types.ts';

/**
 * Only a person's message can be a memory or schedule command: an ask's text
 * is the asking Agent's, a setup's wake is Chickpea's note, and a message
 * that mentioned several Agents is one command, for the first.
 */
export function slackTurnTypedByPerson(
  turn: Pick<NormalizedSlackTurn, 'agentAsk' | 'setupWake' | 'coAddressed'>,
): boolean {
  return !turn.agentAsk && !turn.setupWake && !isLaterCoAddressedTurn(turn);
}

/**
 * A turn the host answers without the Agent: a management approval, or an
 * exact memory or routine command a person typed. It freezes no plan.
 */
export function isDeterministicSlackCommand(turn: NormalizedSlackTurn, address: SlackCommandAddress): boolean {
  const typedByPerson = slackTurnTypedByPerson(turn);
  return Boolean(turn.managementApprovalProposalId) ||
    (typedByPerson && Boolean(parseMemoryCommand(turn.text))) ||
    (typedByPerson && isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text, address)));
}
