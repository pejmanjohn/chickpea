import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { SettingsStore } from '../src/config/settings-store.ts';
import { getSettingsStore, type PlatformEnv } from '../src/config/state-backend.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { resetModelCatalogActivationForTests } from '../src/model-catalog/catalog.ts';
import { acceptModelCatalogCandidate } from '../src/model-catalog/store.ts';
import { handleRoutineSlackRequest } from '../src/routines/commands.ts';
import type { RoutineDefinition } from '../src/routines/types.ts';
import { withEnv } from './helpers/env.ts';
import {
  NOW,
  apply,
  channelRoutine,
  createAgent,
  disposition,
  grant,
  mcp,
  slackFacts,
  withFixture,
  type Fixture,
} from './helpers/management-authority-fixture.ts';

/**
 * "Run now" judges the routine's model as its scheduled runs do: by the
 * installation's stored catalog. On a deployment serving many installations,
 * a check that knows no installation reads the bundled catalog instead.
 */

const HOSTED_MODEL = 'openai/gpt-hosted-run-now';
const OWNER_SLACK_USER = 'U12345678';
const ROOM = slackFacts(
  { G_ROOM: { name: 'room', private: true, member: true, archived: false } },
  { [OWNER_SLACK_USER]: ['G_ROOM'] },
);

function catalogBytes(revision: number, canonicals: string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-11-01T00:00:00Z',
    entries: canonicals.map((canonical) => ({
      canonical,
      displayName: canonical,
      lanes: { apiKey: 'openai-platform-responses-terra-tier@1' },
    })),
  }));
}

/**
 * One installation of a deployment serving many. The deployment declares that
 * in its own variables, as Cloud's Worker does, so a check given no env still
 * knows it serves many. The installation's stored hosted catalog is the only
 * one that lists its Workspace default, which its Channel routine's Agent
 * follows.
 */
async function withHostedOnlyDefaultRoutine(
  suffix: string,
  run: (f: Fixture, routine: RoutineDefinition, env: PlatformEnv, settings: SettingsStore) => Promise<void>,
): Promise<void> {
  resetModelCatalogActivationForTests();
  try {
    await withEnv({ CHICKPEA_TENANCY: 'installation', SLACK_STATE_DB_PATH: ':memory:' }, async () => {
      const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: `inst_${suffix}` });
      const settings = getSettingsStore(env);
      await acceptModelCatalogCandidate(settings, {
        bytes: catalogBytes(9, [HOSTED_MODEL]), checkedAt: 1, nextRefreshAt: 2,
      });
      await withFixture(suffix, async (f) => {
        await f.config.putWorkspaceModelDefault({
          workspaceId: f.workspaceId, modelId: HOSTED_MODEL, provenance: 'admin_selected',
          lastChangedByMembershipId: f.owner.membership.id,
        }, (await f.config.getWorkspaceModelDefault(f.workspaceId))?.revision ?? 0);
        const agent = await createAgent(f, f.owner, 'agent_follows_default');
        await grant(f, agent.id, 'G_ROOM');
        const saved = await apply(f, mcp(f.owner), `${suffix}-save`, [channelRoutine(f, agent.id, 'G_ROOM')]);
        assert.equal(disposition(saved), 'applied', JSON.stringify(saved.outcomes));
        const [routine] = await f.routines.listRoutines(f.workspaceId, 'G_ROOM');
        assert.ok(routine, 'the routine was saved');
        await run(f, routine, env, settings);
      }, { slackFacts: ROOM });
    });
  } finally {
    resetModelCatalogActivationForTests();
  }
}

// Defect caught: the management "run now" (MCP, Slack schedule actions, the
// Agent's schedule tool) resolved the routine's authority with no installation,
// so on Cloud it refused a Workspace default that only the installation's
// stored hosted catalog lists, while scheduled runs of the same routine passed.
test('a management run now passes a Workspace default only the stored hosted catalog lists', () =>
  withHostedOnlyDefaultRoutine('run-now-management', async (f, routine, env, settings) => {
    const service = createLiveWorkspaceManagementService(env, {
      identity: f.identity,
      settings,
      slackCredentials: { state: f.identity, keyring: generateCredentialKeyring() },
      overrides: {
        config: f.config,
        management: f.management,
        routines: f.routines,
        routineSchedulingAvailable: true,
        slackFacts: ROOM,
        setupBaseUrl: 'http://localhost',
        now: () => NOW,
      },
    });
    const ran = await service.applyWorkspaceChanges({
      context: mcp(f.owner),
      idempotencyKey: 'run-now-management-run',
      operations: [{
        itemId: 'run', kind: 'run_routine', workspaceId: f.workspaceId, channelId: 'G_ROOM', routineId: routine.id,
      }],
    });

    assert.ok('outcomes' in ran, JSON.stringify(ran));
    assert.equal(disposition(ran), 'applied', JSON.stringify(ran.outcomes));
    assert.deepEqual((await f.routines.listRuns({ routineId: routine.id })).map(({ triggerSource }) => triggerSource),
      ['run_now'], 'the run was queued');
  }));

// Guard: the exact `!routines run` resolves authority itself, with the turn's
// env, before it queues the run. It passed before the fix; this keeps it so.
test('a Slack `!routines run` passes a Workspace default only the stored hosted catalog lists', () =>
  withHostedOnlyDefaultRoutine('run-now-slack', async (f, routine, env) => {
    const reply = await handleRoutineSlackRequest({
      workspaceId: f.workspaceId, channelId: 'G_ROOM', eventId: 'Ev_run_now_slack',
      text: `!routines run ${routine.id}`, userId: OWNER_SLACK_USER,
      actorMembershipId: f.owner.membership.id,
      messageTs: '1800000000.000100', threadTs: '1800000000.000100',
      source: 'app_mention', contextMode: 'channel_history',
    }, env, {
      store: f.routines,
      config: f.config,
      identity: f.identity,
      capability: { target: 'cloudflare', available: true, enabled: true, reason: 'enabled' },
      canManageChannel: async () => true,
      now: () => NOW,
    });

    assert.match(reply ?? '', /Routine queued/, String(reply));
    assert.deepEqual((await f.routines.listRuns({ routineId: routine.id })).map(({ triggerSource }) => triggerSource),
      ['run_now'], 'the run was queued');
  }));
