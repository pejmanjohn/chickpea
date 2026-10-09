import type { PlatformEnv } from '../config/state-backend.ts';

/**
 * Slack waits three seconds for an interaction's answer, counted from when it
 * sent the request; after that a modal shows "We had some trouble connecting"
 * even though the answer still arrives. A host that waits on Core answers by
 * a deadline instead, and only one answer reaches Slack: the host's empty
 * acknowledgement or Core's own body. Whoever claims first decides which, so
 * Core never counts on field errors reaching a modal the host already closed.
 */
export interface SlackInteractionAck {
  /** Epoch milliseconds by which Slack must have its answer. */
  readonly deadline: number;
  /** True for the first caller only; that caller's answer is the one Slack gets. */
  claim(): boolean;
}

/**
 * Slack's signed timestamp also counts a cold start before any of our code
 * runs, but it is whole seconds, so this lands 1.6 to 2.6 s after Slack sent
 * the request. The handler's own clock caps it in case Slack's clock runs
 * ahead of ours.
 */
export const SLACK_ACK_AFTER_TIMESTAMP_MS = 2_600;
export const SLACK_ACK_AFTER_START_MS = 2_200;

export function slackInteractionAckDeadline(timestamp: string | null, startedAt: number): number {
  const local = startedAt + SLACK_ACK_AFTER_START_MS;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return local;
  return Math.min(Number(timestamp) * 1_000 + SLACK_ACK_AFTER_TIMESTAMP_MS, local);
}

/** One verified interaction's acknowledgement, from its `X-Slack-Request-Timestamp`. */
export function createSlackInteractionAck(request: Request, startedAt = Date.now()): SlackInteractionAck {
  const deadline = slackInteractionAckDeadline(request.headers.get('x-slack-request-timestamp'), startedAt);
  let claimed = false;
  return {
    deadline,
    claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
  };
}

/**
 * `answer` if it settles first. Otherwise, at the deadline, `late()` if the
 * acknowledgement is still unclaimed; an answer whose maker claimed first is
 * always waited for. `answer` is handed to `waitUntil` here, so it finishes
 * after a late response wherever the runtime would otherwise end the request.
 * A deadline already past fires once timers run, which can still be after
 * Core has claimed.
 */
export function answerSlackInteractionBy<T>(
  ack: SlackInteractionAck,
  answer: Promise<T>,
  late: () => T,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<T> {
  waitUntil(answer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      if (ack.claim()) resolve(late());
    }, Math.max(0, ack.deadline - Date.now()));
  });
  return Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
}

const SLACK_INTERACTION_ACK = Symbol('chickpea.slack-interaction-ack');

/** The env Core serves one interaction with, carrying the host's acknowledgement. */
export function withSlackInteractionAck<E extends PlatformEnv>(env: E, ack: SlackInteractionAck): E {
  return Object.freeze({ ...env, [SLACK_INTERACTION_ACK]: ack });
}

/** The acknowledgement a host attached with withSlackInteractionAck, if any. */
export function slackInteractionAckOf(env: PlatformEnv | undefined): SlackInteractionAck | undefined {
  return (env as { [SLACK_INTERACTION_ACK]?: SlackInteractionAck } | undefined)?.[SLACK_INTERACTION_ACK];
}
