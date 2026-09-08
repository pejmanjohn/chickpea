import { REGRESSION_AREAS } from './regression-plan.mjs';
import { contextScope } from './verification-scope.mjs';

// Starting inventory for the attended modes, not executable catalog contracts.
// Operators add affected variants and the advertised feature matrix for a release.
const journeys = [
  ['routing', ['delivery'], ['slack', 'admin'], ['channel'], 'regression'],
  ['create-welcome', ['agents', 'delivery'], ['slack', 'admin'], ['channel'], 'regression'],
  ['instruction-approval', ['agents'], ['slack', 'admin'], ['agent'], 'regression'],
  ['provider-read', ['connections', 'providers'], ['slack', 'admin', 'provider'], ['connection', 'provider-rows'], 'regression'],
  ['channel-schedule', ['routines', 'delivery'], ['slack', 'admin'], ['channel'], 'regression'],
  ['fresh-personal-oauth', ['auth', 'connections'], ['slack', 'admin', 'provider'], ['empty-connector-agent', 'oauth-account', 'provider-rows'], 'release'],
  ['role-denial', ['auth'], ['slack', 'admin'], ['member', 'private-channel'], 'release'],
  ['restart-persistence', ['delivery', 'agents', 'memory', 'skills', 'connections', 'routines'], ['slack', 'admin', 'provider'], ['restart-target', 'connection', 'provider-rows'], 'release'],
  ['memory', ['memory'], ['slack', 'admin'], ['agent'], 'release'],
  ['skills', ['skills'], ['slack', 'admin'], ['agent', 'skill-source'], 'release'],
  ['avatar-attachments', ['admin', 'delivery'], ['slack', 'admin'], ['agent', 'image-pdf'], 'release'],
  ['private-schedule', ['routines', 'auth'], ['slack', 'admin'], ['private-channel', 'member'], 'release'],
  ['connection-revocation', ['connections'], ['slack', 'admin', 'provider'], ['disposable-connection', 'member', 'provider-rows'], 'release'],
  ['connection-dependent-schedule-recovery', ['connections', 'routines'], ['slack', 'admin', 'provider'], ['disposable-connection', 'provider-rows', 'dependent-schedule'], 'release'],
  ['fresh-install', ['auth'], ['slack', 'admin'], ['disposable-install-target', 'public-source-artifact', 'oauth-account'], 'release'],
];

export function templateSpec(mode = 'changed', areas = [], now = Date.now()) {
  if (!['changed', 'regression', 'release'].includes(mode) || areas.some((a) => !Object.hasOwn(REGRESSION_AREAS, a))) throw new Error('Choose a known mode and areas.');
  if (mode === 'changed' && areas.length === 0) throw new Error('Changed template needs --area. Inspect verify:regression --plan first.');
  const chosen = journeys.filter(([, affected, , , minimum]) => mode === 'release'
    || mode === 'regression' && minimum === 'regression'
    || mode === 'changed' && affected.some((area) => areas.includes(area)));
  const context = (grade) => ({ grade, target: 'unresolved', servingVersion: 'unresolved', model: 'unresolved', actor: 'unresolved', fixtures: 'unresolved', state: 'unresolved', config: 'unresolved' });
  const spec = { mode, purpose: 'verification', contexts: { candidate: context(mode === 'changed' ? 'local' : 'deployed') }, capabilities: {}, cases: [] };
  for (const [id, affected, proof, fixtures] of chosen) {
    const ctx = id === 'fresh-install' ? 'installation' : 'candidate';
    spec.contexts[ctx] ??= context('deployed');
    const requires = ['target', 'owner', ...proof.filter((p) => p !== 'provider'), ...fixtures];
    for (const name of requires) {
      spec.capabilities[`${ctx}.${name}`] = {
        available: false, kind: ['owner', 'member'].includes(name) ? 'actor' : name === 'target' ? 'target' : ['slack', 'admin'].includes(name) ? 'tool' : 'fixture',
        ...(['owner', 'member'].includes(name) ? { expectedRole: name } : {}),
        scope: contextScope(ctx, spec.contexts[ctx]),
        observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1_800_000).toISOString(),
        evidence: [], reason: 'Not yet observed. Resolve with the existing lane status, signed-in UI, or exact synthetic fixture readback.',
      };
    }
    spec.cases.push({ id, title: id.replaceAll('-', ' '), context: ctx, areas: affected,
      requires: [...new Set(requires)].map((name) => `${ctx}.${name}`), proof, maxAttempts: 2, maxWaitMs: 120_000, minObservationMs: id.includes('schedule') ? 30_000 : 0 });
  }
  if (spec.cases.some((c) => c.id === 'connection-revocation') && spec.cases.some((c) => c.id === 'connection-dependent-schedule-recovery')) {
    spec.groups = [{ id: 'LC05-V3-revoke-reconnect', title: 'Revocation and dependent-work recovery',
      required: ['connection-revocation', 'connection-dependent-schedule-recovery'], optional: [],
      scopeReason: 'Selected revocation coverage includes exact reconnect/provider read and separately observed dependent-schedule recovery.' }];
  }
  return spec;
}
