/**
 * Every shape of the shared Slack journey page that a page other than an
 * Agent app's renders, with fixed inputs, so a test can hold their HTML
 * byte for byte while the shared component grows.
 */
import {
  renderSlackAccessDeniedPage,
  renderSlackAuthorizationHandoffPage,
  renderSlackInvitationCompletePage,
  renderSlackInvitationMismatchPage,
  renderSlackInvitationPage,
  renderSlackInvitationUnavailablePage,
  renderSlackJourneyPage,
  renderSlackOwnerCompletePage,
  renderSlackSetupHttpsRequiredPage,
  renderSlackSignInPage,
} from '../../src/admin/page.ts';
import { onboardingSteps } from '../../src/admin/onboarding-steps.ts';

const steps = onboardingSteps({ selfHosted: false, onChickpeaModels: false, githubOffered: true, slackAppsOffered: true });

export const JOURNEY_PAGE_CASES: ReadonlyArray<readonly [string, () => string]> = [
  ['plain', () => renderSlackJourneyPage({ surface: 's', eyebrow: 'Eyebrow', title: 'Title', body: '<p>b</p>' })],
  ['everything', () => renderSlackJourneyPage({
    surface: 's', eyebrow: 'Eyebrow', title: 'Title', intro: 'Intro', titleSuccess: true, status: 'Status', statusId: 'st',
    body: '<p>b</p>', alert: 'Alert', rootAttributes: 'data-x="1"', progress: { steps, current: 'model' },
    badge: 'Acme', badgeAction: { href: '/x', label: 'Change' },
  })],
  ['empty status', () => renderSlackJourneyPage({ surface: 's', eyebrow: 'E', title: 'T', status: '', body: '' })],
  ['scene', () => renderSlackJourneyPage({
    surface: 's', eyebrow: 'E', title: 'T', body: '', scene: 'sign-in', progress: { steps, current: 'slack' }, badge: 'Acme',
  })],
  ['handoff', () => renderSlackAuthorizationHandoffPage('https://slack.com/oauth/v2/authorize?client_id=1')],
  ['sign-in', () => renderSlackSignInPage('/admin')],
  ['access denied', () => renderSlackAccessDeniedPage({ purpose: 'first_owner', destination: '/admin', reason: 'other' })],
  ['owner complete', () => renderSlackOwnerCompletePage('/admin')],
  ['invitation', () => renderSlackInvitationPage({ teamId: 'T1', teamName: 'Acme' })],
  ['invitation mismatch', () => renderSlackInvitationMismatchPage()],
  ['invitation complete', () => renderSlackInvitationCompletePage('/admin')],
  ['invitation unavailable', () => renderSlackInvitationUnavailablePage()],
  ['https required', () => renderSlackSetupHttpsRequiredPage({ loopback: true })],
];
