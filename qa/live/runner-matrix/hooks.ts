import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

import type { HookRecord, MatrixPlan } from './types.ts';

/**
 * The guarded lane deploy, wrapped in the host reservation as AGENTS.md
 * requires for deployment builds during QA. The same-candidate redeploy is the
 * mechanism earlier runs used for the "Flue interruption / store reset": the
 * new version resets Durable Objects and interrupts in-flight fibers.
 */
export function defaultRedeployCommand(lane: string): { command: string[]; env: Record<string, string> } {
  return {
    command: ['npm', 'run', 'verify:host', '--', '--wait-ms', '300000', 'npm', 'run', 'deploy'],
    env: { CHICKPEA_DEPLOY_TARGET: lane },
  };
}

export interface HookRunnerOptions {
  plan: MatrixPlan;
  t0: number;
  recordDir: string;
  cwd: string;
  allowDeploy: boolean;
  /** Replaces the redeploy command, e.g. for an RPC-based interruption. */
  command?: string[];
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/**
 * Runs deploy hooks at their planned offsets. Deploys share one serial queue:
 * a hook that comes due while another deploy runs waits for it. A running
 * deploy is never killed; stopping only prevents hooks that have not started.
 */
export class HookRunner {
  readonly records: HookRecord[];
  private timers: NodeJS.Timeout[] = [];
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: HookRunnerOptions) {
    this.records = options.plan.hooks.map((hook) => {
      const record: HookRecord = { id: hook.id, kind: hook.kind, caseId: hook.caseId, plannedAt: options.t0 + hook.atMs, startedAt: null, endedAt: null, exitCode: null, skipped: null, log: null };
      if (hook.round !== undefined) record.round = hook.round;
      return record;
    });
  }

  start(): void {
    for (const record of this.records) {
      if (!this.options.allowDeploy) { record.skipped = 'deploy hooks not allowed (pass --allow-deploy)'; continue; }
      this.timers.push(setTimeout(() => this.enqueue(record), Math.max(0, record.plannedAt - Date.now())));
    }
  }

  private enqueue(record: HookRecord): void {
    this.queue = this.queue.then(() => this.execute(record));
  }

  private async execute(record: HookRecord): Promise<void> {
    if (this.stopped) { record.skipped = 'run stopped before the hook started'; return; }
    const fallback = defaultRedeployCommand(this.options.plan.lane);
    const command = this.options.command ?? fallback.command;
    const log = join(this.options.recordDir, `hook-${record.id}.log`);
    record.log = log;
    record.startedAt = Date.now();
    this.options.log?.(`hook ${record.id}: starting ${command.join(' ')} (${Math.round((record.startedAt - record.plannedAt) / 1000)} s after its planned time)`);
    const out = createWriteStream(log, { flags: 'a', mode: 0o600 });
    record.exitCode = await new Promise<number>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), {
        cwd: this.options.cwd,
        env: { ...(this.options.env ?? process.env), ...fallback.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      child.on('error', (error) => { out.write(`spawn error: ${error.message}\n`); resolve(127); });
      child.on('exit', (code) => resolve(code ?? 1));
    });
    record.endedAt = Date.now();
    await new Promise<void>((resolve) => out.end(resolve));
    this.options.log?.(`hook ${record.id}: exit ${record.exitCode} after ${Math.round((record.endedAt - record.startedAt) / 1000)} s`);
  }

  /** Stop scheduling; wait for a deploy already in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const record of this.records) if (!record.startedAt && !record.skipped) record.skipped = 'run stopped before the hook started';
    await this.queue;
  }

  async settled(): Promise<void> { await this.queue; }
}
