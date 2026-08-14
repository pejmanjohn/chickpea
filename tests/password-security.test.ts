import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PasswordPolicyError,
  assertPasswordPolicy,
} from '../src/auth/password-policy.ts';
import {
  passwordInvitationClientScript,
  passwordResetClientScript,
  renderInvitationJoinPage,
  renderJoinBootstrapPage,
  renderPasswordInvitationPage,
  renderPasswordResetPage,
  renderResetBootstrapPage,
} from '../src/join/page.ts';
import {
  passwordFormClientScript,
  renderPasswordLogin,
  renderPasswordOwnerSetupPage,
  renderPasswordChangePage,
  renderPasswordRecoveryPage,
} from '../src/admin/page.ts';

test('password sign-in and account creation share the centered Chickpea brand', () => {
  for (const html of [
    renderPasswordLogin(),
    renderPasswordOwnerSetupPage(),
    renderPasswordChangePage(),
    renderPasswordRecoveryPage(),
    renderPasswordRecoveryPage({ success: true }),
    renderJoinBootstrapPage(),
    renderResetBootstrapPage(),
    renderInvitationJoinPage({ email: 'teammate@example.com' }),
    renderPasswordInvitationPage(),
    renderPasswordResetPage(),
  ]) {
    assert.match(html, /class="auth-brand" aria-label="Chickpea"/);
    assert.match(html, /class="auth-brand-mark"/);
    assert.match(html, /class="auth-brand-name">Chickpea</);
    assert.match(html, /\.auth-brand-mark\{width:54px;height:54px/);
    assert.match(
      html,
      /\.auth-brand\s*\{[^}]*display:flex;[^}]*align-items:center;[^}]*justify-content:center;[^}]*text-align:center/,
    );
  }
});

test('password policy enforces Unicode length bounds without composition rules', () => {
  assert.throws(
    () => assertPasswordPolicy('a'.repeat(7)),
    (error: unknown) => error instanceof PasswordPolicyError && error.code === 'too_short',
  );
  assert.doesNotThrow(() => assertPasswordPolicy('a'.repeat(8)));
  assert.doesNotThrow(() => assertPasswordPolicy(' '.repeat(16)));
  assert.doesNotThrow(() => assertPasswordPolicy('🫛'.repeat(128)));
  assert.throws(
    () => assertPasswordPolicy('🫛'.repeat(129)),
    (error: unknown) => error instanceof PasswordPolicyError && error.code === 'too_long',
  );
});

test('password policy rejects pinned common and deployment-context passwords safely', () => {
  assert.throws(
    () => assertPasswordPolicy('mailcreated5240'),
    (error: unknown) => error instanceof PasswordPolicyError && error.code === 'common',
  );
  assert.throws(
    () => assertPasswordPolicy('my chickpea assistant password'),
    (error: unknown) => error instanceof PasswordPolicyError && error.code === 'context',
  );
  assert.throws(
    () => assertPasswordPolicy('welcome pejman to the system', {
      email: 'pejman@example.com',
      organizationName: 'Acme',
    }),
    (error: unknown) => error instanceof PasswordPolicyError && error.code === 'context',
  );
  assert.doesNotThrow(() => assertPasswordPolicy('several unrelated words 5729'));
});

test('invitation and reset forms expose the shared password requirement and live feedback', () => {
  for (const html of [renderPasswordInvitationPage(), renderPasswordResetPage()]) {
    assert.match(html, /8 or more characters/);
    assert.match(html, /Use at least 8 characters/);
    assert.match(html, /minlength="8"/);
  }
  assert.match(passwordInvitationClientScript(), /more .*characters.*needed/);
  assert.match(passwordResetClientScript(), /more .*characters.*needed/);
});

test('change and offline recovery forms expose the shared password requirement and live feedback', () => {
  for (const html of [renderPasswordChangePage(), renderPasswordRecoveryPage()]) {
    assert.match(html, /8 or more characters/);
    assert.match(html, /Use at least 8 characters/);
    assert.match(html, /minlength="8"/);
    assert.match(html, /\/admin\/password\/client\.js/);
  }
  assert.match(passwordFormClientScript(), /more character/);
});
