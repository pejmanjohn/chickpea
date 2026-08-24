export const MANAGED_ARTIFACT_ARGUMENT = '__chickpeaArtifact';

export interface ManagedConnectionArtifact {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  workspaceId: string;
  agentId: string;
  retention: 'invocation';
}
