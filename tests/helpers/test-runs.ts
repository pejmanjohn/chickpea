/**
 * Test runs over one hosted installation's real stores: a V5 plan, a start
 * request as try_agent_once builds one, and a fake instance whose every call
 * is recorded by instance, so a test can say which steps reached it.
 */
import type { RuntimePlanV2 } from '../../src/agents/runtime-plan.ts';
import { compileTestRunPlan } from '../../src/agents/test-run-plan.ts';
import { installationOwnershipOf } from '../../src/config/installation-scope.ts';
import type { ResolvedAssignment } from '../../src/config/types.ts';
import type { TestRunStartRequest } from '../../src/management/test-run-types.ts';
import {
  TestRunLifecycle,
  type TestRunDispatch,
  type TestRunInstancePort,
  type TestRunInstanceSettlement,
} from '../../src/state/test-run-lifecycle.ts';
import { TestRunUsageRecorder } from '../../src/usage/test-run-usage.ts';
import type { HostedInstallation } from './installation-objects.ts';

export const TEST_RUN_MODEL = 'anthropic/claude-haiku-4-5';
export const TEST_RUN_WORKSPACE = 'T0TESTRUNS';

const ASSIGNMENT: ResolvedAssignment = {
  workspaceId: TEST_RUN_WORKSPACE, channelId: 'D0TESTRUNS', agentId: 'agent_tested', model: TEST_RUN_MODEL,
  runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
  // Frozen at admission, as the installation's own stored key.
  modelCredential: {
    credentialRefId: 'cred_anthropic_stored', version: 1, providerId: 'anthropic', sourceKind: 'stored',
    label: 'Anthropic', scopeLabel: null, unknownRotation: false,
  },
  agent: {
    id: 'agent_tested', kind: 'user', revision: 1, name: 'Tested', instructions: 'Answer.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
};

export function testRunPlan(
  installation: HostedInstallation | undefined,
  run: { testRunId: string; coordinateToken: string; actorMembershipId: string },
): RuntimePlanV2 {
  const ownership = installation ? installationOwnershipOf(installation.env) : undefined;
  return compileTestRunPlan({
    assignment: ASSIGNMENT, runtimeModel: TEST_RUN_MODEL,
    imageCapability: { role: 'image', filled: false, acceptsImageInput: false }, sandboxUnavailableFallback: false,
    websiteLogins: [], webSearch: false, connections: [],
  }, {
    workspaceId: TEST_RUN_WORKSPACE, actorMembershipId: run.actorMembershipId, testRunId: run.testRunId,
    coordinateToken: run.coordinateToken, ...(ownership ? { installation: ownership } : {}),
    instructions: 'Answer.', memoryEpoch: 1,
  });
}

let sequence = 0;

/** A start request for one caller, with fresh IDs unless given. */
export function startRequest(
  installation: HostedInstallation,
  options: { organizationId?: string; actorMembershipId?: string; idempotencyKey?: string; at?: number; agentId?: string } = {},
): TestRunStartRequest {
  sequence += 1;
  const testRunId = `testrun_${String(sequence).padStart(4, '0')}`;
  const coordinateToken = `${'abcdefghijklmnopqrstuv'}${sequence.toString(32).padStart(4, 'a')}`.replace(/[0189]/g, 'z');
  const actorMembershipId = options.actorMembershipId ?? 'membership_caller';
  const plan = testRunPlan(installation, { testRunId, coordinateToken, actorMembershipId });
  return {
    run: {
      testRunId,
      runToken: `tr_${testRunId}`,
      coordinateToken,
      organizationId: options.organizationId ?? installation.organizationId,
      actorMembershipId,
      agentId: options.agentId ?? ASSIGNMENT.agentId,
      idempotencyKey: options.idempotencyKey ?? `key_${testRunId}`,
      usage: TestRunUsageRecorder.admission({
        testRunId, startedAt: options.at ?? Date.now(), workspaceId: TEST_RUN_WORKSPACE, agentId: ASSIGNMENT.agentId,
        agentLabel: ASSIGNMENT.agent.name, requesterMembershipId: actorMembershipId, requestedModel: TEST_RUN_MODEL,
        credentialRefId: null, credentialVersion: null, platformEnv: installation.env,
      }),
    },
    message: 'Where is order 42?',
    initialData: {
      runtimePlan: JSON.parse(JSON.stringify(plan)) as unknown,
      requester: { name: 'Pat', timezone: 'UTC', askedAt: options.at ?? Date.now() },
    },
  };
}

/** A test run's instance, as the platform would answer for it, every call recorded with its instance. */
export class FakeTestRunInstances implements TestRunInstancePort {
  readonly calls: Array<[string, string]> = [];
  readonly dispatched: TestRunDispatch[] = [];
  readonly erased = new Set<string>();
  /** What each instance's settlement read answers; unsettled by default. */
  readonly settlements = new Map<string, TestRunInstanceSettlement>();
  dispatchFails = false;
  /** Erases that fail before one succeeds. */
  eraseFailures = 0;
  abortFails = false;
  /** What every instance reads once dispatched, unless it has its own. */
  settleEvery: TestRunInstanceSettlement | undefined;
  /** What an answered abort leaves the instance reading, as Flue settles an aborted submission. */
  settleOnAbort: TestRunInstanceSettlement | undefined;
  private submissions = 0;

  async dispatch(instanceId: string, dispatch: TestRunDispatch): Promise<{ submissionId: string }> {
    this.calls.push(['dispatch', instanceId]);
    this.dispatched.push(dispatch);
    if (this.dispatchFails) throw new Error('The dispatch receipt was lost.');
    this.submissions += 1;
    return { submissionId: `sub_${this.submissions}` };
  }

  async abort(instanceId: string): Promise<void> {
    this.calls.push(['abort', instanceId]);
    if (this.abortFails) throw new Error('The abort was not answered.');
    if (this.settleOnAbort) this.settlements.set(instanceId, this.settleOnAbort);
  }

  async settlement(instanceId: string): Promise<TestRunInstanceSettlement> {
    this.calls.push(['settlement', instanceId]);
    return this.settlements.get(instanceId) ?? this.settleEvery ?? { kind: 'unsettled' };
  }

  async erase(instanceId: string): Promise<void> {
    this.calls.push(['erase', instanceId]);
    if (this.eraseFailures > 0) {
      this.eraseFailures -= 1;
      throw new Error('The erase failed.');
    }
    this.erased.add(instanceId);
  }

  async creditBack(submissionId: string, reason: string): Promise<void> {
    this.calls.push([`credit_back:${reason}`, submissionId]);
  }

  /** The calls that reached one instance, by name. */
  on(instanceId: string): string[] {
    return this.calls.filter(([, id]) => id === instanceId).map(([call]) => call);
  }
}

/** A clock the lifecycle and the test both read. */
export class TestClock {
  constructor(public at: number) {}
  now = (): number => this.at;
  advance(ms: number): void {
    this.at += ms;
  }
}

/** The lifecycle the installation's state store runs, over a fake instance and the test's clock. */
export function testRunLifecycle(installation: HostedInstallation, instances: FakeTestRunInstances, clock: TestClock): TestRunLifecycle {
  return new TestRunLifecycle({
    stores: () => installation.stores,
    port: async () => instances,
    armAlarm: async (at) => {
      if (installation.storage.alarm === null || at < installation.storage.alarm) await installation.storage.setAlarm(at);
    },
    now: clock.now,
    platformEnv: installation.env,
  });
}
