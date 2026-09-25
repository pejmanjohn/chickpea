import { DurableObject } from 'cloudflare:workers';

import { DoSqlStateDb } from '../state/do-state-db.ts';
import {
  ThreadRunnerJobStore,
  type ThreadRunnerJob,
  type ThreadRunnerStatus,
} from './thread-runner-jobs.ts';

export interface SlackThreadRunnerRpc {
  admit(job: ThreadRunnerJob): Promise<{ admitted: boolean }>;
  status(): Promise<ThreadRunnerStatus>;
}

/**
 * Per-thread Slack turn runner (binding `SLACK_THREAD_RUNNER`, migration v11),
 * addressed by `idFromName(threadKey)`. This release ships the class inactive:
 * nothing addresses it at runtime, and its alarm only logs because no executor
 * is enabled. Declaring the class on its own isolates the Durable Object
 * lifecycle change, which Cloudflare cannot roll back across, from the later
 * release that moves turn execution here.
 */
export class SlackThreadRunner extends DurableObject implements SlackThreadRunnerRpc {
  private jobs: ThreadRunnerJobStore | undefined;

  private store(): ThreadRunnerJobStore {
    this.jobs ??= new ThreadRunnerJobStore(new DoSqlStateDb(this.ctx.storage));
    return this.jobs;
  }

  async admit(job: ThreadRunnerJob): Promise<{ admitted: boolean }> {
    const result = this.store().admit(job, Date.now());
    // Never postpone an alarm that is already armed.
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
    return result;
  }

  async status(): Promise<ThreadRunnerStatus> {
    return this.store().status();
  }

  async alarm(): Promise<void> {
    const { total } = this.store().status();
    console.info({ component: 'runtime', event: 'thread_runner_alarm', jobs: total, executor: 'none' });
  }
}
