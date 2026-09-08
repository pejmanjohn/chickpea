import { SqliteConfigStore } from '../../src/config/store.ts';
import { SqliteIdentityStore } from '../../src/identity/store.ts';
import { SqliteManagementStore } from '../../src/management/store.ts';
import {
  WorkspaceManagementService,
  type WorkspaceManagementServiceInput,
} from '../../src/management/service.ts';
import { SqliteMemoryStateStore } from '../../src/memory/store.ts';
import { SqliteRoutineStore } from '../../src/routines/store.ts';
import { createSlackOwner } from './slack-owner.ts';

export async function createManagementAdapterFixture(
  suffix: string,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
) {
  let sequence = 0;
  const now = 1_800_000_000_000;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, { now, suffix });
  const locatorHash = createHash('sha256').update(`locator:${suffix}`).digest('hex');
  const invitation = await identity.createInvitation({
    organizationId: owner.membership.organizationId,
    slackTeamId: owner.user.slackTeamId,
    slackUserId: 'U87654321',
    displayName: 'Admin',
    role: 'admin',
    locatorHash,
    inviterMembershipId: owner.membership.id,
    expiresAt: now + 60_000,
  });
  const admin = await identity.consumeInvitation({
    invitationId: invitation.id,
    locatorHash,
    slackTeamId: owner.user.slackTeamId,
    slackUserId: invitation.slackUserId,
    displayName: 'Admin',
    betterAuthUserId: `ba_user_${suffix}_admin`,
    betterAuthMembershipId: `ba_member_${suffix}_admin`,
  });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const memory = new SqliteMemoryStateStore(':memory:', () => now);
  const routines = new SqliteRoutineStore(':memory:', () => now);
  const service = new WorkspaceManagementService({
    identity,
    config,
    management,
    memory,
    routines,
    routineSchedulingAvailable: true,
    setupBaseUrl: 'http://localhost',
    randomCapability: () => 'c'.repeat(43),
    now: () => now,
    randomId: () => `${suffix}_${++sequence}`,
    ...overrides,
  });
  return {
    identity,
    owner,
    admin,
    config,
    management,
    memory,
    routines,
    service,
    close() {
      identity.close();
      config.close();
      management.close();
      memory.close();
      routines.close();
    },
  };
}

import { createHash } from 'node:crypto';
