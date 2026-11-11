import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { activityStatus } from '../src/activity/status.ts';
import { wakeSlackAgentObject } from '../src/agents/turn-input.ts';
import { installationOwnershipOf } from '../src/config/installation-scope.ts';
import type { ConfigStoreLogic } from '../src/config/store.ts';
import {
  ADMISSION_STATUS_CAP_MS,
  admissionStatusPresentation,
  showAdmissionStatus,
} from '../src/slack/admission-activity.ts';
import { admissionAgentInstance } from '../src/slack/admission-agent-wake.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import {
  carriedGatewayIdentity,
  effectiveTurnSlackInstallationId,
} from '../src/slack/installation-execution.ts';
import { localSlackPresentationStatePort } from '../src/slack/presentation-state-port.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackRunPresentation,
  type SlackRunPresentationV3,
} from '../src/slack/run-presentations.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import type { ThreadRunnerJob } from '../src/slack/thread-runner-jobs.ts';
import { threadRunnerStub, type ThreadRunnerJobPayload } from '../src/slack/thread-runner-rpc.ts';
import { slackTurnExecutor } from '../src/slack/turn-executor-flag.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { SlackEvent } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { ResidencyHold, residencyHoldMs } from '../src/state/residency-hold.ts';
import { AGENT_MENTION, message, withLane, delivery, type Lane } from './helpers/gateway-admission-lane.ts';

/**
 * The state store shows a turn's opening status, as its Agent, before the
 * turn's first hand-off to its thread runner (TagStateStore.showStatusAtHandoff
 * over admission-activity.ts), so the runner starts with it showing.
 */

// The production hand-off methods of TagStateStore, not copies.
const cloudflare = ts.createSourceFile(
  'cloudflare.ts',
  readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const stateClass = cloudflare.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
assert.ok(stateClass);
const stateMethod = (name: string) => {
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(cloudflare) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(cloudflare);
};
const moduleStatement = (name: string) => {
  const statement = cloudflare.statements.find((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      declaration.name.getText(cloudflare) === name)));
  assert.ok(statement, `production ${name} exists`);
  return statement.getText(cloudflare);
};
const HandoffProbe = vm.runInNewContext(
  ts.transpileModule(
    `${['RELAY_BATCH_WINDOW_MS', 'KEEP_WARM_WINDOW_MS', 'KEEP_WARM_TICK_MS', 'localSlackPresentationState'].map(moduleStatement).join('\n')}
class HandoffProbe { ${[
      'admitSlackTurn', 'afterSlackAdmission', 'dispatchToRunners', 'admitToRunner', 'wakeAgentAtHandoff', 'showStatusAtHandoff',
      'armAlarmNoLaterThan', 'setAlarmNoLaterThan', 'admissionWakeAt', 'runnerMode', 'keepWarmTickAt', 'hold',
    ].map(stateMethod).join('\n')} }\nHandoffProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  {
    Date,
    Promise,
    ResidencyHold,
    residencyHoldMs,
    console: { warn() {} },
    MAX_TURN_DRAIN_BATCH: 16,
    RUNNER_DISPATCH_MAX_PAGES: 4,
    slackTurnExecutor: (env: Record<string, unknown>) => slackTurnExecutor(env, {}),
    slackAgentThreadKey,
    installationOwnershipOf,
    effectiveTurnSlackInstallationId,
    carriedGatewayIdentity,
    threadRunnerStub,
    admissionAgentInstance,
    wakeSlackAgentObject,
    CHICKPEA_SLACK_AGENT_BINDING,
    admissionStatusPresentation,
    showAdmissionStatus,
    localSlackPresentationStatePort,
  },
) as new () => {
  admitSlackTurn(input: { turnJob: TurnJob }): Promise<{ ok: boolean }>;
  dispatchToRunners(stores: unknown, newTurns: boolean, readmitHandoffs?: boolean): Promise<number>;
  admitToRunner(job: PendingTurnJob, firstHandoff?: boolean): Promise<boolean>;
};

/** A value made in the probe's context, as plain data. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** How Slack answers the status: at once, never, with a rejection, or once `landing` settles (with a rejection when `reject`). */
type SlackAnswer = 'ok' | 'never' | 'reject' | { landing: Promise<void>; reject?: boolean };

/**
 * A state store over its own turn rows and presentations, the lane's config,
 * a Slack client answering `answer`, and runners that admit every hand-off.
 * `sent` lists Slack calls and runner hand-offs in the order they were made.
 */
function handoffStore(config: ConfigStoreLogic, answer: SlackAnswer = 'ok', onStatus?: () => void) {
  const db = openStateDb(':memory:');
  let clock = 1_000;
  const turnJobs = new TurnJobStoreLogic(db, () => clock++);
  const presentations = new SlackRunPresentationStoreLogic(db);
  const sent: string[] = [];
  const statuses: Array<Record<string, unknown>> = [];
  const handed: ThreadRunnerJob[] = [];
  const client = {
    apiCall: async (method: string, input: Record<string, unknown>) => {
      sent.push(`${method}:${String(input.status)}`);
      return { ok: true };
    },
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      sent.push('assistant.threads.setStatus');
      statuses.push(input);
      onStatus?.();
      if (answer === 'never') return new Promise(() => undefined);
      if (typeof answer === 'object') await answer.landing;
      if (answer === 'reject' || (typeof answer === 'object' && answer.reject)) {
        throw Object.assign(new Error('An API error occurred: not_allowed'), {
          code: 'slack_webapi_platform_error', data: { ok: false, error: 'not_allowed' },
        });
      }
      return { ok: true };
    } } },
  };
  const stores = {
    turnJobs,
    presentations,
    config,
    objectInventory: { recordAgentInstance() {} },
    slack: {
      admitCanonical: (input: { turnJob: TurnJob }) => {
        turnJobs.enqueue(input.turnJob);
        return { claimed: true, admission: {} };
      },
    },
  };
  const env = {
    SLACK_THREAD_RUNNER: {
      getByName: () => ({
        admit: async (job: ThreadRunnerJob) => {
          sent.push('runner.admit');
          handed.push(plain(job));
          return { admitted: true };
        },
      }),
    },
  };
  const probe = Object.assign(new HandoffProbe(), {
    stores,
    env,
    firstHandoffs: new Set<string>(),
    call(run: (value: typeof stores) => unknown) {
      try {
        return { ok: true, value: run(stores) };
      } catch {
        return { ok: false, error: { code: 'internal', message: 'failed' } };
      }
    },
    ctx: { storage: { getAlarm: async () => null, setAlarm: async () => undefined } },
    createAlarmIdentityResolver: () => async () => ({ client }),
  });
  const payload = (index = 0) => handed[index]?.payload as ThreadRunnerJobPayload;
  return { probe, stores, turnJobs, presentations, sent, statuses, payload, close: () => db.close() };
}

/** A turn admitted by production admission, with the presentation admission froze for it. */
async function admittedTurn(lane: Lane, event: SlackEvent): Promise<{ job: TurnJob; presentation: SlackRunPresentationV3 }> {
  lane.jobs.length = 0;
  await lane.admit(delivery(event));
  const [job] = lane.jobs;
  assert.ok(job?.runId, 'the delivery became a turn with a Run');
  const presentation = await lane.stores.slackState.getRunPresentation!(job.runId);
  assert.equal(presentation?.schemaVersion, 3);
  return { job, presentation: presentation as SlackRunPresentationV3 };
}

/** The built-in Agent answers DMs with the workspace's model. */
function withWorkspaceModel(lane: Lane): void {
  lane.config.putWorkspaceModelDefault({
    workspaceId: 'T1', modelId: 'local-stub/chickpea', provenance: 'admin_selected',
    lastChangedByMembershipId: lane.help.creatorMembershipId!,
  }, lane.config.getWorkspaceModelDefault('T1')?.revision ?? 0);
}

function pending(job: TurnJob, overrides: Partial<PendingTurnJob> = {}): PendingTurnJob {
  return { ...job, attempts: 0, progress: {}, ...overrides } as PendingTurnJob;
}

/** A presentation admitted with semantic status off: no activity to show. */
function withoutActivity(presentation: SlackRunPresentationV3): SlackRunPresentation {
  const { currentActivity: _activity, ...rest } = presentation;
  return rest as SlackRunPresentation;
}

/** The phrase the runner writes for the admitted activity (run-turn's showAdmittedStatus). */
function activityText(presentation: SlackRunPresentationV3): string {
  const activity = presentation.currentActivity!;
  return activityStatus(activity.kind, activity.action, activity.object, activity.family, activity.phase).text;
}

/** Settles within `ms`, or fails: the hand-off never waits past the cap. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('the hand-off waited past its cap')), ms).unref()),
  ]);
}

// Defects caught: no status before the hand-off (the writer never called, or
// called after it), a hand-off that reads the presentation before the write
// (the runner's copy then misses the status and writes it again), a write
// that shows native processing instead (which hides custom text), a status
// under another sender or avatar than the turn's owner, and a hand-off that
// carries no mark of it for turn_latency.
test("a turn that will dispatch shows its status as its Agent before its first hand-off, which carries it shown", async () => {
  await withLane(async (lane) => {
    withWorkspaceModel(lane);
    // The owner admission froze when the Agent's Slack presence and avatar are live.
    const support = { kind: 'selected_agent' as const, persona: {
      name: 'Support', avatarUrl: 'https://chickpea.example/assets/agents/agent_help/avatar/1', avatarRevision: 1,
    } };
    const cases: Array<[
      string, SlackEvent, 'admitSlackTurn' | 'dispatchToRunners',
      SlackRunPresentationV3['owner'] | undefined, Record<string, unknown>,
    ]> = [
      // The selected Agent's name and avatar, from the owner record the runner reads too.
      ['a user Agent mentioned in a Channel', AGENT_MENTION, 'admitSlackTurn', support,
        { username: support.persona.name, icon_url: support.persona.avatarUrl }],
      // Chickpea's own bot, with no persona override.
      ['the built-in Agent in a DM', message({ channel: 'D1', ts: '6000.000100', text: 'hello' }), 'dispatchToRunners',
        undefined, {}],
    ];
    for (const [name, event, entry, owner, persona] of cases) {
      const admitted = await admittedTurn(lane, event);
      const { job } = admitted;
      const presentation = owner ? { ...admitted.presentation, owner } : admitted.presentation;
      if (!owner) assert.equal(presentation.owner.kind, 'chickpea');
      const h = handoffStore(lane.config);
      try {
        h.presentations.putSnapshot(presentation);
        if (entry === 'admitSlackTurn') {
          assert.equal((await h.probe.admitSlackTurn({ turnJob: job })).ok, true);
        } else {
          h.turnJobs.enqueue(job);
          assert.equal(await h.probe.dispatchToRunners(h.stores, true), 1);
        }
        assert.deepEqual(h.sent, ['assistant.threads.setStatus', 'runner.admit'],
          `${name}: the custom status first, with no native processing, then the hand-off`);
        const text = activityText(presentation);
        assert.deepEqual(plain(h.statuses[0]), {
          channel_id: presentation.root.channelId,
          thread_ts: presentation.root.threadTs,
          status: text,
          loading_messages: [text],
          ...persona,
        }, `${name}: as the turn's Agent`);
        const handed = h.payload().presentation as SlackRunPresentationV3;
        assert.deepEqual(handed.activityProjection, { surface: 'assistant_status', state: 'visible' },
          `${name}: the runner's copy shows the status written`);
        assert.equal(handed.currentActivity?.operation.certainty, 'acknowledged');
        assert.equal(handed.currentActivity?.operation.operationId, presentation.currentActivity?.operation.operationId,
          `${name}: admission's own operation, not a new activity`);
        assert.deepEqual(handed, plain(h.presentations.get(presentation.runId)), `${name}: as this store recorded it`);
        const mark = h.payload().admissionStatus;
        assert.ok(mark?.shownAt !== undefined && mark.waitedMs < ADMISSION_STATUS_CAP_MS, `${name}: ${JSON.stringify(mark)}`);
      } finally { h.close(); }
    }
  });
});

// Defects caught: a status shown for a turn that will not dispatch (stopped,
// held, already dispatched, judged react_only, a command, an approval, an
// Agent with no model), for an Agent with its own Slack app, over a turn
// that runs or waits ahead in the conversation (it would replace that turn's
// status, and that turn's clear would then remove this one's), on a hand-off
// made again, or for an activity whose write already began.
test('a turn that will not dispatch, waits behind another, has its own Slack app or is handed over again shows nothing first', async () => {
  await withLane(async (lane) => {
    const { job, presentation } = await admittedTurn(lane, AGENT_MENTION);
    const handOver = async (
      candidate: PendingTurnJob,
      options: { presentation?: SlackRunPresentation; ahead?: TurnJob; again?: boolean } = {},
    ) => {
      const h = handoffStore(lane.config);
      try {
        const admitted = options.presentation ?? presentation;
        h.presentations.putSnapshot(admitted);
        if (options.ahead) h.turnJobs.enqueue(options.ahead);
        h.turnJobs.enqueue(candidate as TurnJob);
        if (options.again) {
          // An unconfirmed hand-off, admitted again by the alarm.
          assert.equal(h.turnJobs.assignRunner(candidate.id), true);
          assert.equal(await h.probe.dispatchToRunners(h.stores, false), 1);
        } else {
          assert.equal(await h.probe.admitToRunner(candidate, true), true, 'the turn is handed over');
        }
        const shown = h.sent.includes('assistant.threads.setStatus');
        if (!shown) {
          assert.deepEqual(h.sent, ['runner.admit']);
          assert.deepEqual(h.payload().presentation, plain(admitted), 'the runner gets the presentation as admitted');
          assert.equal(h.payload().admissionStatus, undefined);
        }
        return shown;
      } finally { h.close(); }
    };
    assert.equal(await handOver(pending(job)), true, 'the same turn shows its status');
    const stop = { schemaVersion: 1, role: 'stopped', source: 'typed', stopperUserId: 'U1', cutoffTs: '5000.000900', stoppedAt: 1 } as const;
    const reactOnly = { disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' } as const;
    const { model: _model, ...noModel } = job.assignment;
    const ahead: TurnJob = {
      ...job, id: 'msg:C1:4999.000100', evtKey: 'evt:ahead', msgKey: 'msg:C1:4999.000100',
      turn: { ...job.turn, eventId: 'Ev_ahead', messageTs: '4999.000100' },
    };
    const silent: Array<[string, PendingTurnJob, Parameters<typeof handOver>[1]?]> = [
      ['stopped before its dispatch', pending(job, { stop })],
      ['held by a stop', pending(job, { stop: { schemaVersion: 1, role: 'held', headId: 'msg:C1:4000.000100' } as NonNullable<PendingTurnJob['stop']> })],
      ['with its plan frozen', pending(job, { runtimePlan: {} as NonNullable<PendingTurnJob['runtimePlan']>, agentInstanceId: `agent_${'a'.repeat(40)}` })],
      ['judged react_only at admission', pending({ ...job, turn: { ...job.turn, interactionIntent: reactOnly } })],
      ['judged react_only by an earlier attempt', pending(job, { progress: { interactionIntent: reactOnly } })],
      ['a memory command', pending({ ...job, turn: { ...job.turn, text: '<@UBOT> !memory help' } })],
      ['an approval', pending({ ...job, turn: { ...job.turn, managementApprovalProposalId: 'proposal_1' } })],
      ['an Agent with no model', pending({ ...job, assignment: noModel as TurnJob['assignment'] })],
      ['an Agent with its own Slack app', pending(job), { presentation: { ...presentation, owner: { kind: 'agent_app', agentName: 'Support' } } }],
      ['semantic status off', pending(job), { presentation: withoutActivity(presentation) }],
      ['an activity whose write already began', pending(job), {
        presentation: { ...presentation, activityProjection: { surface: 'assistant_status', state: 'selected' } },
      }],
      ['behind a turn ahead in its conversation', pending(job), { ahead }],
      ['handed over again', pending(job), { again: true }],
    ];
    for (const [name, candidate, options] of silent) {
      assert.equal(await handOver(candidate, options), false, `${name}: no status before the hand-off`);
    }
  });
});

// Defects caught: a hand-off that waits for Slack past the cap (or for good),
// a write that misses the cap or fails yet reaches the runner's copy (the
// runner then skips its own opening writes with nothing showing), and a late
// write that changes this store's row after the hand-off.
test('a status write that misses the cap or fails hands off on time, with the presentation as admitted', async () => {
  await withLane(async (lane) => {
    const { job, presentation } = await admittedTurn(lane, AGENT_MENTION);
    for (const answer of ['never', 'reject', 'late', 'late rejection'] as const) {
      let land!: () => void;
      const landing = new Promise<void>((resolve) => { land = resolve; });
      const h = handoffStore(lane.config, answer === 'late' ? { landing }
        : answer === 'late rejection' ? { landing, reject: true }
        : answer);
      try {
        h.presentations.putSnapshot(presentation);
        const startedAt = performance.now();
        assert.equal((await within(h.probe.admitSlackTurn({ turnJob: job }), ADMISSION_STATUS_CAP_MS + 1_000)).ok, true);
        const waited = performance.now() - startedAt;
        assert.deepEqual(h.sent.slice(0, 1), ['assistant.threads.setStatus'], `${answer}: the status was tried`);
        assert.equal(h.sent.at(-1), 'runner.admit', `${answer}: then the turn was handed over`);
        assert.deepEqual(h.payload().presentation, plain(presentation), `${answer}: the runner gets the presentation as admitted`);
        const mark = h.payload().admissionStatus;
        assert.ok(mark && mark.shownAt === undefined, `${answer}: no status shown: ${JSON.stringify(mark)}`);
        if (answer === 'reject') {
          assert.ok(waited < ADMISSION_STATUS_CAP_MS, `${answer}: a failure hands off at once (${waited} ms)`);
        } else {
          assert.ok(waited >= ADMISSION_STATUS_CAP_MS - 5 && waited < ADMISSION_STATUS_CAP_MS + 1_000,
            `${answer}: handed off at the cap (${waited} ms)`);
          assert.ok(mark.waitedMs >= ADMISSION_STATUS_CAP_MS - 5);
        }
        land();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(plain(h.presentations.get(presentation.runId)), plain(presentation),
          `${answer}: nothing that lands later moves this store's row`);
        // A late rejection would otherwise start native processing, which could
        // land after the runner's own hand-over and hide its custom status.
        assert.equal(h.sent.at(-1), 'runner.admit', `${answer}: and nothing more reaches Slack: ${JSON.stringify(h.sent)}`);
      } finally { h.close(); }
    }
  });
});

// Defect caught: a write that records its copy over a row another writer
// moved meanwhile (a stop that closed the turn), undoing that writer's change.
test("a status write keeps a row another writer moved meanwhile", async () => {
  await withLane(async (lane) => {
    const { job, presentation } = await admittedTurn(lane, AGENT_MENTION);
    let settled: SlackRunPresentation | undefined;
    const h = handoffStore(lane.config, 'ok', () => {
      // A stop dropped the turn while Slack took its status.
      settled = h.presentations.settleUnstarted(presentation.runId);
    });
    try {
      h.presentations.putSnapshot(presentation);
      assert.equal((await h.probe.admitSlackTurn({ turnJob: job })).ok, true);
      assert.ok(settled && settled.projectionVersion > presentation.projectionVersion);
      assert.deepEqual(plain(h.presentations.get(presentation.runId)), plain(settled), "the stop's row stands");
      assert.deepEqual(h.payload().presentation, plain(settled), 'and is what the runner gets');
      assert.equal(h.payload().admissionStatus?.shownAt, undefined);
    } finally { h.close(); }
  });
});

// Defect caught: the alarm admitting a turn again while its first hand-off
// waits for Slack. The runner would take the presentation from before the
// status, start the turn, then take the later one over the copy it runs on.
test('no re-admission overtakes a first hand-off that waits for its status', async () => {
  await withLane(async (lane) => {
    const { job, presentation } = await admittedTurn(lane, AGENT_MENTION);
    let land!: () => void;
    const landing = new Promise<void>((resolve) => { land = resolve; });
    const h = handoffStore(lane.config, { landing });
    try {
      h.presentations.putSnapshot(presentation);
      const first = h.probe.admitSlackTurn({ turnJob: job });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(h.sent, ['assistant.threads.setStatus'], 'the first hand-off waits for Slack');
      assert.equal(await h.probe.dispatchToRunners(h.stores, false), 0, 'the alarm admits nothing again meanwhile');
      land();
      assert.equal((await first).ok, true);
      assert.deepEqual(h.sent, ['assistant.threads.setStatus', 'runner.admit']);
      assert.equal((h.payload().presentation as SlackRunPresentationV3).activityProjection.state, 'visible');
    } finally { h.close(); }
  });
});
