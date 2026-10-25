import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import vm from 'node:vm';

import { Hono } from 'hono';

import { createRunReviewAdminApi } from '../src/admin/run-review-api.ts';
import { setRequestPrincipal } from '../src/auth/service.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { configureRunReview } from '../src/review/port.ts';
import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';

/**
 * "Help improve Chickpea" in Admin's script, in a fake DOM. Its requests go
 * to the real Admin API over a fake run review port; with no privacy URL the
 * page is rendered as where the host offers no setting.
 */

const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>, { installationId: 'inst_help' });
const PRIVACY_URL = 'https://chickpea.example/privacy#help-improve-chickpea';
const LABEL = 'Help improve Chickpea';
const HELP = 'Chickpea keeps a copy of each Agent conversation for 30 days so the Chickpea team can find and fix bugs. Copies are encrypted, have credentials removed, and are never used to train AI models. Turning this off deletes the copies kept so far.';
const UPDATE_ERROR = 'Could not update Help improve Chickpea.';
const LOAD_ERROR = 'Could not load Help improve Chickpea.';

const TRY = {
  stage: 'try', revision: 'revision_try', agentId: 'agent_chickpea', redirectTo: null,
  workspace: { id: 'TACME', name: 'Acme' }, channel: null, providerId: 'anthropic',
  modelId: 'anthropic/claude-sonnet-5-5', models: [], slackAppId: 'AACME',
  tryStartedAt: 1_800_000_000_000, completedAt: null,
};

interface FakeResponse { ok: boolean; status: number; text(): Promise<string> }

function response(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function harness(t: TestContext, options: {
  path: string;
  offered: boolean;
  enabled?: boolean;
  onboarding?: Record<string, unknown>;
  /** The host refuses the next change. */
  refuseChange?: boolean;
  /** The host cannot answer the first read. */
  failFirstRead?: boolean;
}) {
  let html = '';
  const app = { className: '', get innerHTML() { return html; }, set innerHTML(value: string) { html = value; } };
  const listeners: Record<string, (event: { target: unknown; preventDefault?(): void }) => void> = {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let enabled = options.enabled ?? true;
  let refuse = options.refuseChange === true;
  let failRead = options.failFirstRead === true;
  configureRunReview({
    enabled: async () => {
      if (failRead) {
        failRead = false;
        throw new Error('registry unavailable');
      }
      return enabled;
    },
    setEnabled: async (_id, change) => {
      if (refuse) {
        refuse = false;
        throw new Error('registry unavailable');
      }
      enabled = change.enabled;
      return enabled;
    },
    capturing: async () => enabled,
    record: async () => {},
    privacyUrl: PRIVACY_URL,
  });
  t.after(() => configureRunReview(undefined));
  const principal: AuthPrincipal = {
    userId: 'user_owner', membershipId: 'membership_owner', organizationId: 'org_help', role: 'owner',
    authenticatorKind: 'test_slack_session', credentialId: 'credential_help', correlationId: 'request_help', machine: false,
  };
  const identity = {
    getUser: async () => ({ id: 'user_owner', slackTeamId: 'TACME', slackUserId: 'UOWNER123' }),
    recordAuthAudit: async () => undefined,
  } as unknown as IdentityStore;
  const api = new Hono();
  api.use('*', async (c, next) => {
    setRequestPrincipal(c.req.raw, principal);
    await next();
  });
  api.route('/admin/api', createRunReviewAdminApi({ identity: () => identity }));
  const onboarding = options.onboarding;
  const fetch = async (path: string, init?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = init?.method ?? 'GET';
    requests.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (path === '/admin/api/settings/help-improve') {
      const answer = await api.request(path, {
        method, headers: { 'content-type': 'application/json' }, ...(init?.body ? { body: init.body } : {}),
      }, ENV);
      return { ok: answer.ok, status: answer.status, text: () => answer.text() };
    }
    if (path === '/admin/api/onboarding' && onboarding) return response(onboarding);
    if (path === '/admin/api/agents') return response({ agents: [] });
    if (path === '/admin/api/assignments') return response({ assignments: [] });
    if (path === '/admin/api/slack-connection') return response({ connected: true, teamId: 'TACME', teamName: 'Acme' });
    if (path === '/admin/api/providers') return response({ providers: [] });
    if (path === '/admin/api/models') return response({ providers: [] });
    return response({ error: 'not_found' }, 404);
  };
  const start = new URL(options.path, 'https://chickpea.example');
  const location = { pathname: start.pathname, search: start.search, assign() {} };
  const applyPath = (path: string) => {
    const url = new URL(path, 'https://chickpea.example');
    location.pathname = url.pathname;
    location.search = url.search;
  };
  const document = {
    getElementById(id: string) {
      return id === 'app' ? app : { innerHTML: '', textContent: '', focus() {}, setAttribute() {}, scrollIntoView() {} };
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type: string, listener: (event: { target: unknown }) => void) { listeners[type] = listener; },
  };
  const serverHtml = renderAdminPage({
    usageAdminUi: true, workspaceAdminUi: true, installationOwner: true,
    browserOffered: false, selfHosted: false, billingOffered: false,
    ...(options.offered ? { helpImprovePrivacyUrl: PRIVACY_URL } : {}),
    ...(onboarding ? { onboarding: { initial: onboarding, githubConnectPath: null, githubReturned: false } } : {}),
  } as Parameters<typeof renderAdminPage>[0]);
  const script = serverHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    console, Date, document, fetch, clearTimeout,
    setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms).unref(),
    history: {
      pushState(_state: unknown, _title: string, path: string) { applyPath(path); },
      replaceState(_state: unknown, _title: string, path: string) { applyPath(path); },
    },
    location, URL, URLSearchParams, navigator: {}, window: { addEventListener() {} },
  }, { filename: 'admin-help-improve-inline.js' });
  await flush();
  const toggle = async (checked: boolean) => {
    listeners.change!({ target: { checked, getAttribute: (name: string) => (name === 'data-action' ? 'help-improve-enabled' : null) } });
    await flush();
  };
  const click = async (action: string, attributes: Record<string, string> = {}) => {
    const target = {
      closest(selector: string) { return selector === '[data-action]' ? this : null; },
      getAttribute(name: string) { return name === 'data-action' ? action : attributes[name] ?? null; },
    };
    listeners.click!({ target, preventDefault() {} });
    await flush();
  };
  return { html: () => html, serverHtml, requests, toggle, click, enabled: () => enabled };
}

function decoded(html: string): string {
  return html.replace(/&rsquo;/g, '’').replace(/&hellip;/g, '…').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
}

const settingRequests = (requests: Array<{ path: string; method: string; body: unknown }>) =>
  requests.filter((request) => request.path === '/admin/api/settings/help-improve').map((request) => [request.method, request.body]);

function switchState(html: string): 'on' | 'off' | 'absent' {
  const input = /<input type="checkbox" data-action="help-improve-enabled"[^>]*>/.exec(html)?.[0];
  return !input ? 'absent' : / checked/.test(input) ? 'on' : 'off';
}

test('hosted Settings shows the setting with its approved copy, its Learn more link, and the host\'s state', async (t) => {
  const page = await harness(t, { path: '/admin/settings/help-improve', offered: true, enabled: true });
  const html = decoded(page.html());
  assert.match(html, /data-section="help-improve"[^>]*><span class="chan-name">Help improve Chickpea<\/span><\/button>/);
  assert.ok(html.includes(`<h1 class="page-title">${LABEL}</h1>`));
  assert.ok(html.includes(HELP));
  assert.ok(html.includes(`<a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Learn more</a>`));
  assert.equal(switchState(page.html()), 'on');
  assert.deepEqual(settingRequests(page.requests), [['GET', undefined]]);
});

test('turning it off writes the change; a refusal says so and leaves the switch as the host has it', async (t) => {
  const page = await harness(t, { path: '/admin/settings/help-improve', offered: true, refuseChange: true });
  await page.toggle(false);
  assert.ok(decoded(page.html()).includes(UPDATE_ERROR));
  assert.equal(switchState(page.html()), 'on', 'the refused change leaves it on');
  await page.toggle(false);
  assert.equal(page.enabled(), false);
  assert.equal(switchState(page.html()), 'off');
  assert.ok(!decoded(page.html()).includes(UPDATE_ERROR), 'a later change clears the error');
  assert.deepEqual(settingRequests(page.requests), [['GET', undefined], ['PUT', { enabled: false }], ['PUT', { enabled: false }]]);
});

test('a read the host cannot answer shows no switch until Try again reads it', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const page = await harness(t, { path: '/admin/settings/help-improve', offered: true, failFirstRead: true });
  assert.ok(decoded(page.html()).includes(LOAD_ERROR));
  assert.equal(switchState(page.html()), 'absent', 'no guessed state is shown');
  await page.click('help-improve-retry');
  assert.ok(!decoded(page.html()).includes(LOAD_ERROR));
  assert.equal(switchState(page.html()), 'on');
});

test('where the host offers no setting, Settings has no section and nothing asks for it', async (t) => {
  const page = await harness(t, { path: '/admin/settings/help-improve', offered: false });
  const html = decoded(page.html());
  assert.ok(!html.includes(LABEL));
  assert.ok(!html.includes('data-section="help-improve"'));
  assert.match(page.serverHtml, /"helpImproveOffered":false/);
  assert.deepEqual(settingRequests(page.requests), []);
});

for (const stage of ['try', 'complete'] as const) {
  test(`onboarding's ${stage} step shows the same row with its own read, and its switch works there`, async (t) => {
    const page = await harness(t, { path: '/admin/onboarding', offered: true, onboarding: { ...TRY, stage } });
    const html = decoded(page.html());
    assert.ok(html.includes(LABEL));
    assert.ok(html.includes(HELP));
    assert.equal(switchState(page.html()), 'on');
    await page.toggle(false);
    assert.equal(switchState(page.html()), 'off');
    assert.deepEqual(settingRequests(page.requests), [['GET', undefined], ['PUT', { enabled: false }]]);
  });
}

test('onboarding shows no row where the host offers no setting', async (t) => {
  const page = await harness(t, { path: '/admin/onboarding', offered: false, onboarding: TRY });
  assert.ok(!decoded(page.html()).includes(LABEL));
  assert.deepEqual(settingRequests(page.requests), []);
});
