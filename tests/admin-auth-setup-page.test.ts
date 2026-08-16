import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  renderSlackAccessDeniedPage,
  renderSlackOwnerCompletePage,
  renderSlackRecoveryPage,
  renderSlackSetupPage,
  renderSlackSignInPage,
} from '../src/admin/page.ts';
import type { SlackSetupTransaction } from '../src/identity/types.ts';
import { buildSlackAppManifest, slackManifestPrefillUrl } from '../src/slack/identity-manifest.ts';

const ORIGIN = 'https://chickpea.example';
const DESTINATION = '/admin/channels';
const MANIFEST = buildSlackAppManifest({ kind: 'control_plane', origin: ORIGIN });

function setup(state: SlackSetupTransaction['state']): SlackSetupTransaction {
  return {
    id: 'setup_default', state, revision: 4, destination: DESTINATION,
    createdAt: 1, updatedAt: 2, expiresAt: 3,
    appId: state === 'awaiting_app_creation' ? undefined : 'A12345678',
    manifestFingerprint: state === 'awaiting_app_creation' ? undefined : 'f'.repeat(64),
    credentialRevision: state === 'awaiting_app_creation' ? undefined : 'slackrev_app',
  } as SlackSetupTransaction;
}

test('Slack sign-in is the only visible login path and preserves a safe Admin destination', () => {
  const html = renderSlackSignInPage(DESTINATION);
  assert.match(html, /data-slack-auth-surface="sign-in"/);
  assert.match(html, /Sign in with Slack/);
  assert.match(html, /name="destination" value="\/admin\/channels"/);
  assert.match(html, /Control-plane access is invitation-only/);
  assert.match(html, /assigned channels without signing in here/);
  assert.match(html, /<main[^>]*aria-labelledby="auth-title"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /autofocus/);
  assert.match(html, /@media\(max-width:/);
  assert.doesNotMatch(html, /password|forgot|sign up|cloudflare access|admin token|migrate/i);
});

test('setup presents only the next durable action and keeps manual adoption secondary', () => {
  const render = (state: SlackSetupTransaction['state']) => renderSlackSetupPage({
    setup: setup(state), destination: DESTINATION, manifest: MANIFEST,
    manifestPrefillUrl: slackManifestPrefillUrl(MANIFEST),
  });
  const creation = render('awaiting_app_creation');
  assert.match(creation, /Create the Slack app/);
  assert.match(creation, /data-primary-action="create-app"/);
  assert.match(creation, /<details[^>]*data-secondary-action="manual-adoption"/);
  assert.doesNotMatch(creation, /Install Chickpea in Slack|Become the first Owner/);

  const install = render('app_created');
  assert.match(install, /data-primary-action="install-app"/);
  assert.doesNotMatch(install, /configurationToken|Become the first Owner/);

  const approval = render('approval_pending');
  assert.match(approval, /data-primary-action="resume-approval"/);
  assert.match(approval, /remains open for seven days/i);
  assert.doesNotMatch(approval, /configurationToken|Become the first Owner/);

  const events = render('bot_install_pending');
  assert.match(events, /data-primary-action="verify-events"/);
  assert.match(events, /signed Events/i);

  const owner = render('bot_installed');
  assert.match(owner, /data-primary-action="claim-owner"/);
  assert.match(owner, /same Slack member who installed/i);
  assert.doesNotMatch(owner, /configurationToken|Install Chickpea in Slack/);
});

test('setup refresh auto-resumes privately while rejected submissions stay user-controlled', () => {
  const resumable = renderSlackSetupPage({
    destination: DESTINATION, manifest: MANIFEST,
    manifestPrefillUrl: slackManifestPrefillUrl(MANIFEST), autoResume: true,
    notice: 'cancelled',
  });
  assert.match(resumable, /data-slack-setup-auto-resume="true"/);
  assert.match(resumable, /name="notice" value="cancelled"/);
  assert.match(resumable, /Slack installation was cancelled/);
  assert.match(resumable, /id="slack-setup-open-form"/);

  const rejected = renderSlackSetupPage({
    destination: '/admin', manifest: MANIFEST,
    manifestPrefillUrl: slackManifestPrefillUrl(MANIFEST), autoResume: false,
    error: 'setup_invalid',
  });
  assert.match(rejected, /data-slack-setup-auto-resume="false"/);
  assert.match(rejected, /role="alert"[^>]*tabindex="-1"/);
});

test('wrong-account and uninvited denial is safe and gives a Slack retry without implying basic access', () => {
  const html = renderSlackAccessDeniedPage({
    purpose: 'login', destination: DESTINATION, reason: 'user_mismatch',
    workspace: { teamId: 'TACME', teamName: 'Acme' },
  });
  assert.match(html, /Try another Slack account/);
  assert.match(html, /Acme \(TACME\)/);
  assert.match(html, /You can still use Chickpea agents in assigned Slack channels/);
  assert.match(html, /name="purpose" value="login"/);
  assert.match(html, /name="destination" value="\/admin\/channels"/);
  assert.doesNotMatch(html, /invited user|expected user|email|password/i);
});

test('first-Owner completion warns about redundancy and returns to the exact safe view', () => {
  const html = renderSlackOwnerCompletePage(DESTINATION);
  assert.match(html, /data-slack-auth-surface="owner-complete"/);
  assert.match(html, /You’re the first Owner/);
  assert.match(html, /add a second Owner/i);
  assert.match(html, /destructive fresh reset/i);
  assert.match(html, /href="\/admin\/channels"/);
  assert.doesNotMatch(html, /password|admin token|cloudflare access/i);
});

test('recovery remains a neutral Slack repair journey with accessible status and no identity grant', () => {
  for (const stage of ['token', 'credentials', 'waiting_events', 'complete'] as const) {
    const html = renderSlackRecoveryPage({
      stage, expectedAppId: 'A12345678', expectedTeamId: 'TACME',
    });
    assert.match(html, /data-slack-auth-surface="recovery"/);
    assert.match(html, /<main[^>]*aria-labelledby="auth-title"/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.doesNotMatch(html, /forgot password|replace owner password|create account/i);
  }
  assert.match(renderSlackRecoveryPage({ stage: 'complete' }), /existing Owner.*Sign in with Slack/i);
});
