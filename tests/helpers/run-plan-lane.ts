/**
 * A workspace whose Agents freeze run plans through the real Slack turn and
 * routine paths, on in-memory Node stores: an Agent with team, personal and
 * reconnect-needing connections, a website login, a Channel grant, and an
 * Agent whose model's provider has no key. Fixtures name an Agent, a place and
 * an actor, as a run plan built without a Slack event is asked for them.
 */
import type { RoutineRun } from '../../src/routines/types.ts';
import type { EffectiveSlackConfig } from '../../src/config/effective-config.ts';
import type { ResolvedAssignment } from '../../src/config/types.ts';
import type { NormalizedSlackTurn } from '../../src/slack/types.ts';
import type { RuntimePlanV2 } from '../../src/agents/runtime-plan.ts';
import { parseRoutineExecutionInitialData } from '../../src/agents/routine-execution-data.ts';
import { createWebsiteLogin, WEBSITE_LOGINS_SETTING } from '../../src/browser/logins.ts';
import { resolveAssignment } from '../../src/config/resolver.ts';
import { closeNodeStateStores, resolveStores, type AppStores, type PlatformEnv } from '../../src/config/state-backend.ts';
import { resolveEffectiveConnectionAccounts } from '../../src/connections/runtime.ts';
import { executeRoutineOccurrence } from '../../src/routines/execution.ts';
import { SqliteRoutineStore } from '../../src/routines/store.ts';
import { generateCredentialKeyring } from '../../src/slack/credential-keyring.ts';
import { freezeRuntimePlanForTurn } from '../../src/slack/run-turn.ts';

export const WORKSPACE = 'T1RUNPLAN';
export const CHANNEL = 'C1RUNPLAN';
export const ALICE = 'membership_alice';
export const BOB = 'membership_bob';
export const READY_AGENT = 'agent_ops';
export const UNREADY_AGENT = 'agent_unready';
export const TEAM_ACCOUNT = 'connection_team_zendesk';
export const ALICE_ACCOUNT = 'connection_alice_sentry';

/** Where a run happens: a Channel, or a DM with one member. */
export type LanePlace = { kind: 'channel' } | { kind: 'direct'; with: typeof ALICE | typeof BOB };

export interface SlackFixture {
  name: string;
  agentId: string;
  place: LanePlace;
  /** The member the turn acts for; absent for a requester with no membership. */
  actor?: string;
  text: string;
  /** A deployment with a browser key and a search key. */
  browserAndSearch?: boolean;
}

export interface RoutineFixture {
  name: string;
  agentId: string;
  /** The routine's Runs as member, and the connections its schedule admitted. */
  actor: string;
  admittedAccountIds: readonly string[];
  /** The Agent's coding workspace is configured and the sandbox is installed. */
  codingWorkspace?: boolean;
}

export const SLACK_FIXTURES: readonly SlackFixture[] = [
  { name: 'DM with Alice, by Alice', agentId: READY_AGENT, place: { kind: 'direct', with: ALICE }, actor: ALICE,
    text: 'Check the Zendesk queue.', browserAndSearch: true },
  { name: 'Channel, by Alice', agentId: READY_AGENT, place: { kind: 'channel' }, actor: ALICE,
    text: 'Any new Sentry issues?' },
  { name: 'Channel, by Bob, who has no personal account', agentId: READY_AGENT, place: { kind: 'channel' }, actor: BOB,
    text: 'Any new Sentry issues?' },
  { name: 'Channel, by a requester with no membership', agentId: READY_AGENT, place: { kind: 'channel' },
    text: 'Any new Sentry issues?' },
  { name: 'DM with Alice, model with no provider key', agentId: UNREADY_AGENT, place: { kind: 'direct', with: ALICE },
    actor: ALICE, text: 'Summarize this week.' },
];

export const ROUTINE_FIXTURES: readonly RoutineFixture[] = [
  { name: 'Channel routine as Alice, team connection admitted', agentId: READY_AGENT, actor: ALICE,
    admittedAccountIds: [TEAM_ACCOUNT] },
  { name: 'Channel routine as Alice, coding workspace', agentId: READY_AGENT, actor: ALICE,
    admittedAccountIds: [TEAM_ACCOUNT, ALICE_ACCOUNT], codingWorkspace: true },
  { name: 'Channel routine, model with no provider key', agentId: UNREADY_AGENT, actor: ALICE, admittedAccountIds: [] },
];

export const BROWSER_AND_SEARCH_ENV: PlatformEnv = {
  BROWSERBASE_API_KEY: 'bb_test_not_a_key',
  BROWSERBASE_PROJECT_ID: 'proj_test',
  EXA_API_KEY: 'exa_test_not_a_key',
} as unknown as PlatformEnv;

/** Keys a developer's shell may hold that would change what the fixtures resolve. */
const SCRUBBED_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'EXA_API_KEY', 'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID', 'CHICKPEA_TENANCY'] as const;
const STORE_ENV = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;

export interface RunPlanLane {
  stores: AppStores;
  /** The assignment a turn of `agentId` in `place` is admitted with. */
  assignment(agentId: string, place: LanePlace): Promise<ResolvedAssignment>;
  /** The Slack turn a fixture's message arrives as. */
  turn(fixture: SlackFixture): NormalizedSlackTurn;
  platformEnv(fixture: SlackFixture): PlatformEnv | undefined;
}

export function directChannelId(member: string): string {
  return member === ALICE ? 'D1ALICE' : 'D1BOB';
}

function channelIdOf(place: LanePlace): string {
  return place.kind === 'channel' ? CHANNEL : directChannelId(place.with);
}

export async function withRunPlanLane<T>(scenario: (lane: RunPlanLane) => Promise<T>): Promise<T> {
  const saved = new Map([...SCRUBBED_ENV, ...STORE_ENV].map((key) => [key, process.env[key]]));
  for (const key of SCRUBBED_ENV) delete process.env[key];
  for (const key of STORE_ENV) process.env[key] = ':memory:';
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    await seed(stores);
    return await scenario({
      stores,
      assignment: (agentId, place) => resolveAssignment(WORKSPACE, channelIdOf(place), {
        agents: stores.config, grants: stores.config, channels: stores.config, settings: stores.settings,
      }, { agentId, surface: place.kind === 'channel' ? 'channel' : 'direct' }),
      turn: (fixture) => ({
        workspaceId: WORKSPACE,
        channelId: channelIdOf(fixture.place),
        eventId: `Ev_${fixture.name.replace(/\W+/g, '_')}`,
        text: fixture.text,
        userId: fixture.actor === BOB ? 'U1BOB' : 'U1ALICE',
        ...(fixture.actor ? { actorMembershipId: fixture.actor } : {}),
        messageTs: '1793440000.000100',
        threadTs: '1793440000.000100',
        contextMode: 'thread',
        ...(fixture.place.kind === 'channel'
          ? { source: 'app_mention' as const }
          : { source: 'dm_message' as const, channelType: 'im' as const }),
      }),
      platformEnv: (fixture) => fixture.browserAndSearch ? BROWSER_AND_SEARCH_ENV : undefined,
    });
  } finally {
    closeNodeStateStores();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function seed(stores: AppStores): Promise<void> {
  const { config, settings } = stores;
  await config.ensureWorkspaceInstallation({
    workspaceId: WORKSPACE, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1',
  });
  const created = await createWebsiteLogin({
    store: settings as never, keyring: generateCredentialKeyring('run_plan_lane'),
  }, {
    host: 'portal.example.com', label: 'Order portal', ownerKind: 'team', createdByMembershipId: ALICE, method: 'handoff',
  });
  // A fixed id, so every run of a fixture freezes the same plan.
  const login = { ...created, id: 'wl_0000000000000000000000000000000a' };
  await settings.setSetting(WEBSITE_LOGINS_SETTING, (await settings.getSetting(WEBSITE_LOGINS_SETTING))!
    .replace(created.id, login.id));
  const base = {
    enabled: true, lifecycle: 'active' as const, creatorMembershipId: ALICE, editPolicy: 'creator_and_admins' as const,
    mcpServers: [], apiConnections: [], repositories: [],
  };
  await config.createAgent({
    ...base, id: READY_AGENT, name: 'Ops', instructions: 'Keep the queue moving.', model: 'local-stub/ops',
    skills: [{ name: 'triage', description: 'Triage a ticket.', instructions: 'Read it, then label it.', enabled: true }],
    websiteLogins: [{ loginId: login.id, level: 'check', enabled: true }],
  });
  await config.createAgent({
    ...base, id: UNREADY_AGENT, name: 'Unready', instructions: 'Summarize.', model: 'anthropic/claude-sonnet-4-6',
    skills: [],
  });
  await config.putChannel({ workspaceId: WORKSPACE, channelId: CHANNEL, label: 'ops', lifecycle: 'active' });
  for (const agentId of [READY_AGENT, UNREADY_AGENT]) {
    await config.putAgentChannelGrant({
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId, status: 'active',
      createdByMembershipId: ALICE, channelLabel: 'ops', channelIsPrivate: false,
    });
  }
  const apiPolicy = (host: string) => ({
    kind: 'api' as const, allowedHosts: [host], pathPrefixes: ['/api/'], headerName: 'Authorization',
    allowedMethods: ['GET' as const], authMode: 'credential' as const,
  });
  const accounts = [
    { id: TEAM_ACCOUNT, ownerKind: 'team' as const, providerId: 'zendesk', label: 'Zendesk',
      policy: apiPolicy('acme.zendesk.com'), lifecycle: 'ready' as const },
    { id: ALICE_ACCOUNT, ownerKind: 'member' as const, ownerMembershipId: ALICE, providerId: 'sentry',
      label: 'Alice Sentry', policy: apiPolicy('sentry.io'), lifecycle: 'ready' as const },
    { id: 'connection_team_linear', ownerKind: 'team' as const, providerId: 'linear', label: 'Linear',
      policy: apiPolicy('api.linear.app'), lifecycle: 'needs_attention' as const },
  ];
  for (const account of accounts) {
    await config.putConnectionAccount({
      ...account, workspaceId: WORKSPACE, createdByMembershipId: ALICE, secretRefId: `secret_${account.id}`,
    }, 0);
    await config.putAgentConnectionBinding({
      agentId: READY_AGENT, connectionAccountId: account.id, providerId: account.providerId,
      allowedCapabilities: [], enabled: true,
    });
  }
}

/** The plan a real Slack turn freezes for the fixture, or the error it fails with. */
export async function freezeSlackFixturePlan(lane: RunPlanLane, fixture: SlackFixture): Promise<RuntimePlanV2> {
  const { decision } = await freezeRuntimePlanForTurn({
    turn: lane.turn(fixture),
    assignment: await lane.assignment(fixture.agentId, fixture.place),
    platformEnv: lane.platformEnv(fixture),
    settingsStore: lane.stores.settings,
    configStore: lane.stores.config,
    memoryEpoch: Promise.resolve(3),
  });
  return decision.runtimePlan;
}

const ROUTINE_NOW = Date.UTC(2026, 10, 2, 12);

/**
 * The plan a routine occurrence freezes into its dispatch envelope, or the
 * failure the occurrence ends with. Live Slack access is the one seam: it
 * answers as `resolveRoutineRuntimeAccess` does, with the connections the
 * schedule's authority admitted for its Runs as member.
 */
export async function freezeRoutineFixturePlan(
  lane: RunPlanLane,
  fixture: RoutineFixture,
): Promise<{ plan: RuntimePlanV2 } | { failure: string }> {
  const store = new SqliteRoutineStore(':memory:', () => ROUTINE_NOW);
  try {
    const { run, attempt } = await admittedRoutine(store, fixture.name.replace(/\W+/g, '_'));
    const assignment = await lane.assignment(fixture.agentId, { kind: 'channel' });
    const effective = await resolveEffectiveConnectionAccounts({
      config: lane.stores.config, workspaceId: WORKSPACE, agentId: fixture.agentId, actorMembershipId: fixture.actor,
    });
    const config: EffectiveSlackConfig = {
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: assignment.agentId, agent: assignment.agent,
      model: assignment.model!, provider: assignment.model!.split('/')[0]!, instructions: assignment.agent.instructions,
      ...(assignment.effort ? { effort: assignment.effort } : {}),
      modelAttribution: assignment.modelAttribution!,
    };
    await executeRoutineOccurrence({ env: {} as PlatformEnv, store, occurrenceId: run.id, attempt: attempt.attempt }, {
      now: () => ROUTINE_NOW + 1,
      usageRecordingEnabled: false,
      settingsStore: lane.stores.settings,
      usageStore: lane.stores.usage,
      workStore: lane.stores.work,
      modelRoleReader: lane.stores.config,
      persistenceTelemetrySink: { info: () => undefined, error: () => undefined },
      resolveAccess: async () => ({
        config, accessHash: 'a'.repeat(64), botToken: 'xoxb-test', botUserId: 'UBOT',
        actorMembershipId: fixture.actor, actorSlackUserId: 'U1ALICE', authorityReceiptId: 'receipt_run_plan',
        effectiveConnections: effective.filter(({ account }) => fixture.admittedAccountIds.includes(account.id)),
      }),
      ...(fixture.codingWorkspace
        ? { codingWorkspaceConfigured: async () => true, sandboxInstalled: () => true }
        : { codingWorkspaceConfigured: async () => false }),
      preparePrompt: async (occurrence: RoutineRun) => ({
        prompt: `Execute ${occurrence.id}`,
        turn: {
          workspaceId: WORKSPACE, channelId: CHANNEL, eventId: occurrence.id, text: occurrence.revision!.taskText,
          userId: 'U1ALICE', actorMembershipId: fixture.actor, messageTs: '1793440000.000100',
          threadTs: '1793440000.000100', source: 'app_mention' as const, contextMode: 'channel_history' as const,
        },
        memoryEpoch: 3,
        validateMemoryLease: async () => true,
        confirmMemory: async () => undefined,
        matchesApartFromMemory: (dispatched: string) => dispatched === `Execute ${occurrence.id}`,
      }),
      handle: {
        id: 'routineagent_run_plan',
        async dispatch() {
          return { submissionId: 'submission_run_plan', acceptedAt: new Date(ROUTINE_NOW).toISOString(), uid: 'uid' };
        },
        async read() {
          return { submissionId: 'submission_run_plan', uid: 'uid', text: '{}', data: {} };
        },
        async abort() {},
      } as never,
    });
    const settled = await store.getRun(run.id);
    const envelope = settled?.flueAgentEnvelope;
    if (envelope) return { plan: parseRoutineExecutionInitialData(envelope.initialData).runtimePlan };
    return { failure: `${settled?.failureClass}: ${settled?.publicError}` };
  } finally {
    store.close();
  }
}

async function admittedRoutine(store: SqliteRoutineStore, suffix: string) {
  const routineId = `routine_${suffix}`;
  await store.save({
    actorId: 'U1ALICE', actorClass: 'member', workspaceId: WORKSPACE, channelId: CHANNEL,
    draft: {
      action: 'create', routineId, nextRunAt: ROUTINE_NOW, projectedDailyStarts: 1,
      reservations: [{ windowStart: ROUTINE_NOW, count: 1 }],
      definition: {
        name: 'Queue check', description: '', taskText: 'Check the queue.', triggerKind: 'schedule',
        scheduleInput: '0 * * * *', scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
        timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
      },
    },
    idempotencyKey: `create:${suffix}`,
  });
  const run = await store.createOccurrence({
    runId: `rrun_${suffix}`, idempotencyKey: `run:${suffix}`, routineId, routineVersion: 1,
    scheduledFor: ROUTINE_NOW, triggerSource: 'schedule', queuedAt: ROUTINE_NOW, deadlineAt: ROUTINE_NOW + 60_000,
  });
  const attempt = await store.startAdmissionAttempt({
    occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: ROUTINE_NOW, leaseUntil: ROUTINE_NOW + 30_000,
  });
  return { run, attempt };
}
