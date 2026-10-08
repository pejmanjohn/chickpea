import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import type { BillingView } from '../src/admin/billing-api.ts';
import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type Listener = (event: { target: ReturnType<typeof actionTarget>; preventDefault?(): void }) => void;

function response(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

function actionTarget(attributes: Record<string, string>) {
  return {
    value: undefined,
    closest(selector: string) { return selector === '[data-action]' ? this : null; },
    getAttribute(name: string) { return attributes[name] ?? null; },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

const OWNER_VIEW: BillingView = {
  funding: 'platform',
  manage: true,
  balance: 48_210,
  plan: { key: 'starter', name: 'Starter' },
  period: { start: '2026-10-07T17:00:00.000Z', end: '2026-11-07T17:00:00.000Z' },
  use: {
    byAgent: [{ name: 'Research', credits: 1_240 }, { name: 'Chickpea', credits: 410 }],
    byPerson: [{ name: 'Maya Chen', credits: 1_500 }, { name: null, credits: 150 }],
  },
  offers: {
    plans: [
      { key: 'starter', name: 'Starter', priceCents: 5_000, credits: 50_000 },
      { key: 'team', name: 'Team', priceCents: 20_000, credits: 200_000 },
    ],
    topUps: [{ key: 'top_up_10', priceCents: 1_000, credits: 10_000, validMonths: 12 }],
  },
  ownKey: { ready: true, agentsWithoutKey: [] },
};

const OWN_KEY_VIEW: BillingView = { funding: 'own_key', manage: true };

const CHOOSE_PROVIDER = {
  stage: 'choose_provider', revision: 'revision_1', agentId: null, redirectTo: null,
  workspace: { id: 'TACME', name: 'Acme' }, channel: null, providerId: null, modelId: null, models: [],
  slackAppId: 'AACME', tryStartedAt: null, completedAt: null,
};

/** With no `billing`, GET /admin/api/billing answers 404, as where the host installed no port. */
async function harness(options: {
  path: string;
  billingOffered: boolean;
  billing?: BillingView;
  owner?: boolean;
  workspaceAdminUi?: boolean;
  /** The funding choice the onboarding journey already holds, as after a reload. */
  savedFunding?: 'platform' | 'own_key';
  /** Whether POST /admin/api/billing/funding fails, as when the host is down. */
  switchFails?: boolean;
}) {
  let html = '';
  const app = { className: '', get innerHTML() { return html; }, set innerHTML(value: string) { html = value; } };
  const listeners: Record<string, Listener> = {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const assigned: string[] = [];
  let onboarding: Record<string, unknown> = {
    ...CHOOSE_PROVIDER, ...(options.savedFunding ? { funding: options.savedFunding } : {}),
  };
  const location = {
    pathname: options.path, search: '',
    assign(url: string) { assigned.push(url); },
  };
  const applyPath = (path: string) => {
    const url = new URL(path, 'https://chickpea.example');
    location.pathname = url.pathname;
    location.search = url.search;
  };
  const document = {
    // Other elements a view reaches for (focus targets, live regions) accept writes and do nothing.
    getElementById(id: string) {
      return id === 'app' ? app : { innerHTML: '', textContent: '', focus() {}, setAttribute() {}, scrollIntoView() {} };
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type: string, listener: Listener) { listeners[type] = listener; },
  };
  const fetch = async (path: string, init?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path === '/admin/api/agents') return response({ agents: [] });
    if (path === '/admin/api/assignments') return response({ assignments: [] });
    if (path === '/admin/api/models') {
      return response({ providers: ['anthropic', 'openai', 'openrouter'].map((id) => ({ id, configured: false, suggestions: [] })) });
    }
    if (path === '/admin/api/slack-connection') return response({ connected: true, teamId: 'TACME', teamName: 'Acme' });
    if (path === '/admin/api/billing' && method === 'GET') {
      return options.billing ? response(options.billing) : response({ error: 'not_found' }, 404);
    }
    if (path === '/admin/api/billing/checkout') return response({ url: `https://checkout.stripe.com/c/pay/${body.key}` });
    if (path === '/admin/api/billing/portal') return response({ url: 'https://billing.stripe.com/p/session/portal' });
    if (path === '/admin/api/billing/funding') {
      if (options.switchFails) return response({ error: 'billing_unavailable' }, 503);
      return response(body.funding === 'own_key' ? OWN_KEY_VIEW : OWNER_VIEW);
    }
    if (path === '/admin/api/onboarding/funding') {
      onboarding = { ...onboarding, funding: body.funding, revision: 'revision_2' };
      return response(onboarding);
    }
    if (path === '/admin/api/onboarding') return response(onboarding);
    if (path === '/admin/api/onboarding/provider') {
      onboarding = { ...onboarding, stage: 'choose_model', providerId: body.providerId, models: ['anthropic/claude-sonnet-5-5'] };
      return response(onboarding);
    }
    return response({ error: 'not_found' }, 404);
  };
  const script = renderAdminPage({
    usageAdminUi: true,
    workspaceAdminUi: options.workspaceAdminUi ?? true,
    installationOwner: options.owner ?? true,
    browserOffered: !options.billingOffered,
    selfHosted: !options.billingOffered,
    billingOffered: options.billingOffered,
  }).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    console, Date, document, fetch, setTimeout, clearTimeout,
    history: {
      pushState(_state: unknown, _title: string, path: string) { applyPath(path); },
      replaceState(_state: unknown, _title: string, path: string) { applyPath(path); },
    },
    location, URL, URLSearchParams,
    navigator: {},
    window: { addEventListener() {} },
  }, { filename: 'admin-billing-page-inline.js' });
  await flush();
  const click = async (attributes: Record<string, string>) => {
    listeners.click!({ target: actionTarget(attributes), preventDefault() {} });
    await flush();
  };
  return { html: () => html, requests, assigned, location, click };
}

const billingWrites = (requests: Array<{ path: string; method: string }>) =>
  requests.filter((request) => request.path.startsWith('/admin/api/billing/'));

test('an Owner sees the balance, plan, period end, use by Agent and by person, and the three buttons', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: OWNER_VIEW });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan');
  assert.match(html, /<h1 class="page-title">Plan and credits<\/h1>/);
  assert.match(html, /data-action="open-billing"[^>]*>Plan and credits<\/button>/, 'the section switcher names the page');
  assert.match(html, /Balance<\/span><span class="usage-card-value">48,210<\/span>/);
  assert.match(html, /Used this period<\/span><span class="usage-card-value">1,650<\/span>/);
  assert.match(html, /<span class="usage-card-value">Starter<\/span><span class="hint">\$50 a month · renews November 7, 2026<\/span>/);
  assert.match(html, /<th>Agent<\/th>[\s\S]*<td>Research<\/td><td class="number">1,240<\/td>[\s\S]*<td>Chickpea<\/td><td class="number">410<\/td>/);
  assert.match(html, /<th>Person<\/th>[\s\S]*<td>Maya Chen<\/td><td class="number">1,500<\/td>[\s\S]*<td>Other<\/td><td class="number">150<\/td>/);
  assert.match(html, /data-action="billing-top-up" data-key="top_up_10">Top up<\/button>/);
  assert.match(html, /data-action="billing-change-plan">Change plan<\/button>/);
  assert.match(html, /data-action="billing-manage">Manage billing<\/button>/);
  assert.match(html, /Top up adds 10,000 credits for \$10\. They last 12 months\./);
  assert.deepEqual(billingWrites(page.requests), []);
});

test('each button asks the host for a Stripe page and opens the URL it returns', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: OWNER_VIEW });
  await page.click({ 'data-action': 'billing-top-up', 'data-key': 'top_up_10' });
  assert.deepEqual(page.assigned, ['https://checkout.stripe.com/c/pay/top_up_10']);
  assert.match(page.html(), /Opening Stripe&hellip;/, 'the busy button stays until the browser leaves');

  const plans = await harness({ path: '/admin/plan', billingOffered: true, billing: OWNER_VIEW });
  await plans.click({ 'data-action': 'billing-change-plan' });
  assert.match(plans.html(), /<strong>Starter<\/strong><p class="hint">\$50 a month · 50,000 credits each month<\/p><\/div><span class="badge badge-on"><span class="dot"><\/span>Current plan<\/span>/);
  assert.match(plans.html(), /<strong>Team<\/strong><p class="hint">\$200 a month · 200,000 credits each month<\/p><\/div><button[^>]*data-action="billing-choose-plan" data-key="team"/);
  await plans.click({ 'data-action': 'billing-choose-plan', 'data-key': 'team' });
  assert.deepEqual(plans.assigned, ['https://checkout.stripe.com/c/pay/team']);

  const portal = await harness({ path: '/admin/plan', billingOffered: true, billing: OWNER_VIEW });
  await portal.click({ 'data-action': 'billing-manage' });
  assert.deepEqual(portal.assigned, ['https://billing.stripe.com/p/session/portal']);

  assert.deepEqual([...billingWrites(page.requests), ...billingWrites(plans.requests), ...billingWrites(portal.requests)]
    .map((request) => [request.method, request.path, (request as { body?: unknown }).body]), [
    ['POST', '/admin/api/billing/checkout', { kind: 'top_up', key: 'top_up_10' }],
    ['POST', '/admin/api/billing/checkout', { kind: 'plan', key: 'team' }],
    ['POST', '/admin/api/billing/portal', {}],
  ]);
});

test('a Member sees the balance and that an Owner adds credits, with no buy buttons', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, owner: false, workspaceAdminUi: false,
    billing: { funding: 'platform', manage: false, balance: 48_210 },
  });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan', 'a Member may open the page');
  assert.match(html, /Balance<\/span><span class="usage-card-value">48,210<\/span>/);
  assert.match(html, /An Owner can add credits or change the plan\./);
  assert.match(html, /data-action="open-billing"[^>]*>Plan and credits<\/button>/);
  assert.doesNotMatch(html, /billing-top-up|billing-change-plan|billing-manage|Used this period|<th>Person<\/th>/);
  assert.doesNotMatch(html, /Use your own key instead|billing-use-own-key/);
});

test('an Owner on credits with a saved key switches back to it only after confirming that credits stay', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: OWNER_VIEW });
  assert.match(page.html(), /data-action="billing-use-own-key">Use your own key instead<\/button>/);
  await page.click({ 'data-action': 'billing-use-own-key' });
  assert.match(page.html(), /Switch to your own key\? Replies will use your saved API key\. Unused credits stay on your balance until they expire\.<\/span>/);
  assert.doesNotMatch(page.html(), /will stop replying/, 'no Agent is named when every pinned model has a key');
  await page.click({ 'data-action': 'billing-funding-cancel' });
  assert.doesNotMatch(page.html(), /Switch to your own key\?/);
  assert.deepEqual(billingWrites(page.requests), [], 'nothing switches before the Owner confirms');

  await page.click({ 'data-action': 'billing-use-own-key' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(billingWrites(page.requests).map((request) => [request.method, request.path, (request as { body?: unknown }).body]),
    [['POST', '/admin/api/billing/funding', { funding: 'own_key' }]]);
  assert.match(page.html(), /Your workspace pays for models with its own API key\./, 'the page turns into the own-key view');
  assert.match(page.html(), /data-action="billing-use-platform">Use Chickpea credits<\/button>/);
  assert.doesNotMatch(page.html(), /Switch to Chickpea credits\?/, 'the own-key view does not open on a confirmation');
});

test('the confirmation names each Agent whose pinned model has no saved key', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true,
    billing: { ...OWNER_VIEW, ownKey: { ready: true, agentsWithoutKey: ['Research', 'Ops <Desk>'] } },
  });
  assert.doesNotMatch(page.html(), /will stop replying/, 'only the confirmation warns');
  await page.click({ 'data-action': 'billing-use-own-key' });
  assert.match(page.html(), /Unused credits stay on your balance until they expire\. These Agents will stop replying until a key is added for their model&rsquo;s provider: Research, Ops &lt;Desk&gt;\.<\/span>/);
});

test('a switch back the host refuses shows its error beside the open confirmation', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: OWNER_VIEW, switchFails: true });
  await page.click({ 'data-action': 'billing-use-own-key' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  const html = page.html();
  const confirm = html.indexOf('data-action="billing-funding-confirm">Switch to your own key</button>');
  const error = html.indexOf('Could not switch to your own key. Try again.');
  assert.ok(confirm >= 0, 'the confirmation stays open and can be retried');
  assert.ok(error > confirm, 'the error follows the confirmation, not the Stripe buttons');
});

test('an Owner on credits whose default model has no key is told which key to add', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: { ...OWNER_VIEW, ownKey: { ready: false, provider: 'anthropic' } } });
  assert.match(page.html(), /data-action="open-settings" data-section="providers">Use your own key instead<\/button><\/div><p class="hint">Your default model needs an Anthropic API key\. Add one in Settings first\.<\/p>/);
  assert.doesNotMatch(page.html(), /billing-use-own-key/);
});

test('an Owner on credits with no saved key is sent to Model providers to add one first', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: { ...OWNER_VIEW, ownKey: { ready: false, provider: null } } });
  assert.match(page.html(), /data-action="open-settings" data-section="providers">Use your own key instead<\/button><\/div><p class="hint">Add a provider API key in Settings first\.<\/p>/);
  assert.doesNotMatch(page.html(), /billing-use-own-key/);
  await page.click({ 'data-action': 'open-settings', 'data-section': 'providers' });
  assert.equal(page.location.pathname, '/admin/settings/providers');
  assert.deepEqual(billingWrites(page.requests), []);
});

test('standalone shows nothing new: no billing request, no page, and onboarding goes straight to providers', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: false, billing: OWNER_VIEW });
  assert.equal(page.requests.some((request) => request.path.startsWith('/admin/api/billing')), false);
  assert.doesNotMatch(page.html(), /Plan and credits|open-billing/);
  assert.notEqual(page.location.pathname, '/admin/plan');

  const onboarding = await harness({ path: '/admin/onboarding', billingOffered: false });
  assert.match(onboarding.html(), /Choose your model provider/);
  assert.doesNotMatch(onboarding.html(), /Chickpea credits|onboarding-funding|Change how you pay/);
});

test('an Owner on their own key finds the page and switches to credits only after confirming', async () => {
  const home = await harness({ path: '/admin/agents', billingOffered: true, billing: OWN_KEY_VIEW });
  assert.match(home.html(), /data-action="open-billing"[^>]*>Plan and credits<\/button>/, 'the nav entry is there on your own key');
  assert.equal(home.requests.some((request) => request.path.startsWith('/admin/api/billing')), false, 'no billing read until the page opens');
  await home.click({ 'data-action': 'open-billing' });
  assert.equal(home.location.pathname, '/admin/plan');

  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: OWN_KEY_VIEW });
  assert.equal(page.location.pathname, '/admin/plan');
  assert.match(page.html(), /<h1 class="page-title">Plan and credits<\/h1>/);
  assert.match(page.html(), /Your workspace pays for models with its own API key\./);
  assert.match(page.html(), /data-action="billing-use-platform">Use Chickpea credits<\/button>/);
  assert.doesNotMatch(page.html(), /Top up|Change plan|Manage billing/);

  assert.match(page.html(), /With Chickpea credits, no API key is needed\./);
  await page.click({ 'data-action': 'billing-use-platform' });
  assert.match(page.html(), /Switch to Chickpea credits\? Replies will stop using your own key\./);
  await page.click({ 'data-action': 'billing-funding-cancel' });
  assert.doesNotMatch(page.html(), /Switch to Chickpea credits\?/);
  assert.deepEqual(billingWrites(page.requests), [], 'nothing switches before the Owner confirms');

  await page.click({ 'data-action': 'billing-use-platform' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(billingWrites(page.requests).map((request) => [request.method, request.path, (request as { body?: unknown }).body]),
    [['POST', '/admin/api/billing/funding', { funding: 'platform' }]]);
  assert.match(page.html(), /Balance<\/span><span class="usage-card-value">48,210<\/span>/, 'the page turns into the credits view');
  assert.match(page.html(), /data-action="billing-top-up"/);
});

test('a switch the host refuses keeps the confirmation open with a retryable error', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, billing: { funding: 'own_key', manage: true }, switchFails: true });
  await page.click({ 'data-action': 'billing-use-platform' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.match(page.html(), /Could not switch to Chickpea credits\. Try again\./);
  assert.match(page.html(), /data-action="billing-funding-confirm">Switch to credits<\/button>/);
});

test('a Member on their own key sees that an Owner can switch, with no switch', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, owner: false, workspaceAdminUi: false,
    billing: { funding: 'own_key', manage: false },
  });
  assert.equal(page.location.pathname, '/admin/plan');
  assert.match(page.html(), /Your workspace pays for models with its own API key\./);
  assert.match(page.html(), /An Owner can switch to Chickpea credits\./);
  assert.doesNotMatch(page.html(), /billing-use-platform/);
});

test('hosted onboarding offers credits first; choosing them skips the key', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, billing: { funding: 'own_key', manage: true } });
  const offer = page.html();
  assert.match(offer, /Choose how to pay for models/);
  const credits = offer.indexOf('data-funding="platform"');
  const ownKey = offer.indexOf('data-funding="own_key"');
  assert.ok(credits >= 0 && ownKey > credits, 'credits come first, your own key second');
  assert.match(offer, /<strong>Use Chickpea credits<\/strong>/);
  assert.match(offer, /<strong>Use your own key<\/strong>/);

  await page.click({ 'data-action': 'onboarding-funding', 'data-funding': 'platform' });
  assert.ok(page.requests.some((request) => request.method === 'POST' && request.path === '/admin/api/onboarding/funding' &&
    JSON.stringify(request.body) === JSON.stringify({ expectedRevision: 'revision_1', funding: 'platform' })));
  assert.match(page.html(), /Paid with credits/);
  assert.match(page.html(), /Choose a provider\. Chickpea credits pay for its models\./);
  assert.match(page.html(), /Choose the provider whose models Chickpea should use\./);
  assert.doesNotMatch(page.html(), /finish the setup it needs|shows the setup it needs/);
  assert.doesNotMatch(page.html(), /onboarding-provider-key|Paste your key|Workers AI/);

  await page.click({ 'data-action': 'onboarding-provider-select', 'data-provider': 'anthropic' });
  assert.match(page.html(), /Anthropic is ready to use with Chickpea credits\./);
  await page.click({ 'data-action': 'onboarding-provider-continue' });
  assert.equal(page.requests.some((request) => request.path.startsWith('/admin/api/providers/')), false, 'no key is saved or validated');
  assert.ok(page.requests.some((request) => request.path === '/admin/api/onboarding/provider' &&
    (request.body as { providerId: string }).providerId === 'anthropic'));
  assert.match(page.html(), /Choose your model/);
});

test('choosing your own key in hosted onboarding keeps the key step', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, billing: { funding: 'own_key', manage: true } });
  await page.click({ 'data-action': 'onboarding-funding', 'data-funding': 'own_key' });
  assert.ok(page.requests.some((request) => request.method === 'POST' && request.path === '/admin/api/onboarding/funding' &&
    (request.body as { funding: string }).funding === 'own_key'));
  await page.click({ 'data-action': 'onboarding-provider-select', 'data-provider': 'anthropic' });
  assert.match(page.html(), /Needs API key/);
  assert.match(page.html(), /id="onboarding-provider-key"/);
  assert.doesNotMatch(page.html(), /Paid with credits/);
});

test('a reload continues from the saved choice: credits to keyless providers, your own key to the key step', async () => {
  const credits = await harness({ path: '/admin/onboarding', billingOffered: true, billing: OWNER_VIEW, savedFunding: 'platform' });
  assert.match(credits.html(), /Paid with credits/);
  assert.doesNotMatch(credits.html(), /Choose how to pay for models/);
  assert.match(credits.html(), /data-action="onboarding-funding-change"[^>]*>Change how you pay<\/button>/);
  await credits.click({ 'data-action': 'onboarding-funding-change' });
  assert.match(credits.html(), /Choose how to pay for models/);

  const ownKey = await harness({ path: '/admin/onboarding', billingOffered: true, billing: { funding: 'own_key', manage: true }, savedFunding: 'own_key' });
  assert.doesNotMatch(ownKey.html(), /Choose how to pay for models|Paid with credits/);
  await ownKey.click({ 'data-action': 'onboarding-provider-select', 'data-provider': 'openai' });
  assert.match(ownKey.html(), /id="onboarding-provider-key"/);
  assert.equal(ownKey.requests.some((request) => request.path === '/admin/api/onboarding/funding'), false);
});
