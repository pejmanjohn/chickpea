import type { TestContext } from 'node:test';

import type { AgentAppSlackStep, SlackManifestProblem } from '../../src/slack/agent-apps/slack-api.ts';

export interface LoggedSlackRefusal {
  event: 'chickpea.agent_app.slack_refused';
  step: AgentAppSlackStep;
  agentId: string | null;
  appId: string | null;
  code: string;
  errors: SlackManifestProblem[];
}

/** Every Slack refusal the Agent-app lifecycle logs during the test, in order; other warnings pass through. */
export function captureSlackRefusals(t: TestContext): LoggedSlackRefusal[] {
  const refusals: LoggedSlackRefusal[] = [];
  const warn = console.warn.bind(console);
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    const [line] = args;
    if ((line as Partial<LoggedSlackRefusal> | undefined)?.event === 'chickpea.agent_app.slack_refused') {
      refusals.push(line as LoggedSlackRefusal);
    } else {
      warn(...args);
    }
  });
  return refusals;
}
