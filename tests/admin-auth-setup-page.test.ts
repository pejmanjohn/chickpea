import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  renderSlackAccessDeniedPage,
  renderSlackOwnerCompletePage,
  renderSlackRecoveryPage,
  renderSlackManualSetupPage,
  renderSlackSetupPage,
  renderSlackSignInPage,
} from '../src/admin/page.ts';
import type { SlackSetupTransaction } from '../src/identity/types.ts';
import { buildSlackAppManifest, slackManifestPrefillUrl } from '../src/slack/app-manifest.ts';

const ORIGIN = 'https://chickpea.example';
const DESTINATION = '/admin/channels';
const MANIFEST = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });

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
  assert.match(html, /<h1 class="auth-title" id="auth-title">Welcome back<\/h1>/);
  assert.match(html, /Sign in with the Slack account you use with Chickpea in this workspace\./);
  assert.match(html, /name="destination" value="\/admin\/channels"/);
  assert.match(
    html,
    /<button class="auth-button slack-provider-button"[^>]*><span class="slack-provider-logo slack-logo-image" aria-hidden="true"><\/span>Continue with Slack<\/button>/,
  );
  assert.match(html, /\.slack-logo-image\{background:url\("data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /Full Slack members|Guests and Slack Connect participants/);
  assert.doesNotMatch(html, />Sign in with Slack<\/h1>/);
  assert.doesNotMatch(html, /invitation-only|invited to manage/i);
  assert.match(html, /<main[^>]*aria-labelledby="auth-title"/);
  assert.doesNotMatch(html, /role="status"/);
  assert.doesNotMatch(html, /autofocus/);
  assert.match(html, /@media\(max-width:/);
  assert.doesNotMatch(html, /password|forgot|sign up|cloudflare access|admin token|migrate/i);
});

test('Slack sign-in may resume one exact authenticated management setup path', () => {
  const html = renderSlackSignInPage('/setup/setup_connector_123');
  assert.match(html, /name="destination" value="\/setup\/setup_connector_123"/);
  assert.doesNotMatch(
    renderSlackSignInPage('/setup/setup_connector_123/complete'),
    /value="\/setup\/setup_connector_123\/complete"/,
  );
});

test('setup leads with Add to Slack and keeps the customer-owned app as a fallback', () => {
  const render = (
    state: SlackSetupTransaction['state'],
    gatewayState?: 'disconnected' | 'pending' | 'connected' | 'error',
  ) => renderSlackSetupPage({
    setup: setup(state), destination: DESTINATION, manifest: MANIFEST,
    ...(gatewayState ? { gatewayState } : {}),
  });
  const creation = render('awaiting_app_creation');
  assert.match(creation, /Add Chickpea to Slack/);
  assert.match(creation, /<p class="auth-eyebrow">Slack setup<\/p>/);
  assert.doesNotMatch(creation, /<p class="auth-eyebrow">Private Slack setup<\/p>/);
  assert.match(creation, /data-primary-action="gateway-install"/);
  assert.match(
    creation,
    /<button class="auth-button slack-provider-button"[^>]*data-primary-action="gateway-install"[^>]*><span class="slack-provider-logo slack-logo-image" aria-hidden="true"><\/span>Add to Slack<\/button>/,
  );
  assert.doesNotMatch(creation, /auth-progress|Create app<\/li>|Verify Owner<\/li>/);
  assert.doesNotMatch(creation, /No app configuration token or Slack credentials to copy/);
  assert.doesNotMatch(creation, /Slack app creation is the only required action now/);
  assert.match(creation, /<details[^>]*data-secondary-action="customer-owned-app"/);
  assert.match(creation, /Use your own Slack app instead/);
  assert.match(creation, /Generate an App Configuration token in Slack/);
  assert.match(creation, /https:\/\/api\.slack\.com\/apps#:~:text=Your%20App%20Configuration%20Tokens/);
  assert.match(creation, /class="[^\"]*slack-logo-image/);
  assert.match(creation, /xoxe\.xoxp-/);
  assert.match(creation, /refresh token beginning xoxe-/i);
  assert.match(creation, /href="\/admin\/setup\/manual"/);
  assert.doesNotMatch(creation, /<p class="setup-token-note"|Sent once to Slack|▢/);
  assert.doesNotMatch(creation, /href="\/admin\/setup\/manual"[^>]*target="_blank"/);
  assert.doesNotMatch(creation, /name="(?:appId|clientId|clientSecret|signingSecret|observedManifest)"/);
  assert.doesNotMatch(creation, /Install Chickpea in Slack|Become the first Owner/);
  assert.match(creation, /data-slack-setup-state="awaiting_app_creation"/);
  assert.match(creation, /\.auth-card\{padding-block:56px\}/);
  assert.match(creation, /\.auth-intro\+form\{margin-top:28px\}/);

  const connected = render('awaiting_app_creation', 'connected');
  assert.match(connected, /Slack is connected/);
  assert.match(connected, /<p class="auth-eyebrow">Slack setup<\/p>/);
  assert.match(connected, /class="auth-title-success"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(connected, /Slack app creation is the only required action now|auth-progress/);
  assert.match(
    connected,
    /<button class="auth-button slack-provider-button"[^>]*data-primary-action="gateway-owner"[^>]*><span class="slack-provider-logo slack-logo-image" aria-hidden="true"><\/span>Continue with Slack<\/button>/,
  );

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
  assert.match(events, /https:\/\/api\.slack\.com\/apps\/A12345678\/event-subscriptions/);
  assert.match(events, /Retry/);
  assert.match(events, /Save Changes/);

  const owner = render('bot_installed');
  assert.match(owner, /data-primary-action="claim-owner"/);
  assert.match(owner, /same Slack member who installed/i);
  assert.match(
    owner,
    /<button class="auth-button slack-provider-button"[^>]*data-primary-action="claim-owner"[^>]*><span class="slack-provider-logo slack-logo-image" aria-hidden="true"><\/span>Sign in with Slack<\/button>/,
  );
  assert.doesNotMatch(owner, /configurationToken|Install Chickpea in Slack/);
});

test('manual setup adopts credentials before the shared signed Events verification stage', () => {
  const html = renderSlackManualSetupPage({
    setup: setup('awaiting_app_creation'), destination: '/admin/onboarding',
    manifest: MANIFEST, manifestPrefillUrl: slackManifestPrefillUrl(MANIFEST),
  });
  assert.match(html, /data-slack-manual-setup-state="awaiting_app_creation"/);
  assert.match(html, /class="onboarding-shell"/);
  assert.match(html, /Create Chickpea/);
  assert.match(html, /Finish creating Chickpea/);
  assert.doesNotMatch(html, /data-manual-step-(?:panel|target)="events"/);
  assert.match(html, /data-manual-step-target="credentials">Next: Add app credentials/);
  assert.match(html, /Already created the app\? Add its credentials/);
  assert.match(html, /verify the Events URL after Slack installation/);
  assert.match(html, /Add app credentials/);
  assert.match(html, /create-workspace\.webp/);
  assert.match(html, /create-review\.webp/);
  assert.match(html, /signing-secret\.webp/);
  assert.match(html, /name="appId"/);
  assert.match(html, /name="clientId"/);
  assert.match(html, /name="clientSecret"/);
  assert.match(html, /name="signingSecret"/);
  assert.match(html, /name="observedManifest"/);
  assert.match(html, /aria-label="Agent handle permissions"/);
  assert.match(html, /class="onboarding-prerequisite-title"/);
  assert.match(html, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(html, /manifest already requests <code>usergroups:read<\/code> and <code>usergroups:write<\/code>/);
  assert.match(html, /separate workspace permission that a manifest cannot change/);
  assert.match(html, /Create and edit user groups/);
  assert.match(html, /permits workspace members, not just Chickpea/);
  assert.doesNotMatch(html, /name="botToken"|xoxb-/);
  assert.match(html, /src="\/admin\/setup\/manual\/client\.js"/);
});

test('the resume bridge survives only as the user-controlled rejection fallback', () => {
  const resumable = renderSlackSetupPage({
    destination: DESTINATION, manifest: MANIFEST,
    notice: 'cancelled',
  });
  assert.doesNotMatch(resumable, /data-slack-setup-auto-resume/);
  assert.match(resumable, /name="notice" value="cancelled"/);
  assert.match(resumable, /Slack installation was cancelled/);
  assert.match(resumable, /id="slack-setup-open-form"/);

  const rejected = renderSlackSetupPage({
    destination: '/admin', manifest: MANIFEST,
    error: 'setup_invalid',
  });
  assert.match(rejected, /data-slack-setup-state="capability_required"/);
  assert.match(rejected, /role="alert"[^>]*tabindex="-1"/);
});

test('a known state renders the real setup stage without any transaction record', () => {
  const fresh = renderSlackSetupPage({
    state: 'awaiting_app_creation', destination: DESTINATION, manifest: MANIFEST,
  });
  assert.match(fresh, /data-slack-setup-state="awaiting_app_creation"/);
  assert.match(fresh, /Add Chickpea to Slack/);
  assert.doesNotMatch(fresh, /Resume private setup|id="slack-setup-open-form"/);
  // The empty live region carries the client script's missing-capability status.
  assert.match(fresh, /<p class="auth-status" id="slack-setup-status" role="status" aria-live="polite" hidden><\/p>/);

  const installed = renderSlackSetupPage({
    state: 'bot_install_pending', destination: DESTINATION, manifest: MANIFEST,
  });
  assert.match(installed, /Verify Slack Events/);
  // Without the transaction record no app identifier reaches an unauthenticated page.
  assert.match(installed, /href="https:\/\/api\.slack\.com\/apps"/);
  assert.doesNotMatch(installed, /A12345678/);

  const manual = renderSlackManualSetupPage({
    state: 'awaiting_app_creation', destination: DESTINATION, manifest: MANIFEST,
    manifestPrefillUrl: slackManifestPrefillUrl(MANIFEST),
  });
  assert.match(manual, /data-slack-manual-setup-state="awaiting_app_creation"/);
  assert.match(manual, /Create Chickpea/);
  assert.match(manual, /id="slack-setup-status"[^>]*hidden/);
  assert.doesNotMatch(manual, /Resume manual setup/);
});

test('shared gateway failures explain safety, retry, and the customer-owned fallback', () => {
  for (const error of ['gateway_not_configured', 'gateway_unreachable'] as const) {
    const html = renderSlackSetupPage({
      setup: setup('awaiting_app_creation'),
      destination: DESTINATION,
      manifest: MANIFEST,
      error,
    });
    assert.match(html, /Your deployment and setup link are safe/);
    assert.match(html, /data-primary-action="gateway-install"/);
    assert.match(html, /Use your own Slack app instead/);
    assert.match(html, /role="alert"/);
  }
});

test('wrong-account denial explains automatic provisioning and gives a Slack retry', () => {
  const html = renderSlackAccessDeniedPage({
    purpose: 'login', destination: DESTINATION, reason: 'user_mismatch',
    workspace: { teamId: 'TACME', teamName: 'Acme' },
  });
  assert.match(html, /Try another Slack account/);
  assert.match(html, /Acme \(TACME\)/);
  assert.match(html, /First interact with a Chickpea Agent/);
  assert.match(html, /If access was suspended or removed, ask an Owner to restore it/);
  assert.match(html, /name="purpose" value="login"/);
  assert.match(html, /name="destination" value="\/admin\/channels"/);
  assert.doesNotMatch(html, /invited user|expected user|email|password/i);
});

test('first-Owner completion returns directly to the exact safe view', () => {
  const html = renderSlackOwnerCompletePage(DESTINATION);
  assert.match(html, /data-slack-auth-surface="owner-complete"/);
  assert.match(html, /🎉 Installation successful/);
  assert.doesNotMatch(html, /You’re the first Owner|Your requested control-plane view is ready/);
  assert.doesNotMatch(html, /add a second Owner|destructive fresh reset|invite an Admin/i);
  assert.match(html, /href="\/admin\/channels"/);
  assert.match(html, /html\[data-slack-auth-surface="owner-complete"\] \.auth-actions\{margin-top:32px\}/);
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
