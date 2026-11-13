/**
 * show_test_report: the report card for a round of practice runs. The model
 * sends each run's token and its own verdict; Chickpea fills in the question
 * and the Agent's answer from its own records of the caller's runs, so the
 * card shows what the Agent really said, and puts them in the result, since a
 * run can be read for an hour only and a reopened chat draws from the result.
 * The verdicts and notes go back in the result and nowhere else. Loaded at a
 * call.
 */
import type { z } from 'zod';

import { ManagementError } from '../types.ts';
import { fail, fiveZeroCode } from './conventions.ts';
import { agentAvatar, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';
import { testRunStore } from './test-runs.ts';

type Input = z.infer<typeof schemas.showTestReportInput>;
type Output = z.infer<typeof schemas.showTestReportOutput>;

/** The longest question a row shows: one line, cut. */
const QUESTION_CHARS = 300;

export async function showTestReport(deps: FiveZeroDeps, input: Input, cardHost: boolean): Promise<Output> {
  const store = await testRunStore(deps);
  const context = await deps.context();
  const { agent, stores } = await deps.service.agentReader(context, input.agentId).catch((error: unknown) => {
    if (error instanceof ManagementError && ['not_found', 'not_allowed'].includes(fiveZeroCode(error.code))) {
      fail('not_found', 'That Agent is gone, or you can\'t change it.');
    }
    throw error;
  });
  const who = { organizationId: context.organizationId, actorMembershipId: context.membershipId };
  const views = await Promise.all(input.runs.map(({ runToken }) => store.observe({ ...who, runToken })));
  // The first run that can't be drawn, in the order they were asked, is the one named.
  const settled = views.map((view, index) => {
    const question = `question ${index + 1}`;
    const { runToken } = input.runs[index]!;
    if (!view) {
      fail('not_found', `The practice run for ${question} is no longer there. Practice runs can be read for an hour after they end.`, {
        nextStep: `runToken ${runToken} (${question}) is gone. Ask that question again with practice_agent, then send its new runToken.`,
      });
    }
    if (view.agentId !== agent.id) {
      fail('invalid_input', `The practice run for ${question} is of another Agent.`, {
        nextStep: `runToken ${runToken} (${question}) is not a practice run of this Agent. Send only this Agent's runTokens.`,
      });
    }
    if (view.status !== 'answered' && view.status !== 'failed') {
      fail('in_progress', `The practice run for ${question} is still answering.`, {
        nextStep: `Call get_practice_run with runToken ${runToken} until it is answered, then call show_test_report again.`,
      });
    }
    return view;
  });
  // A run from before practice runs kept their question asked the Agent's first one.
  const firstAsk = settled.some(({ question }) => question === null) ? await stores.config.getAgentFirstAsk?.(agent.id) : undefined;
  const handle = agent.slackPresence?.normalizedHandle || undefined;
  return {
    agent: { agentId: agent.id, name: agent.name, ...(handle ? { handle } : {}), ...agentAvatar(deps, agent) },
    runs: input.runs.map(({ verdict, note, before }, index) => ({
      question: shortLine(settled[index]!.question ?? firstAsk ?? ''),
      verdict,
      ...(note ? { note } : {}),
      ...(before ? { before } : {}),
    })),
    summary: input.summary,
    ...(input.next ? { next: input.next } : {}),
    answers: settled.map(({ status, result }) => status === 'answered' && result?.reply ? result.reply : null),
    nextStep: cardHost
      ? 'The card shows the person this report, and each answer when they open its row. Don\'t repeat it in your reply. It needs no press, so carry on.'
      : 'This client draws no card, so give the person the results in your reply: each question with your verdict and note.',
  };
}

function shortLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > QUESTION_CHARS ? `${line.slice(0, QUESTION_CHARS - 1)}…` : line;
}
