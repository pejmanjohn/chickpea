import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { evaluateAgentMemory } from '../qa/live/cases/agent-memory.live.ts';
import { evaluateAvatarParity } from '../qa/live/cases/avatar-parity.live.ts';
import { evaluateConnectionOwnershipRevocation } from '../qa/live/cases/connector-ownership-revocation.live.ts';
import { evaluateDmSchedulePrivacy } from '../qa/live/cases/dm-schedule-privacy.live.ts';
import { evaluateInstallationAppHomeAuth } from '../qa/live/cases/installation-app-home-auth.live.ts';
import { PUBLIC_LIVE_CATALOG } from '../qa/live/cases/index.ts';
import { QA_STYLE_GUARD_DIGEST, evaluateSkillManagement } from '../qa/live/cases/skill-management.live.ts';
import { evaluateSlackRouting } from '../qa/live/cases/slack-routing.live.ts';
import { compileLiveCatalog } from '../qa/live/compiler.ts';
import { inventoryManifestCapabilities } from '../qa/live/observers/capabilities.ts';
import { validateTargetOverlay } from '../qa/live/privacy.ts';

test('v1.1 exposes ten complete contracts and runs LC-10 last in deep order', () => {
  assert.equal(PUBLIC_LIVE_CATALOG.release, 'v1.1');
  assert.deepEqual(PUBLIC_LIVE_CATALOG.pendingContractIds, []);
  assert.equal(PUBLIC_LIVE_CATALOG.contracts.length, 10);
  assert.equal(new Set(PUBLIC_LIVE_CATALOG.contracts.map(({ id }) => id)).size, 10);
  const deep = PUBLIC_LIVE_CATALOG.contracts.flatMap((contract) => contract.variants)
    .filter((variant) => variant.suites.includes('deep'));
  assert.equal(deep.length, 26);
  assert.match(deep.at(-1)?.id ?? '', /^LC10-/);
});

test('all promoted regression IDs retain a row in the public scenario census', () => {
  const census = readFileSync(new URL('../qa/live/lessons/scenario-index.md', import.meta.url), 'utf8');
  for (const regression of PUBLIC_LIVE_CATALOG.contracts.flatMap((contract) =>
    contract.variants.flatMap((variant) => variant.regressions)
  )) assert.match(census, new RegExp(`\\b${regression.candidateId}\\b`));
});

test('blocked live truth is machine-visible and leaves foundation observers runnable', () => {
  const inventory = inventoryManifestCapabilities(compileLiveCatalog(PUBLIC_LIVE_CATALOG));
  const blockedVariants = new Set(inventory.blocked.map(({ variantId }) => variantId));
  for (const prefix of ['LC02-', 'LC03-', 'LC05-V3-', 'LC06-', 'LC07-', 'LC09-', 'LC10-']) {
    assert.equal([...blockedVariants].some((variantId) => variantId.startsWith(prefix)), true, prefix);
  }
  for (const prefix of ['LC01-', 'LC04-', 'LC08-']) {
    assert.equal([...blockedVariants].some((variantId) => variantId.startsWith(prefix)), false, prefix);
  }
});

test('the alias-only Phase 1 target binds only the exact smoke inventory', () => {
  const example = JSON.parse(readFileSync(new URL('../qa/live/target.example.json', import.meta.url), 'utf8'));
  const manifest = compileLiveCatalog(PUBLIC_LIVE_CATALOG);
  const overlay = validateTargetOverlay(manifest, example);
  assert.deepEqual(Object.keys(overlay.bindings).sort(), [...manifest.requiredVariants.smoke].sort());
  assert.equal(overlay.fixtures['qa-style-guard'], undefined);
});

test('all seven evaluators reject pre-normalized assertion tokens', () => {
  for (const evaluate of [
    evaluateAvatarParity,
    evaluateSlackRouting,
    evaluateConnectionOwnershipRevocation,
    evaluateSkillManagement,
    evaluateAgentMemory,
    evaluateDmSchedulePrivacy,
    evaluateInstallationAppHomeAuth,
  ]) assert.throws(() => evaluate('not-a-variant' as never, { observedTokens: [] }), /INVALID_UPSTREAM_SHAPE/);
});

test('LC-02 accepts re-hosted URLs only when canonical and published byte digests match', () => {
  const fixture = avatarFixture();
  assert.equal(evaluateAvatarParity('LC02-V1-avatar-parity', fixture).pass, true);
  assert.notEqual(fixture.admin.agent.slackPresence.avatar.url, fixture.slack.presentation.owner.persona.avatarUrl);
  fixture.assets.publishedBytesBase64 = Buffer.from('wrong avatar').toString('base64');
  assert.deepEqual(evaluateAvatarParity('LC02-V1-avatar-parity', fixture).failures, ['published_asset_mismatch']);
});

test('LC-03 happy paths use durable routes, admission, exact handoff, and one persona delivery', () => {
  assert.equal(evaluateSlackRouting('LC03-V1-ingress-root-thread', routingFixture()).pass, true);
  const handoff = routingFixture();
  handoff.request.previousAgentId = 'agent_previous';
  handoff.request.transferMessageTs = '100.2';
  handoff.admin.routes[0]!.handoff = { previousAgentId: 'agent_previous', transferMessageTs: '100.2' };
  assert.equal(evaluateSlackRouting('LC03-V2-handoff', handoff).pass, true);
  assert.equal(evaluateSlackRouting('LC03-V3-archive-restore', routingFixture()).pass, true);
});

test('LC-03 catches duplicate delivery, unauthorized mutation, and target ambiguity', () => {
  const duplicate = routingFixture();
  duplicate.slack.messages.push(structuredClone(duplicate.slack.messages[0]!));
  assert.ok(evaluateSlackRouting('LC03-V1-ingress-root-thread', duplicate).failures.includes('terminal_delivery_duplicate'));
  const denied = routingFixture();
  denied.admin.routingAttempts[0] = { kind: 'routed', reason: 'not_available', authorized: false };
  assert.ok(evaluateSlackRouting('LC03-V1-ingress-root-thread', denied).failures.includes('unauthorized_route_mutation'));
  const drift = routingFixture();
  drift.target.afterGatewayVersionId = 'gateway-v2';
  assert.ok(evaluateSlackRouting('LC03-V1-ingress-root-thread', drift).failures.includes('target_identity_changed'));
});

test('LC-05 proves Personal and Team isolation plus revoke and reconnect history', () => {
  assert.equal(evaluateConnectionOwnershipRevocation('LC05-V1-personal-isolation', connectionFixture('member')).pass, true);
  assert.equal(evaluateConnectionOwnershipRevocation('LC05-V2-team-isolation', connectionFixture('team')).pass, true);
  assert.equal(evaluateConnectionOwnershipRevocation('LC05-V3-revoke-reconnect', revocationFixture()).pass, true);
});

test('LC-05 rejects cross-Agent reuse, wrong authority, and ambiguous provider grants', () => {
  const reused = connectionFixture('member');
  reused.admin.bindings[1]!.connectionAccountId = reused.admin.bindings[0]!.connectionAccountId;
  assert.ok(evaluateConnectionOwnershipRevocation('LC05-V1-personal-isolation', reused).failures.includes('cross_agent_reuse'));
  const wrongOwner = connectionFixture('member');
  wrongOwner.admin.accounts[0]!.ownerMembershipId = 'membership_other';
  assert.ok(evaluateConnectionOwnershipRevocation('LC05-V1-personal-isolation', wrongOwner).failures.includes('owner_mismatch'));
  const ambiguous = connectionFixture('team');
  ambiguous.provider.connected_accounts.push({ id: 'provider-account', status: 'ACTIVE' });
  assert.ok(evaluateConnectionOwnershipRevocation('LC05-V2-team-isolation', ambiguous).failures.includes('provider_grant_duplicate'));
});

test('LC-06 proves pinned import, structural behavior, removal, and cross-Agent denial', () => {
  assert.equal(evaluateSkillManagement('LC06-V1-import-behavior-remove', skillFixture()).pass, true);
  assert.equal(evaluateSkillManagement('LC06-V2-cross-agent-denial', skillFixture(true)).pass, true);
});

test('LC-06 rejects mutable provenance, scripts, ambiguity, and unauthorized mutation', () => {
  const mutable = skillFixture();
  mutable.resolution.ref = 'main';
  assert.ok(evaluateSkillManagement('LC06-V1-import-behavior-remove', mutable).failures.includes('source_not_pinned'));
  const scripted = skillFixture();
  scripted.resolution.skills[0]!.hasScripts = true;
  assert.ok(evaluateSkillManagement('LC06-V1-import-behavior-remove', scripted).failures.includes('packaged_scripts_present'));
  const ambiguous = skillFixture();
  ambiguous.resolution.total = 2;
  assert.ok(evaluateSkillManagement('LC06-V1-import-behavior-remove', ambiguous).failures.includes('source_ambiguous'));
  const denied = skillFixture(true);
  denied.admin.targetAfterAgent.revision = 5;
  assert.ok(evaluateSkillManagement('LC06-V2-cross-agent-denial', denied).failures.includes('cross_agent_mutation'));
});

test('LC-07 covers explicit, implicit, conflict, replay, forget, and cross-Agent absence without returning a body', () => {
  for (const variant of ['LC07-V1-explicit-memory', 'LC07-V2-implicit-preference', 'LC07-V3-conflict-replay-forget'] as const) {
    const evaluation = evaluateAgentMemory(variant, memoryFixture(variant));
    assert.equal(evaluation.pass, true, variant);
    assert.doesNotMatch(JSON.stringify(evaluation), /case_marker|preference|qa-memory/);
  }
});

test('LC-07 rejects stale conflict, non-idempotent retry, cross-Agent leakage, and public raw memory', () => {
  const stale = memoryFixture('LC07-V3-conflict-replay-forget');
  stale.admin.conflict.code = 'accepted';
  assert.ok(evaluateAgentMemory('LC07-V3-conflict-replay-forget', stale).failures.includes('conflict_not_rejected'));
  const replay = memoryFixture('LC07-V3-conflict-replay-forget');
  replay.admin.afterRetry.revision = 3;
  assert.ok(evaluateAgentMemory('LC07-V3-conflict-replay-forget', replay).failures.includes('retry_not_idempotent'));
  const leaked = memoryFixture('LC07-V3-conflict-replay-forget');
  leaked.admin.otherAgent.body = 'copied';
  assert.ok(evaluateAgentMemory('LC07-V3-conflict-replay-forget', leaked).failures.includes('cross_agent_leak'));
  const exposed = memoryFixture('LC07-V1-explicit-memory');
  exposed.publicEvidence.memoryBody = exposed.admin.afterWrite.body;
  assert.ok(evaluateAgentMemory('LC07-V1-explicit-memory', exposed).failures.includes('raw_memory_exposed'));
  const duplicateSurface = memoryFixture('LC07-V1-explicit-memory');
  duplicateSurface.admin.surfaceReads[1]!.surface = 'direct';
  assert.ok(evaluateAgentMemory('LC07-V1-explicit-memory', duplicateSurface).failures.includes('surface_read_mismatch'));
});

test('LC-09 proves one-shot and recurring DM delivery, Admin omission, and authority-loss disablement', () => {
  assert.equal(evaluateDmSchedulePrivacy('LC09-V1-one-shot-dm', dmRoutineFixture('once')).pass, true);
  assert.equal(evaluateDmSchedulePrivacy('LC09-V2-recurring-dm', dmRoutineFixture('schedule')).pass, true);
  assert.equal(evaluateDmSchedulePrivacy('LC09-V3-admin-omission-authority-loss', dmRoutineFixture('disabled')).pass, true);
});

test('LC-09 catches Admin leakage, duplicate delivery, missing recurrence, and unsafe authority state', () => {
  const leaked = dmRoutineFixture('once');
  leaked.adminApi.routines.push({ id: 'routine_private' });
  assert.ok(evaluateDmSchedulePrivacy('LC09-V1-one-shot-dm', leaked).failures.includes('admin_leak'));
  const duplicate = dmRoutineFixture('schedule');
  duplicate.slack.messages.push(structuredClone(duplicate.slack.messages[0]!));
  assert.ok(evaluateDmSchedulePrivacy('LC09-V2-recurring-dm', duplicate).failures.includes('delivery_duplicate'));
  const recurrence = dmRoutineFixture('schedule');
  recurrence.privateState.routines[0]!.nextRunAt = null;
  assert.ok(evaluateDmSchedulePrivacy('LC09-V2-recurring-dm', recurrence).failures.includes('recurrence_missing'));
  const authority = dmRoutineFixture('disabled');
  authority.privateState.routines[0]!.state = 'active';
  assert.ok(evaluateDmSchedulePrivacy('LC09-V3-admin-omission-authority-loss', authority).failures.includes('authority_not_disabled'));
});

test('LC-10 restores baseline, selects a fresh route, and denies stale membership', () => {
  assert.equal(evaluateInstallationAppHomeAuth('LC10-V1-install-route', installationFixture('install')).pass, true);
  assert.equal(evaluateInstallationAppHomeAuth('LC10-V2-app-home-selection', installationFixture('select')).pass, true);
  assert.equal(evaluateInstallationAppHomeAuth('LC10-V3-stale-membership-denial', installationFixture('deny')).pass, true);
});

test('LC-10 blocks wrong order, missing reset authority, drift, scope mismatch, ambiguity, and unauthorized route', () => {
  const order = installationFixture('install');
  order.request.isLastInDeepQueue = false;
  order.request.resetAuthority = false;
  const orderFailures = evaluateInstallationAppHomeAuth('LC10-V1-install-route', order).failures;
  assert.ok(orderFailures.includes('not_last_in_deep_queue'));
  assert.ok(orderFailures.includes('reset_authority_missing'));
  const drift = installationFixture('install');
  drift.admin.afterInstallation.appId = 'app_other';
  assert.ok(evaluateInstallationAppHomeAuth('LC10-V1-install-route', drift).failures.includes('baseline_identity_changed'));
  const scopes = installationFixture('install');
  scopes.admin.installReceipt.scopes.pop();
  assert.ok(evaluateInstallationAppHomeAuth('LC10-V1-install-route', scopes).failures.includes('installer_or_scope_denied'));
  const ambiguous = installationFixture('select');
  ambiguous.slack.publications.push(structuredClone(ambiguous.slack.publications[0]!));
  assert.ok(evaluateInstallationAppHomeAuth('LC10-V2-app-home-selection', ambiguous).failures.includes('app_home_publication_duplicate'));
  const denied = installationFixture('deny');
  denied.admin.routes.push({ channelId: 'D_QA', threadTs: '400.1', agentId: 'agent_one' });
  assert.ok(evaluateInstallationAppHomeAuth('LC10-V3-stale-membership-denial', denied).failures.includes('unauthorized_route_mutation'));
});

test('every promoted mutation and generated effect declares cleanup or residue', () => {
  for (const variant of PUBLIC_LIVE_CATALOG.contracts.flatMap((contract) => contract.variants)) {
    for (const action of variant.actions) {
      assert.equal(action.mutation === 'none' ? action.cleanup.strategy === 'not_required' : action.cleanup.strategy !== 'not_required', true, variant.id);
    }
    for (const effect of variant.generatedEffects) assert.equal(effect.cleanup.strategy, 'attributed_residue', variant.id);
  }
});

function avatarFixture() {
  const bytes = Buffer.from('canonical avatar');
  return {
    request: { runMarker: 'qa-avatar01', agentId: 'agent_one', expectedSourceDigest: sha256(bytes) },
    admin: { agent: { id: 'agent_one', slackPresence: { avatar: { revision: 3, url: 'admin-asset-one' } } } },
    slack: { presentation: { owner: { kind: 'selected_agent', persona: { name: 'QA Agent', avatarUrl: 'slack-rehost-one', avatarRevision: 3 } } } },
    assets: { canonicalBytesBase64: bytes.toString('base64'), publishedBytesBase64: bytes.toString('base64') },
  };
}

function routingFixture() {
  return {
    request: {
      runMarker: 'qa-route001', workspaceId: 'T_QA', channelId: 'C_QA', threadTs: '100.1',
      eventId: 'Ev_QA', expectedAgentId: 'agent_one', expectedRouteRevision: 2,
      previousAgentId: '', transferMessageTs: '',
    },
    target: {
      workerVersionId: 'worker-v1', afterWorkerVersionId: 'worker-v1',
      gatewayVersionId: 'gateway-v1', afterGatewayVersionId: 'gateway-v1',
    },
    admin: {
      routes: [{ workspaceId: 'T_QA', channelId: 'C_QA', threadTs: '100.1', agentId: 'agent_one', agentGeneration: 4, ownerIncarnation: 1, revision: 2, updatedAt: 10, handoff: { previousAgentId: '', transferMessageTs: '' } }],
      channelGrants: [{ workspaceId: 'T_QA', channelId: 'C_QA', agentId: 'agent_one', revision: 1, status: 'active', createdByMembershipId: 'membership_one', createdAt: 1, updatedAt: 1 }],
      turnJobs: [{ id: 'turn_one', turn: { eventId: 'Ev_QA' }, assignment: { agentId: 'agent_one' }, progress: { slackInteraction: { checklist: { terminal: 'success' } } } }],
      routingAttempts: [{ kind: 'denied', reason: 'not_available', authorized: false }],
      agents: [{ id: 'agent_one', name: 'QA Agent', enabled: true, lifecycle: 'active', revision: 4, slackPresence: { avatar: { revision: 3 } } }],
      presentation: { owner: { kind: 'selected_agent', persona: { name: 'QA Agent', avatarUrl: 'internal-avatar', avatarRevision: 3 } }, activityProjection: { surface: 'assistant_status', state: 'cleared' } },
    },
    slack: { messages: [{ ts: '100.2', channel: 'C_QA', thread_ts: '100.1', bot_profile: { name: 'QA Agent', icons: { image_48: 'slack-rehosted-avatar' } } }] },
  };
}

function connectionFixture(ownerKind: 'member' | 'team') {
  const accountIds = ['connection_one', 'connection_two'];
  const agentIds = ['agent_one', 'agent_two'];
  const ownerMembershipIds = ['membership_one', 'membership_two'];
  return {
    request: { runMarker: 'qa-connect1', connectionAccountIds: accountIds, agentIds, ownerMembershipIds, providerAccountRef: 'provider-account', routineId: '' },
    admin: {
      accounts: accountIds.map((id, index) => ({
        id, ownerKind, ...(ownerKind === 'member' ? { ownerMembershipId: ownerMembershipIds[index] } : {}),
        createdByMembershipId: ownerMembershipIds[index], lifecycle: 'ready',
        policy: { kind: 'managed', accountRef: 'provider-account' },
      })),
      bindings: accountIds.map((connectionAccountId, index) => ({ connectionAccountId, agentId: agentIds[index], enabled: true })),
      events: [] as Array<Record<string, unknown>>, routines: [] as Array<Record<string, unknown>>,
    },
    provider: { connected_accounts: [{ id: 'provider-account', status: 'ACTIVE' }] },
  };
}

function revocationFixture() {
  const fixture = connectionFixture('team');
  fixture.request.connectionAccountIds = ['connection_one'];
  fixture.request.agentIds = ['agent_one'];
  fixture.request.ownerMembershipIds = ['membership_admin'];
  fixture.request.routineId = 'routine_one';
  fixture.admin.accounts = [fixture.admin.accounts[0]!];
  fixture.admin.bindings = [fixture.admin.bindings[0]!];
  fixture.admin.events = [
    { eventType: 'connection.needs_attention', subjectId: 'connection_one' },
    { eventType: 'routine.pause', subjectId: 'routine_one' },
    { eventType: 'connection.reconnected', subjectId: 'connection_one' },
  ];
  fixture.admin.routines = [{ id: 'routine_one', state: 'active' }];
  return fixture;
}

function skillFixture(crossAgent = false) {
  const skillMarkdown = readFileSync(new URL('../qa/live/fixtures/skills/qa-style-guard/SKILL.md', import.meta.url), 'utf8');
  const importedSkill = { name: 'qa-style-guard', description: 'QA guard.', instructions: 'Return the structural result.', enabled: true };
  return {
    request: { runMarker: 'qa-skill001', expectedCommit: '1'.repeat(40), expectedSourceDigest: QA_STYLE_GUARD_DIGEST, skillName: 'qa-style-guard' },
    skillMarkdown,
    resolution: {
      owner: 'example', repo: 'verification-fixtures', ref: '1'.repeat(40), source: { visibility: 'public', access: 'anonymous' },
      skills: [{ ...importedSkill, hasScripts: false, path: 'skills/qa-style-guard', sourceUrl: 'source-alias' }], total: 1, capped: false, skipped: 0,
    },
    admin: {
      afterImportAgent: { id: 'agent_one', revision: 2, skills: [importedSkill] },
      afterRemoveAgent: { id: 'agent_one', revision: 3, skills: [] as Array<Record<string, unknown>> },
      importReceipt: { import: { name: 'qa-style-guard', replacedExisting: false } },
      presentation: { activityProjection: { surface: 'assistant_status', state: 'cleared' } },
      targetBeforeRevision: 4,
      targetAfterAgent: { id: 'agent_two', revision: 4, skills: [importedSkill] },
      denial: { code: crossAgent ? 'agent_edit_forbidden' : 'none' },
    },
    slack: { messages: [{ result: { style: 'plain', status: 'checked', marker_present: true } }] },
  };
}

function memoryFixture(variant: 'LC07-V1-explicit-memory' | 'LC07-V2-implicit-preference' | 'LC07-V3-conflict-replay-forget') {
  const marker = 'qa-memory01';
  const body = variant === 'LC07-V2-implicit-preference'
    ? `case_marker: ${marker}\nimplicit_preference: concise`
    : `case_marker: ${marker}\npreference: concise`;
  const memory = { agentId: 'agent_one', body, revision: 2 };
  return {
    request: { runMarker: marker, agentId: 'agent_one', beforeRevision: 1 },
    admin: {
      afterWrite: { ...memory }, afterRetry: { ...memory },
      surfaceReads: [{ surface: 'direct', memory: { ...memory } }, { surface: 'channel', memory: { ...memory } }],
      conflict: { code: 'memory_version_conflict', currentRevision: 2 },
      afterForget: { agentId: 'agent_one', body: '', revision: 3 },
      otherAgent: { agentId: 'agent_two', body: '', revision: 0 },
    },
    publicEvidence: { revision: 2, observedState: 'matched' } as Record<string, unknown>,
  };
}

function dmRoutineFixture(mode: 'once' | 'schedule' | 'disabled') {
  const routine = {
    id: 'routine_private', workspaceId: 'T_QA', channelId: 'D_QA',
    destination: { kind: 'direct_thread', conversationId: 'D_QA', threadTs: '300.1', ownerMembershipId: 'membership_one' },
    triggerKind: mode === 'once' ? 'once' : 'schedule',
    state: mode === 'disabled' ? 'disabled' : mode === 'once' ? 'completed' : 'active',
    nextRunAt: mode === 'schedule' ? 2_000_000_000_000 : null as number | null,
    disabledReason: mode === 'disabled' ? 'creator_ineligible' : null,
  };
  return {
    request: { runMarker: 'qa-dmrout1', routineId: 'routine_private', conversationId: 'D_QA', threadTs: '300.1', ownerMembershipId: 'membership_one' },
    privateState: {
      routines: [routine],
      runs: mode === 'disabled' ? [] as Array<Record<string, unknown>> : [{ routineId: 'routine_private', status: 'succeeded', deliveryStatus: 'delivered', deliveryMessageTs: '300.2' }],
    },
    adminApi: { routines: [] as Array<Record<string, unknown>>, runs: [] as Array<Record<string, unknown>>, events: [] as Array<Record<string, unknown>> },
    slack: { messages: mode === 'disabled' ? [] as Array<Record<string, unknown>> : [{ routineId: 'routine_private', ts: '300.2', channel: 'D_QA', thread_ts: '300.1' }] },
  };
}

function installationFixture(mode: 'install' | 'select' | 'deny') {
  const unavailable = 'That Agent is not available right now. Your available Agents are shown below.';
  return {
    request: {
      runMarker: 'qa-install1', isLastInDeepQueue: true, resetAuthority: true,
      installerMembershipId: 'membership_admin', expectedScopes: ['app_mentions:read', 'chat:write'],
      conversationId: 'D_QA', threadTs: '400.1', agentId: 'agent_one',
    },
    admin: {
      beforeInstallation: { workspaceId: 'T_QA', teamId: 'T_QA', appId: 'A_QA', transportMode: 'gateway', defaultAgentId: 'agent_default', health: 'healthy', revision: 4 },
      afterInstallation: { workspaceId: 'T_QA', teamId: 'T_QA', appId: 'A_QA', transportMode: 'gateway', defaultAgentId: 'agent_default', health: 'healthy', revision: 5 },
      beforeCredential: { revision: 'credential-one', appId: 'A_QA', teamId: 'T_QA', manifestFingerprint: 'manifest-one' },
      afterCredential: { revision: 'credential-two', appId: 'A_QA', teamId: 'T_QA', manifestFingerprint: 'manifest-one' },
      installReceipt: { installerMembershipId: 'membership_admin', appId: 'A_QA', teamId: 'T_QA', scopes: ['app_mentions:read', 'chat:write'] },
      routes: mode === 'select' ? [{ channelId: 'D_QA', threadTs: '400.1', agentId: 'agent_one' }] : [] as Array<Record<string, unknown>>,
      selection: mode === 'select' ? { kind: 'routed', source: 'app_home' } : { kind: 'denied', source: 'app_home' },
    },
    slack: {
      events: [{ type: 'app_home_opened' }],
      publications: [{ ok: true, view: { type: 'home', blocks: [{ type: 'context', text: mode === 'deny' ? unavailable : 'Your Agents' }] } }],
    },
  };
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
