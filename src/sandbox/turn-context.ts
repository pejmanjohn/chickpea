/**
 * Cross-isolate turn state lives in the Sandbox Durable Object, never in a
 * module global. The caller prepares the exact Slack job id before forwarding
 * to Flue; the agent DO reads it back when it configures the sandbox.
 */
export interface SandboxTurnContext {
  prepareTurn(turnId: string): Promise<void>;
  getTurnId(): Promise<string | undefined>;
}

export async function prepareSandboxTurn(
  sandbox: Pick<SandboxTurnContext, 'prepareTurn'>,
  turnId: string,
): Promise<void> {
  await sandbox.prepareTurn(turnId);
}

export async function requireSandboxTurnId(
  sandbox: Pick<SandboxTurnContext, 'getTurnId'>,
): Promise<string> {
  const turnId = await sandbox.getTurnId();
  if (!turnId) {
    throw new Error('Sandbox turn context was not prepared before agent dispatch');
  }
  return turnId;
}
