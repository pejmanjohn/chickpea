import { defineLiveCase, requiredSuitesForVariant, type AssertionToken } from '../schema.ts';
import type { FoundationEvaluation } from './agent-lifecycle.live.ts';
import { integerAt, markerAt, objectAt, recordsAt, result, stringsAt, upstreamRecord } from './_shared.ts';

export const INSTALLATION_APP_HOME_LIVE_BLOCKER =
  'Live acceptance lacks one projection for the resettable app baseline, installer and scope authority, credential revision, App Home publication, and selected route.';

export const INSTALLATION_APP_HOME_AUTH_CONTRACT = defineLiveCase({
  id: 'LC-10',
  title: 'Slack installation and App Home authority',
  area: 'installation',
  feature: 'slack_installation',
  entryPoints: ['oauth', 'app_home', 'slack_dm', 'admin'],
  variants: [
    {
      id: 'LC10-V1-install-route',
      title: 'Restore the authorized dedicated Slack app baseline',
      suites: requiredSuitesForVariant('LC10-V1-install-route'),
      fixtures: [
        { slot: 'admin', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'slack-app', kind: 'slack_app', fixtureClass: 'resettable_fixture' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
      ],
      actions: [
        {
          id: 'slack.app.uninstall',
          message: 'Uninstall the exact resettable QA app for run {{runMarker}} after freezing its baseline.',
          mutation: 'revoke',
          humanGate: 'login',
          fixtureSlots: ['admin', 'slack-app', 'agent'],
          cleanup: { strategy: 'exact_reversal', fixtureClass: 'resettable_fixture', reversalActionId: 'slack.app.install' },
        },
        {
          id: 'slack.app.install',
          message: 'Reinstall the same authorized QA app {{runMarker}} and restore its baseline identity.',
          mutation: 'authorize',
          humanGate: 'oauth_consent',
          fixtureSlots: ['admin', 'slack-app', 'agent'],
          cleanup: { strategy: 'revision_restore', fixtureClass: 'resettable_fixture', reversalActionId: 'slack.app.install' },
        },
      ],
      generatedEffects: [{
        id: 'app_home.generated',
        message: 'Slack publishes a fresh Agent directory after installation {{runMarker}}.',
        fixtureSlots: ['slack-app'],
        observerId: 'app_home.publication.read',
        cleanup: {
          strategy: 'attributed_residue',
          fixtureClass: 'attributed_residue',
          residue: {
            kind: 'app_home_publication',
            markerRequired: true,
            expectedState: 'The run-marked App Home publication is attributed to this restored app.',
          },
        },
      }],
      observers: ['installation.read', 'app_home.publication.read'],
      expected: [
        { token: 'installation.authorized', observerId: 'installation.read' },
        { token: 'installation.baseline_restored', observerId: 'installation.read' },
        { token: 'app_home.published', observerId: 'app_home.publication.read' },
      ],
      forbidden: [{ token: 'forbidden.no_unauthorized_mutation', observerId: 'installation.read' }],
      regressions: [{
        candidateId: 'CAND-LC10-install-route',
        lesson: 'A successful OAuth page does not prove the same app, team, installer, scopes, revision advance, and healthy restored baseline.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'action_receipt', 'cleanup_receipt'],
    },
    appHomeVariant(
      'LC10-V2-app-home-selection',
      'Publish App Home and select an authorized Agent',
      'CAND-LC10-app-home-selection',
      'A fresh App Home action must bind the exact selected Agent to a durable DM route.',
    ),
    appHomeVariant(
      'LC10-V3-stale-membership-denial',
      'Deny stale or unauthorized App Home selection',
      'CAND-LC10-stale-membership-denial',
      'A stale selection refreshes the directory with the generic unavailable notice and creates no route.',
    ),
  ],
});

function appHomeVariant(
  id: 'LC10-V2-app-home-selection' | 'LC10-V3-stale-membership-denial',
  title: string,
  candidateId: string,
  lesson: string,
) {
  return {
    id,
    title,
    suites: requiredSuitesForVariant(id),
    fixtures: [
      { slot: 'member', kind: 'actor' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'slack-app', kind: 'slack_app' as const, fixtureClass: 'resettable_fixture' as const },
      { slot: 'dm', kind: 'slack_dm' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'agent', kind: 'agent' as const, fixtureClass: 'resettable_fixture' as const },
    ],
    actions: [
      {
        id: 'app_home.open' as const,
        message: 'Open a fresh App Home directory for run {{runMarker}}.',
        mutation: 'none' as const,
        humanGate: 'none' as const,
        fixtureSlots: ['member', 'slack-app'],
        cleanup: { strategy: 'not_required' as const, fixtureClass: 'immutable_baseline' as const },
      },
      {
        id: 'app_home.select' as const,
        message: 'Select the run-marked Agent {{runMarker}} from the fresh App Home publication.',
        mutation: 'update' as const,
        humanGate: 'none' as const,
        fixtureSlots: ['member', 'slack-app', 'dm', 'agent'],
        cleanup: { strategy: 'revision_restore' as const, fixtureClass: 'resettable_fixture' as const, reversalActionId: 'route.handoff' as const },
      },
    ],
    generatedEffects: [{
      id: 'app_home.generated' as const,
      message: 'Slack publishes the fresh run-marked Agent directory {{runMarker}}.',
      fixtureSlots: ['slack-app'],
      observerId: 'app_home.publication.read' as const,
      cleanup: {
        strategy: 'attributed_residue' as const,
        fixtureClass: 'attributed_residue' as const,
        residue: {
          kind: 'app_home_publication' as const,
          markerRequired: true as const,
          expectedState: 'The run-marked App Home publication is attributed to this run.',
        },
      },
    }],
    observers: ['app_home.publication.read' as const, 'route.read' as const],
    expected: id === 'LC10-V2-app-home-selection'
      ? [
          { token: 'app_home.published' as const, observerId: 'app_home.publication.read' as const },
          { token: 'route.app_home_selected' as const, observerId: 'route.read' as const },
        ]
      : [{ token: 'app_home.published' as const, observerId: 'app_home.publication.read' as const }],
    forbidden: [{ token: 'forbidden.no_unauthorized_mutation' as const, observerId: 'route.read' as const }],
    regressions: [{ candidateId, lesson }],
    evidence: ['immutable_id' as const, 'revision' as const, 'observed_state' as const, 'action_receipt' as const, 'cleanup_receipt' as const],
  };
}

export type InstallationAppHomeAuthVariant = typeof INSTALLATION_APP_HOME_AUTH_CONTRACT.variants[number]['id'];
export type InstallationAppHomeAuthFailure =
  | 'not_last_in_deep_queue'
  | 'reset_authority_missing'
  | 'baseline_identity_changed'
  | 'credential_revision_not_advanced'
  | 'installation_unhealthy'
  | 'installer_or_scope_denied'
  | 'app_home_event_missing'
  | 'app_home_publication_missing'
  | 'app_home_publication_duplicate'
  | 'route_selection_missing'
  | 'unauthorized_route_mutation'
  | 'unavailable_notice_missing';

export function evaluateInstallationAppHomeAuth(
  variantId: InstallationAppHomeAuthVariant,
  upstream: unknown,
): FoundationEvaluation<InstallationAppHomeAuthFailure> {
  const input = upstreamRecord(upstream);
  if (!INSTALLATION_APP_HOME_AUTH_CONTRACT.variants.some(({ id }) => id === variantId)) {
    throw new Error('UNKNOWN_VARIANT');
  }
  markerAt(input);
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const slack = objectAt(input, 'slack');
  const failures: InstallationAppHomeAuthFailure[] = [];
  if (request.isLastInDeepQueue !== true) failures.push('not_last_in_deep_queue');
  if (request.resetAuthority !== true) failures.push('reset_authority_missing');

  if (variantId === 'LC10-V1-install-route') {
    const before = objectAt(admin, 'beforeInstallation');
    const after = objectAt(admin, 'afterInstallation');
    for (const field of ['workspaceId', 'teamId', 'appId', 'transportMode', 'defaultAgentId'] as const) {
      if (before[field] !== after[field]) failures.push('baseline_identity_changed');
    }
    if (after.health !== 'healthy') failures.push('installation_unhealthy');
    const beforeCredential = objectAt(admin, 'beforeCredential');
    const afterCredential = objectAt(admin, 'afterCredential');
    if (beforeCredential.appId !== afterCredential.appId || beforeCredential.teamId !== afterCredential.teamId ||
        beforeCredential.manifestFingerprint !== afterCredential.manifestFingerprint) {
      failures.push('baseline_identity_changed');
    }
    if (beforeCredential.revision === afterCredential.revision ||
        integerAt(after, 'revision') <= integerAt(before, 'revision')) {
      failures.push('credential_revision_not_advanced');
    }
    const receipt = objectAt(admin, 'installReceipt');
    const expectedScopes = stringsAt(request, 'expectedScopes').slice().sort();
    const actualScopes = stringsAt(receipt, 'scopes').slice().sort();
    if (receipt.installerMembershipId !== request.installerMembershipId ||
        receipt.appId !== after.appId || receipt.teamId !== after.teamId ||
        expectedScopes.length !== actualScopes.length || expectedScopes.some((scope, index) => scope !== actualScopes[index])) {
      failures.push('installer_or_scope_denied');
    }
  }

  const events = recordsAt(slack, 'events').filter((event) => event.type === 'app_home_opened');
  if (events.length !== 1) failures.push('app_home_event_missing');
  const publications = recordsAt(slack, 'publications').filter((publication) => publication.ok === true);
  if (publications.length === 0) failures.push('app_home_publication_missing');
  if (publications.length > 1) failures.push('app_home_publication_duplicate');
  const view = publications[0] && typeof publications[0].view === 'object' && publications[0].view !== null
    ? publications[0].view as Record<string, unknown>
    : undefined;
  if (view?.type !== 'home' || !Array.isArray(view.blocks)) failures.push('app_home_publication_missing');

  if (variantId === 'LC10-V2-app-home-selection') {
    const route = recordsAt(admin, 'routes').find((candidate) =>
      candidate.channelId === request.conversationId && candidate.threadTs === request.threadTs
    );
    if (route?.agentId !== request.agentId || objectAt(admin, 'selection').source !== 'app_home') {
      failures.push('route_selection_missing');
    }
  }
  if (variantId === 'LC10-V3-stale-membership-denial') {
    if (recordsAt(admin, 'routes').some((route) =>
      route.channelId === request.conversationId && route.threadTs === request.threadTs
    ) || objectAt(admin, 'selection').kind !== 'denied') failures.push('unauthorized_route_mutation');
    if (!JSON.stringify(view?.blocks ?? []).includes('That Agent is not available right now.')) {
      failures.push('unavailable_notice_missing');
    }
  }

  const observed: AssertionToken[] = [];
  if (variantId === 'LC10-V1-install-route') {
    if (!failures.some((failure) => ['installer_or_scope_denied', 'installation_unhealthy'].includes(failure))) {
      observed.push('installation.authorized');
    }
    if (!failures.some((failure) => [
      'baseline_identity_changed', 'credential_revision_not_advanced', 'installation_unhealthy',
    ].includes(failure))) observed.push('installation.baseline_restored');
  }
  if (!failures.some((failure) => [
    'app_home_event_missing', 'app_home_publication_missing', 'app_home_publication_duplicate',
  ].includes(failure))) observed.push('app_home.published');
  if (variantId === 'LC10-V2-app-home-selection' && !failures.includes('route_selection_missing')) {
    observed.push('route.app_home_selected');
  }
  if (variantId === 'LC10-V3-stale-membership-denial' && !failures.includes('unauthorized_route_mutation')) {
    observed.push('forbidden.no_unauthorized_mutation');
  }
  return result(observed, failures);
}
