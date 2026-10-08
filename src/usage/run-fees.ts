import type { SemanticActivityDescriptor } from '../activity/semantic.ts';

export type RunKind = 'interactive' | 'scheduled';

export type RunAction =
  | { readonly kind: 'tool'; readonly toolName: string; readonly descriptor: SemanticActivityDescriptor | undefined }
  | { readonly kind: 'post' };

export function qualifiesAsTask(runKind: RunKind, action: RunAction): boolean {
  if (runKind === 'scheduled') return action.kind === 'post';
  return action.kind === 'tool' && action.toolName === 'read_slack_channel';
}
