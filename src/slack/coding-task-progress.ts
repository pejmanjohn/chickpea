import { activityStatus, type ActivityStatus } from '../activity/semantic.ts';
import type { WorkspaceMilestoneRecord } from './coding-worker-run.ts';

/**
 * A delegated coding task's progress in the turn's working indicator.
 *
 * Slack seals a native stream a few minutes after it starts, so a task that
 * runs for most of an hour has no card it can keep current. Its progress goes
 * to the thread's status instead (`assistant.threads.setStatus`), which the
 * status registry already refreshes before Slack's two-minute expiry:
 *
 * - workspace milestones publish a fixed phrase (see `takeStatus`), and the
 *   worker's own steps arrive as ordinary activity (cloning, running tests,
 *   committing, pushing, opening the pull request);
 * - while a task runs, every status write, including each refresh, shows the
 *   current stage and rotates it with the step the task is in, what the task
 *   has already done, and what comes next (see `display`). The rotation
 *   grows as the task progresses, so a long task keeps telling the person
 *   something new without a clock.
 *
 * Every phrase is fixed product copy. Nothing the worker or the person wrote,
 * and no identifier, path, branch or repository name, reaches Slack.
 */
export interface CodingTaskProgress {
  /**
   * Record one milestone. Replayed records (a reattached turn reads its reply
   * from the start) are harmless: state only moves forward.
   */
  apply(record: WorkspaceMilestoneRecord): void;
  /**
   * The milestone phrase to publish now, once per change: the step of the
   * most recent running task, or undefined when nothing new is running. Read
   * after a burst of records settles, so a reattached turn replaying a task
   * that already finished publishes nothing for it.
   */
  takeStatus(): ActivityStatus | undefined;
  /** Whether a delegated task is running now. */
  active(): boolean;
  /**
   * The text Slack shows for `update`: the status line and the rotating
   * loading messages. Undefined when no task is running, so the caller keeps
   * its ordinary rendering. Called for every write of `update`, so it also
   * learns which of the worker's stages have passed.
   */
  display(update: ActivityStatus): CodingTaskStatusDisplay | undefined;
}

export interface CodingTaskStatusDisplay {
  status: string;
  /** 1 to 10 entries, each at most SLACK_LOADING_MESSAGE_MAX characters. */
  loadingMessages: string[];
}

/** Slack rejects a loading message of 51 or more characters. */
export const SLACK_LOADING_MESSAGE_MAX = 50;
const SLACK_LOADING_MESSAGES_MAX = 10;

const TASK_STEPS = ['Coding workspace', 'Code changes', 'Pull request'] as const;
const NEXT_STEP: ReadonlyArray<string | undefined> = [
  'Next: working on the code changes',
  'Next: opening the pull request',
  undefined,
];

export const CODING_WORKSPACE_SETUP_STATUS = activityStatus(
  'preparing', 'Setting up', 'the coding workspace', 'workspace',
);
export const CODING_WORKER_STARTED_STATUS = activityStatus(
  'running', 'Working on', 'the code changes', 'workspace',
);

const WORKSPACE_READY = 'workspace';

/**
 * A worker stage that leaves something done once it has passed, keyed by the
 * fixed phrase the coordinator receives for it (`bashActivityStatus` in
 * `src/activity/status.ts`). A repeatable stage shows how often it passed.
 */
const STAGE_DONE: Readonly<Record<string, {
  once: string;
  times?: (count: number) => string;
}>> = {
  'Cloning the repository': { once: 'Repository cloned' },
  'Installing dependencies': { once: 'Dependencies installed' },
  'Running the test suite': {
    once: 'Test suite run',
    times: (count) => `Test suite run ${count} times`,
  },
  'Committing the changes': {
    once: 'Changes committed',
    times: (count) => `${count} commits so far`,
  },
  'Pushing the branch': {
    once: 'Branch pushed',
    times: (count) => `Branch pushed ${count} times`,
  },
};

export function createCodingTaskProgress(): CodingTaskProgress {
  // Tasks running now, by tool call, with the step each is in (0-based).
  const running = new Map<string, number>();
  const settled = new Set<string>();
  let latest: string | undefined;
  let published: ActivityStatus | undefined;
  // What the task has done, in the order it happened: the workspace milestone
  // and the worker stages that have passed, with how often each passed.
  const done = new Map<string, number>();
  let currentStage: string | undefined;

  return {
    apply(record) {
      if (settled.has(record.toolCallId)) return;
      if (record.state === 'started' ||
          record.milestone === 'workspace' && record.state === 'completed') {
        // The workspace step is being set up only until it completes; the
        // worker is then on the changes until the pull request step starts.
        const step = record.milestone === 'workspace' && record.state === 'started' ? 0
          : record.milestone === 'pull_request' ? 2
          : 1;
        if (step > 0 && !done.has(WORKSPACE_READY)) done.set(WORKSPACE_READY, 1);
        running.set(record.toolCallId, Math.max(step, running.get(record.toolCallId) ?? 0));
        latest = record.toolCallId;
        return;
      }
      // Any other settled step means the worker returned (or the task
      // stopped); the coordinator's own activity takes over from here.
      running.delete(record.toolCallId);
      settled.add(record.toolCallId);
      if (latest === record.toolCallId) latest = [...running.keys()].at(-1);
    },
    takeStatus() {
      const step = latest === undefined ? undefined : running.get(latest);
      const status = step === undefined
        ? undefined
        : step === 0 ? CODING_WORKSPACE_SETUP_STATUS : CODING_WORKER_STARTED_STATUS;
      if (status === published) return undefined;
      published = status;
      return status;
    },
    active: () => running.size > 0,
    display(update) {
      if (running.size === 0) return undefined;
      const stage = stagePhrase(update.text);
      // A refresh repeats the stage; a different one means the last has passed.
      if (stage !== currentStage) {
        if (currentStage && STAGE_DONE[currentStage]) {
          done.set(currentStage, (done.get(currentStage) ?? 0) + 1);
        }
        currentStage = stage;
      }
      const step = pullRequestStage(update) ? 2 : running.get(latest ?? '') ?? 1;
      const status = fit(`${stage}…`);
      const next = NEXT_STEP[step];
      const messages = [
        status,
        fit(`Step ${step + 1} of ${TASK_STEPS.length} · ${TASK_STEPS[step]}`),
        ...doneLines(done),
        ...(next ? [next] : []),
      ];
      return {
        status,
        loadingMessages: [...new Set(messages)].slice(0, SLACK_LOADING_MESSAGES_MAX),
      };
    },
  };
}

function doneLines(done: ReadonlyMap<string, number>): string[] {
  const lines: string[] = [];
  for (const [key, count] of done) {
    if (key === WORKSPACE_READY) {
      lines.push('Workspace ready');
      continue;
    }
    const phrase = STAGE_DONE[key];
    if (phrase) lines.push(fit(count > 1 && phrase.times ? phrase.times(count) : phrase.once));
  }
  return lines;
}

function stagePhrase(text: string): string {
  const trimmed = text.trim().replace(/…$/, '').trim();
  return trimmed || 'Working on the coding task';
}

function pullRequestStage(update: ActivityStatus): boolean {
  return update.action === 'Opening' && update.object === 'the pull request';
}

/** The first candidate that fits Slack's limit, else the last one cut to fit. */
function fit(...candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate.length <= SLACK_LOADING_MESSAGE_MAX) return candidate;
  }
  const last = candidates.at(-1) ?? '';
  return `${last.slice(0, SLACK_LOADING_MESSAGE_MAX - 1)}…`;
}
