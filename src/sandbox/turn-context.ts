export const SANDBOX_TURN_ID_HEADER = 'x-chickpea-sandbox-turn-id';

const activeTurnIds = new Map<string, string>();

export function setActiveSandboxTurn(threadId: string, turnId: string): void {
  activeTurnIds.set(threadId, turnId);
}

export function clearActiveSandboxTurn(threadId: string, turnId: string): void {
  if (activeTurnIds.get(threadId) === turnId) {
    activeTurnIds.delete(threadId);
  }
}

export function activeSandboxTurnId(threadId: string): string | undefined {
  return activeTurnIds.get(threadId);
}
