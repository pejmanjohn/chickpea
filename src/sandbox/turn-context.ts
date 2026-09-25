/**
 * Cross-isolate turn state lives in the Sandbox Durable Object, never in a
 * module global. Opening a workspace prepares the exact Slack job or routine
 * occurrence id there; the coding worker and the relay read it back.
 */
export interface SandboxTurnContext {
  prepareTurn(turnId: string): Promise<void>;
  getTurnId(): Promise<string | undefined>;
}
