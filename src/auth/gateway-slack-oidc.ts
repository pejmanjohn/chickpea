import type { SlackOidcAttempt } from '../identity/types.ts';
import type { GatewayDeploymentClient } from '../slack/gateway/client.ts';
import {
  SlackOidcError,
  type SlackOidcProof,
  type SlackOidcProvider,
} from './slack-oidc.ts';

/** Slack OIDC broker for the shared app; identity tokens stay at the gateway. */
export class GatewaySlackOidcProvider implements SlackOidcProvider {
  constructor(private readonly client: GatewayDeploymentClient) {}

  async authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    teamId: string;
  }): Promise<string> {
    try {
      return (await this.client.beginOidc(input)).authorizationUrl;
    } catch {
      throw new SlackOidcError('slack_unreachable');
    }
  }

  async exchangeAndVerify(input: {
    attempt: SlackOidcAttempt;
    code: string;
    nonce: string;
  }): Promise<SlackOidcProof> {
    try {
      return await this.client.exchangeOidc({
        attemptId: input.attempt.id,
        code: input.code,
        nonce: input.nonce,
        expectedTeamId: input.attempt.expectedTeamId,
        expectedSlackUserId: input.attempt.expectedSlackUserId,
      });
    } catch {
      throw new SlackOidcError('invalid_token');
    }
  }
}
