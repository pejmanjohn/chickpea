import * as v from 'valibot';

/** Written by `workspace_task` once a coding worker accepted a task this response. */
export const CODING_WORKER_RUN_DATA_NAME = 'chickpeaCodingWorkerRun';

export const CodingWorkerRunSchema = v.strictObject({
  schemaVersion: v.literal(1),
  /** The coding model the worker ran on (canonical id, as the footer names models). */
  model: v.pipe(v.string(), v.minLength(3), v.maxLength(240)),
});

export type CodingWorkerRunRecord = v.InferOutput<typeof CodingWorkerRunSchema>;

/**
 * The coding model that did work in this response, for the reply footer's
 * attribution. Every worker in one response runs on the turn's frozen coding
 * model, so the latest valid record names it.
 */
export function parseCodingWorkerRunModel(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const parsed = v.safeParse(CodingWorkerRunSchema, value[index]);
    if (parsed.success) return parsed.output.model;
  }
  return undefined;
}

/**
 * Written by `workspace_task` once per delegated task that reached a worker:
 * the worker's own model usage, which its coordinator's usage never includes.
 * The relay records it on the turn's usage operation, under the coding model.
 */
export const CODING_WORKER_USAGE_DATA_NAME = 'chickpeaCodingWorkerUsage';

/** More than the tasks one response may delegate; a bound, not a limit. */
const MAX_CODING_WORKER_USAGE_RECORDS = 8;

const TokenCount = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));

export const CodingWorkerUsageSchema = v.strictObject({
  schemaVersion: v.literal(1),
  toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  /** The coding model the worker ran on (canonical id). */
  model: v.pipe(v.string(), v.minLength(3), v.maxLength(240)),
  /** `interrupted`: the task timed out and was stopped; `failed`: the worker failed. */
  status: v.picklist(['completed', 'failed', 'interrupted']),
  /** The worker's reported token usage; absent when it reported none. */
  usage: v.optional(v.strictObject({
    input: TokenCount,
    output: TokenCount,
    cacheRead: TokenCount,
    cacheWrite: TokenCount,
    totalTokens: TokenCount,
  })),
  returnedModel: v.optional(v.strictObject({
    provider: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  })),
});

export type CodingWorkerUsageRecord = v.InferOutput<typeof CodingWorkerUsageSchema>;

/**
 * One record per task, in order. A retried coordinator can write a task's
 * record again; the latest one for a tool call wins.
 */
export function parseCodingWorkerUsage(value: unknown): CodingWorkerUsageRecord[] {
  if (!Array.isArray(value)) return [];
  const byToolCall = new Map<string, CodingWorkerUsageRecord>();
  for (const entry of value) {
    const parsed = v.safeParse(CodingWorkerUsageSchema, entry);
    if (!parsed.success) continue;
    byToolCall.delete(parsed.output.toolCallId);
    byToolCall.set(parsed.output.toolCallId, parsed.output);
  }
  return [...byToolCall.values()].slice(-MAX_CODING_WORKER_USAGE_RECORDS);
}

/**
 * Written by `workspace_task` as a delegated task moves through its steps, so
 * the relay can show them as the run's native task checklist. Records are
 * durable and ordered in the response stream, and replay when the relay
 * re-attaches; applying one twice is harmless.
 */
export const WORKSPACE_MILESTONE_DATA_NAME = 'chickpeaWorkspaceMilestone';

export const WORKSPACE_MILESTONES = ['workspace', 'changes', 'pull_request'] as const;
export type WorkspaceMilestone = (typeof WORKSPACE_MILESTONES)[number];

/** The checklist's fixed title; without one Slack titles it by the active row. */
export const WORKSPACE_PLAN_TITLE = 'Coding task';

/** The checklist rows, in milestone order: result nouns, like the other plans. */
export const WORKSPACE_MILESTONE_LABELS: readonly string[] = [
  'Coding workspace',
  'Code changes',
  'Pull request',
];

export const WORKSPACE_MILESTONE_REASONS = [
  'workspace_unavailable',
  'timeout',
  'worker_failed',
  'stopped',
  'prior_failed',
  'no_branch',
  'no_pull_request',
] as const;

const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,100}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const WorkspaceMilestoneSchema = v.strictObject({
  schemaVersion: v.literal(1),
  toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  milestone: v.picklist(WORKSPACE_MILESTONES),
  state: v.picklist(['started', 'completed', 'changed', 'skipped', 'failed', 'not_run']),
  reason: v.optional(v.picklist(WORKSPACE_MILESTONE_REASONS)),
  /** The branch the worker pushed, when its answer named one. */
  branch: v.optional(v.pipe(v.string(), v.regex(BRANCH_NAME))),
  pullRequests: v.optional(v.pipe(
    v.array(v.strictObject({
      repository: v.pipe(v.string(), v.regex(REPOSITORY_NAME)),
      number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    })),
    v.minLength(1),
    v.maxLength(10),
  )),
});

export type WorkspaceMilestoneRecord = v.InferOutput<typeof WorkspaceMilestoneSchema>;
export type WorkspaceMilestoneOutcome = Exclude<WorkspaceMilestoneRecord['state'], 'started'>;

export function parseWorkspaceMilestone(value: unknown): WorkspaceMilestoneRecord | undefined {
  const parsed = v.safeParse(WorkspaceMilestoneSchema, value);
  return parsed.success ? parsed.output : undefined;
}

/** A branch name safe to show in a checklist row, or undefined. */
export function checklistBranchName(value: string | undefined): string | undefined {
  return value && BRANCH_NAME.test(value) ? value : undefined;
}

/**
 * The row detail for a settled milestone. Always starts with the outcome's
 * own prefix, and names only a branch and pull request numbers the worker
 * reported: never its free text.
 */
export function workspaceMilestoneDetail(record: WorkspaceMilestoneRecord): string | undefined {
  switch (record.state) {
    case 'started':
      return undefined;
    case 'not_run':
      return 'Not run: work stopped after an earlier step failed.';
    case 'skipped':
      return record.milestone === 'pull_request'
        ? 'Skipped: no pull request was opened.'
        : 'Skipped: not needed for this task.';
    case 'failed':
      switch (record.reason) {
        case 'workspace_unavailable': return 'Failed: the coding workspace could not start.';
        case 'timeout': return 'Failed: the task did not finish in time and was stopped.';
        case 'worker_failed': return 'Failed: the coding worker stopped before finishing.';
        default: return 'Failed: the task stopped unexpectedly.';
      }
    case 'changed':
      return record.branch
        ? `Changed: pushed branch ${record.branch}.`
        : 'Changed: the worker pushed its changes.';
    case 'completed':
      if (record.milestone === 'workspace') return 'Completed: the coding workspace is ready.';
      if (record.milestone === 'pull_request' && record.pullRequests?.length) {
        const [first] = record.pullRequests;
        return record.pullRequests.length === 1
          ? `Completed: ${first!.repository}#${first!.number}.`
          : `Completed: ${record.pullRequests.length} pull requests.`;
      }
      return record.milestone === 'changes'
        ? 'Completed: the worker finished without pushing a branch.'
        : 'Completed: the pull request step finished.';
  }
}
