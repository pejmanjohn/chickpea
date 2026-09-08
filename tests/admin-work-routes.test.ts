import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { createWorkAdminApi } from '../src/admin/work-api.ts';
import { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';
import { opaqueId } from '../src/work/admission.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';
import type {
  BindingId,
  RunId,
  SourceVisibility,
  WorkId,
  WorkStore,
} from '../src/work/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const NOW = 1_900_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

test('diagnostic Sessions readback is authenticated, content-free, and respects private-work exclusions', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    const seeded = await seedRun(work, 'diagnostic', NOW);
    const lifecycle = lifecycleFor(work, seeded.runId, () => NOW + 10);
    await lifecycle.prepareExecution('PRIVATE_DIAGNOSTIC_CONTENT');
    const submissionRef = opaqueId('fluesubmission', 'test-submission');
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded', flueSubmissionRef: submissionRef });
    const before = JSON.stringify(await work.getRun(seeded.runId));
    const guarded = new Proxy(work, {
      get(target, property) {
        if (['getContent', 'getConfigRevision'].includes(String(property))) {
          return () => { throw new Error(`diagnostics must not call ${String(property)}`); };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = createAdminRoutes({ work: guarded, ...testAdminAuthority('diagnostic-token') });
    const url = `/admin/api/sessions/${seeded.runId}?diagnostics=1`;
    assert.equal((await app.request(url)).status, 401);
    const response = await app.request(url, { headers: testAdminHeaders('diagnostic-token') });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as Record<string, any>;
    assert.equal(body.schemaVersion, 'chickpea-request-diagnostics/v1');
    assert.equal(body.executions[0].flueSubmissionRef, submissionRef);
    assert.ok(body.timeline.length > 0);
    assert.ok(body.timeline.every((event: any) => !Object.hasOwn(event, 'metadata')));
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_DIAGNOSTIC_CONTENT|cred_openai_alpha|test-submission|trigger diagnostic/);
    assert.equal(JSON.stringify(await work.getRun(seeded.runId)), before);
    const hidden = createWorkAdminApi({ store: () => guarded, privateWork: async () => true });
    const hiddenResponse = await hidden.request(`/sessions/${seeded.runId}?diagnostics=1`);
    assert.equal(hiddenResponse.status, 404);
    assert.deepEqual(await hiddenResponse.json(), { error: 'session_not_found' });
    const mismatch = await app.request(`${url}&workId=work_wrong`, { headers: testAdminHeaders('diagnostic-token') });
    assert.equal(mismatch.status, 409);
  } finally { work.close(); }
});

test('Sessions routes are authenticated and cursor pagination is stable across new admissions', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    await seedRun(work, 'page_a', NOW);
    await seedRun(work, 'page_b', NOW + 1);
    const app = createAdminRoutes({ work, ...testAdminAuthority('sessions-token') });
    assert.equal((await app.request('/admin/api/sessions')).status, 401);
    const headers = testAdminHeaders('sessions-token');
    const first = await app.request('/admin/api/sessions?limit=1', { headers });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as Record<string, any>;
    assert.equal(firstBody.items[0].runId, 'run_page_b');
    assert.equal(firstBody.items[0].contentAccess, 'public');
    assert.equal(Object.hasOwn(firstBody.items[0], 'deepLink'), false);

    await seedRun(work, 'page_c', NOW + 2);
    const second = await app.request(
      `/admin/api/sessions?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers },
    );
    assert.equal(second.status, 200);
    const secondBody = await second.json() as Record<string, any>;
    assert.equal(secondBody.items[0].runId, 'run_page_a');
    assert.notEqual(secondBody.items[0].runId, 'run_page_c');
  } finally {
    work.close();
  }
});

test('public Sessions detail returns retained bodies and safe lifecycle evidence without credentials', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    const seeded = await seedRun(work, 'public_detail', NOW, 'public');
    let tick = 0;
    const lifecycle = lifecycleFor(work, seeded.runId, () => NOW + 10 + (++tick));
    await lifecycle.prepareExecution('prepared <img src=x onerror=alert(2)>');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'approved <script>alert(3)</script>',
      renderedPayload: '{"text":"rendered <svg onload=alert(4)>"}',
    });
    await lifecycle.afterDelivery({
      attemptId,
      outcome: 'delivered',
      deliveryRef: 'slack:C_PUBLIC:1900000000.000001',
    });
    const before = JSON.stringify(await work.getRun(seeded.runId));
    const api = createWorkAdminApi({ store: () => work, now: () => NOW + 100 });
    const response = await api.request(
      `/sessions/${seeded.runId}?workId=${seeded.workId}&bindingId=${seeded.bindingId}`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, any>;
    assert.equal(body.projection, 'public');
    assert.equal(body.content.trigger.body, 'trigger public_detail');
    assert.match(body.content.preparedInput.body, /<img/);
    assert.match(body.content.approvedOutput.body, /<script>/);
    assert.match(body.content.renderedPayload.body, /<svg/);
    assert.deepEqual(body.timeline.map((event: Record<string, unknown>) => event.eventType), [
      'work.run_admitted',
      'work.input_prepared',
      'work.execution_created',
      'work.execution_route_recorded',
      'work.execution_invoked',
      'work.execution_settled',
      'work.response_recorded',
      'work.delivery_started',
      'work.delivery_delivered',
    ]);
    assert.equal(body.executions[0].canonicalModel, 'openai/gpt-5.6-sol');
    assert.equal(body.executions[0].providerAuthRoute, 'openai_api_key');
    assert.equal(body.executions[0].modelCredentialRef, undefined);
    assert.equal(body.usage.state, 'not_reported');
    assert.equal(body.actionIntegrity.state, 'complete');
    assert.equal(JSON.stringify(await work.getRun(seeded.runId)), before);
  } finally {
    work.close();
  }
});

test('Slack delivery persists only credential-safe approved output in public Sessions', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    const seeded = await seedRun(work, 'redacted_delivery', NOW, 'public');
    let tick = 0;
    const lifecycle = lifecycleFor(work, seeded.runId, () => NOW + 10 + (++tick));
    await lifecycle.prepareExecution('prepared safe input');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const presenter = new WebClientPresenter(
      {
        chat: {
          async startStream() {
            return { ok: true, ts: '1900000000.000100' };
          },
          async stopStream() { return { ok: true }; },
        },
      } as unknown as WebClient,
      {
        channelId: 'C_PUBLIC', threadTs: '1900000000.000001',
        userId: 'U_REQUESTER', workspaceId: 'T_SESSIONS',
        agentName: 'Sessions Agent', agentId: 'profile_sessions',
      },
      {
        beforeDelivery: (input) => lifecycle.beforeDelivery(input),
        afterDelivery: (input) => lifecycle.afterDelivery(input),
      },
      { deliverySafety: 'ledger' },
    );
    const canary = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

    await presenter.deliverFinal(`Credential: ${canary}`, 'markdown');

    const api = createWorkAdminApi({ store: () => work, now: () => NOW + 100 });
    const response = await api.request(
      `/sessions/${seeded.runId}?workId=${seeded.workId}&bindingId=${seeded.bindingId}`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, any>;
    const persisted = JSON.stringify({
      approvedOutput: body.content.approvedOutput,
      renderedPayload: body.content.renderedPayload,
    });
    assert.doesNotMatch(persisted, new RegExp(canary));
    assert.match(persisted, /\[credential redacted\]/);
  } finally {
    work.close();
  }
});

test('Sessions deep links reject a mismatched Work generation and expired bodies stay explicit', async () => {
  const work = new SqliteWorkStore(':memory:', {
    now: () => NOW,
    env: { TAG_RUN_BODY_RETENTION_DAYS: '1' },
  });
  try {
    const seeded = await seedRun(work, 'expired_detail', NOW, 'public');
    const api = createWorkAdminApi({ store: () => work, now: () => NOW + DAY_MS + 1 });
    const mismatch = await api.request(
      `/sessions/${seeded.runId}?workId=work_wrong_generation&bindingId=${seeded.bindingId}`,
    );
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), { error: 'session_deep_link_mismatch' });

    const response = await api.request(`/sessions/${seeded.runId}`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.projection, 'public');
    assert.equal(body.session.status, 'admitted');
    assert.equal(body.content.trigger.state, 'expired');
    assert.equal(body.content.preparedInput.state, 'not_retained');
    assert.doesNotMatch(JSON.stringify(body), /trigger expired_detail/);
  } finally {
    work.close();
  }
});

test('Sessions exposes body-free action receipt integrity failures without optional activity history', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    const seeded = await seedRun(work, 'action_integrity', NOW, 'public');
    const lifecycle = lifecycleFor(work, seeded.runId, () => NOW + 10);
    await lifecycle.prepareExecution('public prompt');
    await work.recordWorkAction({
      eventId: 'audit_action_integrity_started',
      idempotencyKey: 'auditkey_action_integrity_started',
      runId: seeded.runId,
      runExecutionId: lifecycle.executionId,
      fencingToken: lifecycle.fencingToken,
      actionAttemptId: 'action_integrity_missing_outcome',
      actionClass: 'mcp_write',
      targetKind: 'marketing_budget',
      flueCorrelation: 'toolcall_action_integrity',
      status: 'started',
      createdAt: NOW + 20,
    });
    const api = createWorkAdminApi({ store: () => work, now: () => NOW + 100 });
    const response = await api.request(`/sessions/${seeded.runId}`);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.actionIntegrity.state, 'integrity_error');
    assert.equal(body.actionIntegrity.reason, 'missing_action_outcome');
    assert.deepEqual(body.actionIntegrity.missingOutcomeAttemptIds, [
      'action_integrity_missing_outcome',
    ]);
    const receipts = JSON.stringify(body.timeline.filter((event: Record<string, unknown>) =>
      event.eventType === 'work.action_started'));
    assert.match(receipts, /mcp_write|action_integrity_missing_outcome/);
    assert.doesNotMatch(receipts, /public prompt|argument|result/i);
  } finally {
    work.close();
  }
});

test('private and unknown Sessions use a structurally redacted projection without content reads', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  const canary = 'PRIVATE_SESSION_CANARY_<script>alert(9)</script>';
  try {
    const seeded = await seedRun(work, 'private_detail', NOW, 'private', canary);
    const noContentStore = new Proxy(work, {
      get(target, property, receiver) {
        if (property === 'getContent') {
          return () => { throw new Error('redacted detail read content'); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as WorkStore;
    const api = createWorkAdminApi({ store: () => noContentStore });
    const response = await api.request(`/sessions/${seeded.runId}`);
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text();
    assert.match(text, /"projection":"redacted"/);
    assert.match(text, /"state":"private"/);
    assert.doesNotMatch(text, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(text, /trigger private_detail/);

    const unknown = await seedRun(work, 'unknown_detail', NOW + 1, 'unknown');
    const unknownResponse = await api.request(`/sessions/${unknown.runId}`);
    assert.match(await unknownResponse.text(), /authorization_unknown/);
  } finally {
    work.close();
  }
});

test('recovery quarantine is same-origin, confirmed, idempotent, body-free, and terminal', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    const seeded = await seedRun(work, 'recovery_detail', NOW);
    const lifecycle = lifecycleFor(work, seeded.runId, () => NOW + 10);
    await lifecycle.prepareExecution('recovery prompt');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({
      outcome: 'ambiguous',
      rawStatus: 'provider_unknown',
      safeFailureCode: 'provider_outcome_unknown',
    });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'possible response',
      renderedPayload: '{"text":"possible response"}',
    });
    await lifecycle.afterDelivery({
      attemptId,
      outcome: 'unknown',
      safeFailureCode: 'delivery_unknown',
    });
    const api = createWorkAdminApi({ store: () => work, now: () => NOW + 200 });
    const nonRecovery = await seedRun(work, 'not_recovery', NOW + 1);
    const nonRecoveryResponse = await api.request(
      `http://localhost/sessions/${nonRecovery.runId}/quarantine`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-test',
          'content-type': 'application/json',
          'idempotency-key': 'quarantine-not-recovery',
        },
        body: JSON.stringify({
          confirm: true,
          operatorLabel: 'On-call operator',
          safeReasonCode: 'accepted_unknown',
        }),
      },
    );
    assert.equal(nonRecoveryResponse.status, 409);

    const crossOriginBearer = await api.request(
      `https://chickpea.test/sessions/${seeded.runId}/quarantine`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-test',
          origin: 'https://evil.test',
          'content-type': 'application/json',
          'idempotency-key': 'quarantine-cross-origin',
        },
        body: JSON.stringify({
          confirm: true,
          operatorLabel: 'On-call operator',
          safeReasonCode: 'accepted_unknown',
        }),
      },
    );
    assert.equal(crossOriginBearer.status, 403);

    const denied = await api.request(`/sessions/${seeded.runId}/quarantine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: true,
        operatorLabel: 'On-call operator',
        safeReasonCode: 'accepted_unknown',
      }),
    });
    assert.equal(denied.status, 403);

    const headers = {
      'content-type': 'application/json',
      'idempotency-key': 'quarantine-recovery-1',
      origin: 'http://localhost',
    };
    const payload = JSON.stringify({
      confirm: true,
      operatorLabel: 'On-call operator',
      safeReasonCode: 'accepted_unknown',
    });
    const quarantined = await api.request(
      `http://localhost/sessions/${seeded.runId}/quarantine`,
      { method: 'POST', headers, body: payload },
    );
    assert.equal(quarantined.status, 200, await quarantined.clone().text());
    const body = await quarantined.json() as Record<string, any>;
    assert.equal(body.terminalDisposition, 'quarantined');
    assert.equal(body.recovery.claimedOperatorLabel, 'On-call operator');
    assert.equal(body.recovery.authOrigin, 'local_admin');
    assert.match(body.attribution, /claimed/);
    const replay = await api.request(
      `http://localhost/sessions/${seeded.runId}/quarantine`,
      { method: 'POST', headers, body: payload },
    );
    assert.equal(replay.status, 200);
    assert.equal((await work.getRun(seeded.runId))?.status, 'settled');
    assert.equal((await work.getRun(seeded.runId))?.deliveryStatus, 'unknown');
    assert.doesNotMatch(JSON.stringify(await work.listAuditEvents(seeded.runId)), /possible response/);

    const bodyBearing = await api.request(
      `http://localhost/sessions/${seeded.runId}/quarantine`,
      {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'quarantine-body-bearing' },
        body: JSON.stringify({
          confirm: true,
          operatorLabel: 'On-call operator',
          safeReasonCode: 'accepted_unknown',
          body: 'forbidden',
        }),
      },
    );
    assert.equal(bodyBearing.status, 400);

    const stale = await api.request(
      `http://localhost/sessions/${seeded.runId}/quarantine`,
      {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'quarantine-stale-run' },
        body: payload,
      },
    );
    assert.equal(stale.status, 409);
  } finally {
    work.close();
  }
});

test('stale executing test Runs can be retired through one audited idempotent operator action', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    const seeded = await seedRun(work, 'stale_retire', NOW, 'public', 'stale test prompt');
    const lifecycle = lifecycleFor(work, seeded.runId, () => NOW + 10);
    await lifecycle.prepareExecution('stale prepared input');
    await lifecycle.markInvoked();

    const freshApi = createWorkAdminApi({ store: () => work, now: () => NOW + 29 * 60_000 });
    const missingCredential = await freshApi.request(`/sessions/${seeded.runId}/retire-stale`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'retire-stale-run-1' },
      body: JSON.stringify({
        confirm: true,
        operatorLabel: 'Flue 2 migration operator',
        safeReasonCode: 'accepted_unknown',
      }),
    });
    assert.equal(missingCredential.status, 403);
    const crossOrigin = await freshApi.request(`/sessions/${seeded.runId}/retire-stale`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test',
        'content-type': 'application/json',
        'idempotency-key': 'retire-stale-run-1',
        origin: 'https://evil.test',
      },
      body: JSON.stringify({
        confirm: true,
        operatorLabel: 'Flue 2 migration operator',
        safeReasonCode: 'accepted_unknown',
      }),
    });
    assert.equal(crossOrigin.status, 403);
    const fresh = await freshApi.request(`/sessions/${seeded.runId}/retire-stale`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test',
        'content-type': 'application/json',
        'idempotency-key': 'retire-stale-run-1',
      },
      body: JSON.stringify({
        confirm: true,
        operatorLabel: 'Flue 2 migration operator',
        safeReasonCode: 'accepted_unknown',
      }),
    });
    assert.equal(fresh.status, 409);
    assert.deepEqual(await fresh.json(), { error: 'session_not_stale' });

    const api = createWorkAdminApi({ store: () => work, now: () => NOW + 31 * 60_000 });
    const headers = {
      authorization: 'Bearer admin-test',
      'content-type': 'application/json',
      'idempotency-key': 'retire-stale-run-1',
    };
    const payload = JSON.stringify({
      confirm: true,
      operatorLabel: 'Flue 2 migration operator',
      safeReasonCode: 'accepted_unknown',
    });
    const retired = await api.request(`/sessions/${seeded.runId}/retire-stale`, {
      method: 'POST',
      headers,
      body: payload,
    });
    assert.equal(retired.status, 200, await retired.clone().text());
    const body = await retired.json() as Record<string, any>;
    assert.equal(body.status, 'settled');
    assert.equal(body.terminalDisposition, 'quarantined');
    assert.equal(body.recovery.reasonCode, 'accepted_unknown');
    assert.equal(body.recovery.claimedOperatorLabel, 'Flue 2 migration operator');

    const replay = await api.request(`/sessions/${seeded.runId}/retire-stale`, {
      method: 'POST',
      headers,
      body: payload,
    });
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(await replay.json(), body);

    const run = await work.getRun(seeded.runId);
    assert.equal(run?.safeFailureCode, 'operator_retired_stale_run');
    const events = await work.listAuditEvents(seeded.runId);
    assert.equal(events.filter((event) => event.eventType === 'work.run_recovery_required').length, 1);
    assert.equal(events.filter((event) => event.eventType === 'work.run_quarantined').length, 1);
    assert.equal(
      events.find((event) => event.eventType === 'work.run_recovery_required')?.reasonCode,
      'operator_retired_stale_run',
    );
    const audit = JSON.stringify(events);
    assert.doesNotMatch(audit, /stale test prompt|stale prepared input/);
  } finally {
    work.close();
  }
});

test('stale Run retirement rejects active leases and resumes a partial two-write failure', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => NOW + 100 });
  try {
    const leased = await seedRun(work, 'stale_retire_leased', NOW);
    const leasedLifecycle = lifecycleFor(work, leased.runId, () => NOW + 10);
    await leasedLifecycle.prepareExecution('leased prepared input');
    await leasedLifecycle.markInvoked();
    const activeLeaseStore = new Proxy(work, {
      get(target, property, receiver) {
        if (property === 'getRun') {
          return async (runId: RunId) => {
            const run = await target.getRun(runId);
            return run ? { ...run, leaseUntil: NOW + 32 * 60_000 } : undefined;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as WorkStore;
    const activeLeaseApi = createWorkAdminApi({
      store: () => activeLeaseStore,
      now: () => NOW + 31 * 60_000,
    });
    const activeLease = await activeLeaseApi.request(`/sessions/${leased.runId}/retire-stale`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test',
        'content-type': 'application/json',
        'idempotency-key': 'retire-stale-active-lease',
      },
      body: JSON.stringify({
        confirm: true,
        operatorLabel: 'Flue 2 migration operator',
        safeReasonCode: 'accepted_unknown',
      }),
    });
    assert.equal(activeLease.status, 409);
    assert.deepEqual(await activeLease.json(), { error: 'session_not_stale' });

    const partial = await seedRun(work, 'stale_retire_partial', NOW);
    const partialLifecycle = lifecycleFor(work, partial.runId, () => NOW + 10);
    await partialLifecycle.prepareExecution('partial prepared input');
    await partialLifecycle.markInvoked();
    let failQuarantineOnce = true;
    const interruptedStore = new Proxy(work, {
      get(target, property, receiver) {
        if (property === 'quarantineRun') {
          return async (...args: Parameters<WorkStore['quarantineRun']>) => {
            if (failQuarantineOnce) {
              failQuarantineOnce = false;
              throw new Error('injected quarantine interruption');
            }
            return target.quarantineRun(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as WorkStore;
    const partialApi = createWorkAdminApi({
      store: () => interruptedStore,
      now: () => NOW + 31 * 60_000,
    });
    const request = {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test',
        'content-type': 'application/json',
        'idempotency-key': 'retire-stale-partial',
      },
      body: JSON.stringify({
        confirm: true,
        operatorLabel: 'Flue 2 migration operator',
        safeReasonCode: 'accepted_unknown',
      }),
    };
    const interrupted = await partialApi.request(
      `/sessions/${partial.runId}/retire-stale`,
      request,
    );
    assert.equal(interrupted.status, 503);
    assert.equal((await work.getRun(partial.runId))?.status, 'recovery_required');
    const resumed = await partialApi.request(`/sessions/${partial.runId}/retire-stale`, request);
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal((await resumed.json() as Record<string, unknown>).status, 'settled');
  } finally {
    work.close();
  }
});

async function seedRun(
  work: SqliteWorkStore,
  suffix: string,
  createdAt: number,
  visibility: SourceVisibility = 'public',
  trigger = `trigger ${suffix}`,
) {
  const workId = `work_${suffix}` as WorkId;
  const bindingId = `binding_${suffix}` as BindingId;
  const runId = `run_${suffix}` as RunId;
  await work.admitShadowRun({
    work: {
      id: workId,
      kind: 'conversation',
      maximumSensitivity: visibility === 'public' ? 'public' : 'private',
      createdAt,
    },
    binding: {
      id: bindingId,
      workId,
      adapterKind: 'slack',
      externalAccountId: `account_${suffix}`,
      externalConversationId: `conversation_${suffix}`,
      generation: 1,
      sourceVisibility: visibility,
      configMode: 'frozen_on_open',
      orderingKey: `ordering_${suffix}`,
      createdAt,
    },
    run: {
      id: runId,
      workId,
      bindingId,
      kind: 'interactive',
      triggerKind: 'slack_app_mention',
      triggerRef: `triggerref_${suffix}`,
      dedupeKey: `dedupe_${suffix}`,
      actorRef: `actor_${suffix}`,
      actorTrustTier: 'member',
      sourceContextWatermark: `watermark_${suffix}`,
      effectiveCapabilityDigest: 'b'.repeat(64),
      executionAuthority: 'legacy',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
      createdAt,
    },
    safeConfig: {
      schemaVersion: 1,
      profileId: `profile_${suffix}`,
      configuredModel: 'openai/gpt-5.6-sol',
      snapshotDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
      skillNames: [],
      connectionIds: [],
      repositoryIds: [],
      memoryMode: visibility === 'public' ? 'public' : 'private',
      ceilings: {
        maxModelAttempts: 3,
        maxToolCalls: 20,
        maxActionAttempts: 0,
        timeoutMs: 120_000,
      },
    },
    ...(visibility === 'unknown'
      ? {}
      : { triggerContent: { sensitivity: visibility, body: trigger } }),
    auditEventId: `audit_${suffix}`,
    auditIdempotencyKey: `auditkey_${suffix}`,
  });
  return { workId, bindingId, runId };
}

function lifecycleFor(store: WorkStore, runId: RunId, now: () => number) {
  return new ShadowWorkLifecycle({
    store,
    runId,
    attemptNumber: 1,
    agentName: 'profile_sessions',
    canonicalModel: 'openai/gpt-5.6-sol',
    sensitivity: 'public',
    routeEvidence: {
      providerAuthRoute: 'openai_api_key',
      catalogSource: 'bundled',
      catalogRevision: '0',
      catalogDigest: 'c'.repeat(64),
      compiledProfile: 'openai-platform-responses-sol-tier@1',
      modelCredentialRef: 'cred_openai_alpha',
      modelCredentialVersion: 1,
    },
    now,
  });
}
