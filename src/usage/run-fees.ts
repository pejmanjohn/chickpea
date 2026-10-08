import type { SemanticActivityDescriptor } from '../activity/semantic.ts';

/** A run a person asked for in Slack, or a scheduled run. */
export type RunKind = 'interactive' | 'scheduled';

export type RunAction =
  | { readonly kind: 'tool'; readonly toolName: string; readonly descriptor: SemanticActivityDescriptor | undefined }
  /** A scheduled run delivering its result. */
  | { readonly kind: 'post' };

/** Whether an action makes a run a task, which posts the run's task fee row. */
export function qualifiesAsTask(runKind: RunKind, action: RunAction): boolean {
  if (runKind === 'scheduled') return action.kind === 'post';
  return action.kind === 'tool' && action.toolName === 'read_slack_channel';
}
