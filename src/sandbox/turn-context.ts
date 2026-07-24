export const SANDBOX_TURN_ID_HEADER = 'x-chickpea-sandbox-turn-id';
export const SLACK_ARTIFACT_THREAD_TS_HEADER = 'x-chickpea-slack-artifact-thread-ts';

interface ActiveSandboxTurn {
  turnId: string;
  artifactThreadTs?: string;
}

const activeTurns = new Map<string, ActiveSandboxTurn>();

export function setActiveSandboxTurn(
  threadId: string,
  turnId: string,
  artifactThreadTs?: string,
): void {
  activeTurns.set(threadId, {
    turnId,
    ...(artifactThreadTs === undefined ? {} : { artifactThreadTs }),
  });
}

export function clearActiveSandboxTurn(threadId: string, turnId: string): void {
  if (activeTurns.get(threadId)?.turnId === turnId) {
    activeTurns.delete(threadId);
  }
}

export function activeSandboxTurnId(threadId: string): string | undefined {
  return activeTurns.get(threadId)?.turnId;
}

export function activeSlackArtifactThreadTs(threadId: string): string | undefined {
  return activeTurns.get(threadId)?.artifactThreadTs;
}
