import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { Hono } from 'hono';

import { createBillingAdminApi } from '../src/admin/billing-api.ts';
import { setRequestPrincipal } from '../src/auth/service.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformBilling,
  type BillingFunding,
  type BillingSummary,
  type PlatformBillingPort,
  type UsageMicros,
} from '../src/config/platform-billing.ts';
import type { ProviderKeyId } from '../src/config/provider-keys.ts';
import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';
import { NO_PLAN, STARTER_PLAN, TEAM_PLAN, usd } from './helpers/billing-summaries.ts';

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type Listener = (event: { target: ReturnType<typeof actionTarget>; preventDefault?(): void }) => void;

interface OwnKeyFacts {
  savedKeys: ReadonlySet<ProviderKeyId>;
  defaultModel: string | undefined;
  agents: { name: string; model?: string }[];
}

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

const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>, { installationId: 'inst_page' });

/** The default model's Anthropic key is saved and no Agent pins another provider. */
const KEYED: OwnKeyFacts = { savedKeys: new Set(['anthropic']), defaultModel: 'anthropic/claude-sonnet-5-5', agents: [] };

const FROZEN: BillingSummary = {
  ...NO_PLAN,
  extraUsage: { remainingMicros: usd(40), frozen: true, expiresAt: new Date('2027-10-07T17:00:00Z') },
};
const TRIAL: BillingSummary = { ...NO_PLAN, trial: { remainingMicros: usd(32.5), expiresAt: new Date('2026-11-06T17:00:00Z') } };
const OWN_KEY_GRACE: BillingSummary = { ...NO_PLAN, funding: 'own_key', ownKeyGraceUntil: new Date('2030-12-01T17:00:00Z') };
const OWN_KEY_GRACE_PAST: BillingSummary = { ...OWN_KEY_GRACE, ownKeyGraceUntil: new Date('2025-06-01T17:00:00Z') };
const OWN_KEY_TEAM: BillingSummary = { ...TEAM_PLAN, funding: 'own_key' };
const UNREADABLE: BillingSummary = { ...TEAM_PLAN, offers: { ...TEAM_PLAN.offers, ownKeyMinimumPlanKey: 'retired_pro' } };

const CHOOSE_PROVIDER = {
  stage: 'choose_provider', revision: 'revision_1', agentId: null, redirectTo: null,
  workspace: { id: 'TACME', name: 'Acme' }, channel: null, providerId: null, modelId: null, models: [],
  slackAppId: 'AACME', tryStartedAt: null, completedAt: null,
};

function fakePort(initial: BillingSummary, fails: { switch?: boolean; stripe?: boolean }) {
  const calls: unknown[][] = [];
  let summary = initial;
  const port: PlatformBillingPort = {
    async summary() { return summary; },
    async checkout(_installationId, request) {
      calls.push(['checkout', request]);
      if (fails.stripe) throw new Error('Stripe is down.');
      return { url: `https://checkout.stripe.com/c/pay/${request.key}` };
    },
    async portal() {
      calls.push(['portal']);
      return { url: 'https://billing.stripe.com/p/session/portal' };
    },
    async chooseFunding(_installationId, funding) {
      calls.push(['chooseFunding', funding]);
      if (fails.switch) throw new Error('The host is down.');
      summary = { ...summary, funding };
    },
  };
  return { port, calls };
}

/**
 * Admin's script in a fake DOM. Billing requests go to the real billing Admin
 * API over a fake port that answers `summary`; with no `summary`, no port is
 * installed, as where the host offers none.
 */
async function harness(options: {
  path: string;
  billingOffered: boolean;
  summary?: BillingSummary;
  owner?: boolean;
  ownKey?: OwnKeyFacts;
  /** The funding choice the onboarding journey already holds, as after a reload. */
  savedFunding?: BillingFunding;
  switchFails?: boolean;
  stripeFails?: boolean;
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
  const owner = options.owner ?? true;
  const principal: AuthPrincipal = {
    userId: owner ? 'user_owner' : 'user_member', membershipId: owner ? 'membership_owner' : 'membership_member',
    organizationId: 'org_page', role: owner ? 'owner' : 'member', authenticatorKind: 'test_slack_session',
    credentialId: 'credential_page', correlationId: 'request_page', machine: false,
  };
  const billing = options.summary
    ? fakePort(options.summary, { ...(options.switchFails ? { switch: true } : {}), ...(options.stripeFails ? { stripe: true } : {}) })
    : undefined;
  const billingApi = new Hono();
  billingApi.use('*', async (c, next) => {
    setRequestPrincipal(c.req.raw, principal);
    await next();
  });
  billingApi.route('/admin/api', createBillingAdminApi({
    agentNames: async () => new Map([['agent_chickpea', 'Chickpea'], ['agent_research', 'Research']]),
    personNames: async () => new Map([['membership_maya', 'Maya Chen']]),
    ownKeyFacts: async () => options.ownKey ?? KEYED,
  }));
  const fetch = async (path: string, init?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path.startsWith('/admin/api/billing')) {
      configurePlatformBilling(billing?.port);
      return billingApi.request(path, {
        method, headers: { 'content-type': 'application/json' }, ...(init?.body ? { body: init.body } : {}),
      }, ENV);
    }
    if (path === '/admin/api/agents') return response({ agents: [] });
    if (path === '/admin/api/assignments') return response({ assignments: [] });
    if (path === '/admin/api/models') {
      return response({ providers: ['anthropic', 'openai', 'openrouter'].map((id) => ({ id, configured: false, suggestions: [] })) });
    }
    if (path === '/admin/api/slack-connection') return response({ connected: true, teamId: 'TACME', teamName: 'Acme' });
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
    workspaceAdminUi: owner,
    installationOwner: owner,
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
  return { html: () => html, requests, assigned, location, click, portCalls: billing?.calls ?? [] };
}

/** The page's HTML with its entities decoded, so copy can be matched as a person reads it. */
function decoded(html: string): string {
  return html.replace(/&rsquo;/g, '’').replace(/&hellip;/g, '…').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
}

function assertShows(html: string, copy: string): void {
  assert.ok(decoded(html).includes(copy), `the page shows "${copy}"`);
}

function assertHides(html: string, copy: string): void {
  assert.ok(!decoded(html).includes(copy), `the page does not show "${copy}"`);
}

const fundingWrites = (requests: Array<{ path: string }>) => requests.filter((request) => request.path === '/admin/api/billing/funding');
const billingWrites = (requests: Array<{ path: string; method: string; body: unknown }>) =>
  requests.filter((request) => request.path.startsWith('/admin/api/billing/')).map((request) => [request.method, request.path, request.body]);

/** The meter sentence's two dollar figures and its percentage. */
function meterFigures(html: string): { used: number; included: number; percent: number } {
  const match = /(\$[\d,]+(?:\.\d\d)?) of (\$[\d,]+(?:\.\d\d)?) used, (\d+)%/.exec(decoded(html));
  assert.ok(match, 'the page shows the meter sentence');
  const dollars = (figure: string) => Number(figure.replace(/[$,]/g, ''));
  return { used: dollars(match[1]!), included: dollars(match[2]!), percent: Number(match[3]) };
}

test('an Owner on the Team plan sees the meter in dollars, what carried over, extra usage, the plan, its offers, and use in dollars', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan');
  assert.match(html, /<h1 class="page-title">Plan<\/h1>/);
  assert.match(html, /data-action="open-billing"[^>]*>Plan<\/button>/, 'the section switcher names the page');
  assert.match(html, /<span class="chan-name">Overview<\/span><span class="chan-meta">Usage<\/span>/);
  assertShows(html, 'Your plan includes usage for your Agents’ chat and tasks.');
  assert.match(html, /<span class="usage-card-label">Plan usage<\/span>/);
  assertShows(html, '$128 of $240 used, 53%, resets Nov 7, on pace for 80%');
  assert.match(html, /role="meter"[^>]*aria-valuemin="0" aria-valuemax="100" aria-valuenow="53"><span style="width: 53%">/);
  assert.match(html, /<ul class="billing-lines"><li>Carried from last month: \$20<\/li><li>Extra usage: \$40<\/li><\/ul>/);
  assert.match(html, /<h2 class="section-title">Plan<\/h2><p><strong>Team<\/strong><\/p><p class="hint">\$200 a month includes \$240 of usage\. Renews Nov 7\.<\/p>/);
  assert.match(html, /data-action="billing-change-plan">Change plan<\/button>/);
  assert.match(html, /data-action="billing-manage">Manage billing<\/button>/);
  assert.match(html, /<h2 class="section-title">Extra usage<\/h2>/);
  for (const dollars of [25, 50, 100]) {
    assert.match(html, new RegExp(`data-action="billing-add-extra-usage" data-key="extra_usage_${dollars}">Add \\$${dollars}</button>`));
  }
  assertShows(html, 'Extra usage is sold at face value and keeps for 12 months. You need a plan to use it.');
  assert.match(html, /<h2 class="section-title">Usage this period<\/h2><p class="hint">Since Oct 7\.<\/p>/);
  assert.match(html, /<th>Agent<\/th><th class="number">Used<\/th>[\s\S]*<td>Chickpea<\/td><td class="number">\$30\.25<\/td><\/tr><tr><td>Other<\/td><td class="number">\$7<\/td>/);
  assert.match(html, /<th>Person<\/th><th class="number">Used<\/th>[\s\S]*<td>Maya Chen<\/td><td class="number">\$31\.50<\/td><\/tr><tr><td>Other<\/td><td class="number">\$6<\/td>/);
  assert.deepEqual(billingWrites(page.requests), []);

  await page.click({ 'data-action': 'billing-change-plan' });
  const chooser = page.html();
  assert.match(chooser, /id="billing-plans-heading">Choose a plan<\/h3>/);
  const rows = [...chooser.matchAll(/<div class="billing-plan"><div><strong>([^<]+)<\/strong><p class="hint">([^<]+)<\/p>(<p class="hint">[^<]+<\/p>)?<\/div>(.*?)<\/div>/g)]
    .map((row) => [row[1], row[2], row[3] ?? '', /Current plan/.test(row[4]!) ? 'current' : /data-action="billing-choose-plan"/.test(row[4]!) ? 'choose' : row[4]]);
  assert.deepEqual(rows, [
    ['Solo', '$25 a month includes $30 of usage', '', 'choose'],
    ['Starter', '$50 a month includes $60 of usage', '', 'choose'],
    ['Plus', '$100 a month includes $120 of usage', '<p class="hint">Lowest plan for your own API key</p>', 'choose'],
    ['Team', '$200 a month includes $240 of usage', '', 'current'],
    ['Growth', '$300 a month includes $360 of usage', '', 'choose'],
    ['Business', '$500 a month includes $600 of usage', '', 'choose'],
  ]);
});

test('each Stripe button asks the host for a Stripe page and opens the URL it returns', async () => {
  const extra = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  await extra.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_50' });
  assert.deepEqual(extra.assigned, ['https://checkout.stripe.com/c/pay/extra_usage_50']);
  assert.match(extra.html(), /data-key="extra_usage_50" disabled>Opening Stripe&hellip;<\/button>/, 'the busy button stays until the browser leaves');
  assert.match(extra.html(), /data-key="extra_usage_25" disabled>Add \$25<\/button>/, 'only the button pressed is opening');

  const plans = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  await plans.click({ 'data-action': 'billing-change-plan' });
  await plans.click({ 'data-action': 'billing-choose-plan', 'data-key': 'business' });
  assert.deepEqual(plans.assigned, ['https://checkout.stripe.com/c/pay/business']);

  const portal = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  await portal.click({ 'data-action': 'billing-manage' });
  assert.deepEqual(portal.assigned, ['https://billing.stripe.com/p/session/portal']);

  assert.deepEqual([...extra.portCalls, ...plans.portCalls, ...portal.portCalls], [
    ['checkout', { kind: 'extra_usage', key: 'extra_usage_50' }],
    ['checkout', { kind: 'plan', key: 'business' }],
    ['portal'],
  ]);
});

test('a Stripe page that cannot be opened says so beside the button that asked for it', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, stripeFails: true });
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' });
  const html = page.html();
  const error = html.indexOf('Stripe could not be opened. Try again.');
  assert.ok(error > html.indexOf('data-key="extra_usage_100"'), 'the error follows the extra usage buttons');
  assert.ok(error < html.indexOf('Usage this period'), 'and stays in their section');
  assert.match(html, /data-key="extra_usage_25">Add \$25<\/button>/, 'the button can be pressed again');
  assert.deepEqual(page.assigned, []);
});

test('frozen extra usage shows until when it keeps, and no plan means nothing to add it to', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: FROZEN });
  const html = page.html();
  assert.match(html, /<li>\$40 of extra usage, available when you renew, until Oct 7, 2027<\/li>/);
  assertHides(html, 'Extra usage: $40');
  assert.match(html, /<span class="usage-card-label">Plan<\/span><span class="usage-card-value">No plan<\/span><span class="hint">Choose a plan for monthly usage\.<\/span>/);
  assertShows(html, 'Choose a plan to add extra usage.');
  assert.doesNotMatch(html, /billing-add-extra-usage/);
  assert.match(html, /<h2 class="section-title">Plan<\/h2><p class="hint">No plan<\/p>/);
  assert.match(html, /data-action="billing-change-plan">Choose a plan<\/button>/);
  assert.doesNotMatch(html, /billing-manage/);
});

test('a trial shows what is left and until when, as the card without a plan and as a line beside one', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TRIAL });
  const html = page.html();
  assert.match(html, /<span class="usage-card-label">Trial<\/span><span class="billing-meter-text">\$32\.50 of trial usage left, until Nov 6<\/span>/);
  assert.doesNotMatch(html, /role="meter"|Plan usage/);

  const both = await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, trial: TRIAL.trial } });
  assert.match(both.html(), /<li>Extra usage: \$40<\/li><li>\$32\.50 of trial usage left, until Nov 6<\/li><\/ul>/);
  assert.match(both.html(), /<span class="usage-card-label">Plan usage<\/span>/);
});

test('an own key in its grace says until when, which plans an own key can choose, and offers Chickpea\'s models', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_GRACE });
  const html = page.html();
  assert.match(html, /<div class="usage-contract"><p>Your workspace uses its own API key with no Chickpea charges until Dec 1, 2030\. After that, your Agents need a plan to keep replying\. Plans for your own key start at \$100 a month\.<\/p><\/div>/);
  assert.match(html, /<p class="hint">Your workspace pays for models with its own API key\.<\/p>/, 'no plan, so no plan covers tasks');
  assert.match(html, /<span class="chan-meta">Own API key<\/span>/);
  assert.doesNotMatch(html, /usage-card-primary/, 'no meter, trial or plan card on an own key without them');
  assert.match(html, /<h2 class="section-title">Plan<\/h2><p class="hint">No plan<\/p>/);
  assert.doesNotMatch(html, /<h2 class="section-title">Extra usage<\/h2>/);
  assertShows(html, 'With Chickpea’s models, no API key is needed. Replies draw on your plan’s usage.');
  assert.match(html, /data-action="billing-use-platform">Use Chickpea&rsquo;s models<\/button>/);

  await page.click({ 'data-action': 'billing-change-plan' });
  const rows = Object.fromEntries([...page.html().matchAll(/<div class="billing-plan"><div><strong>([^<]+)<\/strong>.*?<\/div>(.*?)<\/div>/g)]
    .map((row) => [row[1], /data-action="billing-choose-plan"/.test(row[2]!) ? 'choose' : decoded(row[2]!)]));
  assert.deepEqual(rows, {
    Solo: '<span class="hint">Chickpea’s models only</span>',
    Starter: '<span class="hint">Chickpea’s models only</span>',
    Plus: 'choose', Team: 'choose', Growth: 'choose', Business: 'choose',
  });

  const past = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_GRACE_PAST });
  assert.match(past.html(), /<div class="usage-contract"><p>Your Agents need a plan to keep replying\. Plans for your own key start at \$100 a month\.<\/p><\/div>/);
  assertHides(past.html(), 'no Chickpea charges');
});

test('below the lowest plan for an own key, the switch asks for that plan first and opens its Checkout, never the switch', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_PLAN, ownKey: KEYED });
  assert.match(page.html(), /data-action="billing-use-own-key">Use your own key instead<\/button>/);
  await page.click({ 'data-action': 'billing-use-own-key' });
  assert.match(page.html(), /<div class="callout"><span>Your own API key needs the \$100 plan or higher\. Choose it first, then switch to your own key\.<\/span><\/div>/);
  assert.match(page.html(), /data-action="billing-funding-cancel">Cancel<\/button><button type="button" class="btn btn-primary" data-action="billing-choose-minimum-plan" data-key="plus">Choose the \$100 plan<\/button>/);
  assertHides(page.html(), 'Switch to your own key?');
  await page.click({ 'data-action': 'billing-funding-cancel' });
  assertHides(page.html(), 'needs the $100 plan');

  await page.click({ 'data-action': 'billing-use-own-key' });
  await page.click({ 'data-action': 'billing-choose-minimum-plan', 'data-key': 'plus' });
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/checkout', { kind: 'plan', key: 'plus' }]]);
  assert.deepEqual(page.portCalls, [['checkout', { kind: 'plan', key: 'plus' }]]);
  assert.deepEqual(page.assigned, ['https://checkout.stripe.com/c/pay/plus']);
  assert.match(page.html(), /data-key="plus" disabled>Opening Stripe&hellip;<\/button>/);
  assert.deepEqual(fundingWrites(page.requests), [], 'nothing asks to switch funding');
});

test('with no plan, the page offers a plan and nothing else to buy', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: NO_PLAN });
  const html = page.html();
  assert.match(html, /<span class="usage-card-value">No plan<\/span><span class="hint">Choose a plan for monthly usage\.<\/span>/);
  assert.match(html, /data-action="billing-change-plan">Choose a plan<\/button>/);
  assert.doesNotMatch(html, /billing-add-extra-usage|billing-manage|billing-lines/);
  assertShows(html, 'Choose a plan to add extra usage.');
  assert.match(html, /<h2 class="section-title">Usage<\/h2><\/div>/, 'no period, so no "since"');
  assert.match(html, /<td colspan="2">No usage yet\.<\/td>/);
  assert.match(html, /data-action="billing-use-own-key">Use your own key instead<\/button>/);
});

test('a Member sees the plan\'s usage and that an Owner changes it, with no buttons, plan, or use', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: TEAM_PLAN });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan', 'a Member may open the page');
  assertShows(html, '$128 of $240 used, 53%, resets Nov 7, on pace for 80%');
  assert.match(html, /<li>Carried from last month: \$20<\/li><li>Extra usage: \$40<\/li>/);
  assert.match(html, /<div class="usage-contract"><p>An Owner can change the plan and how your workspace pays for models\.<\/p><\/div>/);
  assert.match(html, /data-action="open-billing"[^>]*>Plan<\/button>/);
  assert.doesNotMatch(html, /data-action="billing-/);
  assert.doesNotMatch(html, /<h2 class="section-title">(Plan|Extra usage|Usage this period)<\/h2>|<th>Agent<\/th>|<th>Person<\/th>/);
  assertHides(html, 'Use your own key instead');

  const ownKey = await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: OWN_KEY_GRACE });
  assertShows(ownKey.html(), 'Your workspace uses its own API key with no Chickpea charges until Dec 1, 2030.');
  assertShows(ownKey.html(), 'An Owner can change the plan and how your workspace pays for models.');
  assert.doesNotMatch(ownKey.html(), /data-action="billing-/);
});

test('the meter\'s dollar figures give its percentage', async () => {
  const nonRound: BillingSummary = {
    ...TEAM_PLAN,
    planUsage: { usedMicros: 37_456_789 as UsageMicros, includedMicros: 60_000_000 as UsageMicros, onPacePercent: null },
  };
  for (const summary of [TEAM_PLAN, nonRound]) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, summary })).html();
    const { used, included, percent } = meterFigures(html);
    assert.equal(Math.floor((used / included) * 100), percent, `${used} of ${included}`);
  }
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: nonRound })).html();
  assertShows(html, '$37.46 of $60 used, 62%, resets Nov 7</span>');
  assertHides(html, 'on pace');
});

test('a plan the host cannot read says so, with a retry', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: UNREADABLE });
  assert.match(page.html(), /<p class="field-error">Your plan could not be loaded\.<\/p><button type="button" class="btn btn-ghost" data-action="billing-retry">Retry<\/button>/);
});

test('an Owner on the plan with a saved key switches to it only after confirming, and the plan keeps covering tasks', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, ownKey: KEYED });
  assert.match(page.html(), /data-action="billing-use-own-key">Use your own key instead<\/button>/);
  await page.click({ 'data-action': 'billing-use-own-key' });
  assert.match(page.html(), /<div class="callout"><span>Switch to your own key\? Your provider bills you for the model directly, and your plan covers tasks\.<\/span><\/div>/);
  assert.doesNotMatch(page.html(), /will stop replying/, 'no Agent is named when every pinned model has a key');
  await page.click({ 'data-action': 'billing-funding-cancel' });
  assertHides(page.html(), 'Switch to your own key?');
  assert.deepEqual(fundingWrites(page.requests), [], 'nothing switches before the Owner confirms');

  await page.click({ 'data-action': 'billing-use-own-key' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/funding', { funding: 'own_key' }]]);
  assert.deepEqual(page.portCalls, [['chooseFunding', 'own_key']]);
  assert.match(page.html(), /<p class="hint">Your workspace pays for models with its own API key\. Your plan covers tasks\.<\/p>/, 'the page turns into the own-key view');
  assertShows(page.html(), '$128 of $240 used, 53%');
  assert.match(page.html(), /<h2 class="section-title">Extra usage<\/h2>/, 'extra usage stays on sale with a plan');
  assert.match(page.html(), /data-action="billing-use-platform">Use Chickpea&rsquo;s models<\/button>/);
  assertHides(page.html(), 'Switch to Chickpea’s models?');
});

test('the confirmation names each Agent whose pinned model has no saved key', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { ...KEYED, agents: [{ name: 'Research', model: 'openai/gpt-5.6-terra' }, { name: 'Ops <Desk>', model: 'openrouter/openai/gpt-5.6-terra' }, { name: 'Writer' }] },
  });
  assert.doesNotMatch(page.html(), /will stop replying/, 'only the confirmation warns');
  await page.click({ 'data-action': 'billing-use-own-key' });
  assert.match(page.html(), /and your plan covers tasks\. These Agents will stop replying until a key is added for their model&rsquo;s provider: Research, Ops &lt;Desk&gt;\.<\/span>/);
});

test('a switch to your own key the host refuses shows its error beside the open confirmation', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, switchFails: true });
  await page.click({ 'data-action': 'billing-use-own-key' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  const html = page.html();
  const confirm = html.indexOf('data-action="billing-funding-confirm">Switch to your own key</button>');
  const error = html.indexOf('Could not switch to your own key. Try again.');
  assert.ok(confirm >= 0, 'the confirmation stays open and can be retried');
  assert.ok(error > confirm, 'the error follows the confirmation, not the Stripe buttons');
});

test('an Owner on the plan whose default model has no key is told which key to add', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { savedKeys: new Set(['openrouter']), defaultModel: 'anthropic/claude-sonnet-5-5', agents: [] },
  });
  assert.match(page.html(), /data-action="open-settings" data-section="providers">Use your own key instead<\/button><\/div><p class="hint">Your default model needs an Anthropic API key\. Add one in Settings first\.<\/p>/);
  assert.doesNotMatch(page.html(), /billing-use-own-key/);
});

test('an Owner on the plan with no saved key is sent to Model providers to add one first', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { savedKeys: new Set(), defaultModel: undefined, agents: [] },
  });
  assert.match(page.html(), /data-action="open-settings" data-section="providers">Use your own key instead<\/button><\/div><p class="hint">Add a provider API key in Settings first\.<\/p>/);
  assert.doesNotMatch(page.html(), /billing-use-own-key/);
  await page.click({ 'data-action': 'open-settings', 'data-section': 'providers' });
  assert.equal(page.location.pathname, '/admin/settings/providers');
  assert.deepEqual(billingWrites(page.requests), []);
});

test('an Owner on their own key finds the page and switches to Chickpea\'s models only after confirming', async () => {
  const home = await harness({ path: '/admin/agents', billingOffered: true, summary: OWN_KEY_TEAM });
  assert.match(home.html(), /data-action="open-billing"[^>]*>Plan<\/button>/, 'the nav entry is there on your own key');
  assert.equal(home.requests.some((request) => request.path.startsWith('/admin/api/billing')), false, 'no billing read until the page opens');
  await home.click({ 'data-action': 'open-billing' });
  assert.equal(home.location.pathname, '/admin/plan');

  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM });
  assert.match(page.html(), /<h1 class="page-title">Plan<\/h1>/);
  assert.match(page.html(), /data-action="billing-use-platform">Use Chickpea&rsquo;s models<\/button>/);
  await page.click({ 'data-action': 'billing-use-platform' });
  assert.match(page.html(), /<div class="callout"><span>Switch to Chickpea&rsquo;s models\? Replies will stop using your own key\.<\/span><\/div>/);
  await page.click({ 'data-action': 'billing-funding-cancel' });
  assertHides(page.html(), 'Switch to Chickpea’s models?');
  assert.deepEqual(fundingWrites(page.requests), [], 'nothing switches before the Owner confirms');

  await page.click({ 'data-action': 'billing-use-platform' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/funding', { funding: 'platform' }]]);
  assertShows(page.html(), 'Your plan includes usage for your Agents’ chat and tasks.');
  assert.match(page.html(), /data-action="billing-use-own-key">Use your own key instead<\/button>/, 'the page turns into the platform view');
});

test('a switch to Chickpea\'s models the host refuses keeps the confirmation open with a retryable error', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, switchFails: true });
  await page.click({ 'data-action': 'billing-use-platform' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assertShows(page.html(), 'Could not switch to Chickpea’s models. Try again.');
  assert.match(page.html(), /data-action="billing-funding-confirm">Switch to Chickpea&rsquo;s models<\/button>/);
});

test('no Plan page or onboarding state uses words the customer never sees', async () => {
  const states: Array<[string, Parameters<typeof harness>[0], Array<Record<string, string>>]> = [
    ['plan', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN }, [{ 'data-action': 'billing-change-plan' }, { 'data-action': 'billing-use-own-key' }]],
    ['frozen', { path: '/admin/plan', billingOffered: true, summary: FROZEN }, [{ 'data-action': 'billing-change-plan' }]],
    ['trial', { path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, trial: TRIAL.trial } }, []],
    ['trial without a plan', { path: '/admin/plan', billingOffered: true, summary: TRIAL }, []],
    ['grace', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_GRACE }, [{ 'data-action': 'billing-change-plan' }, { 'data-action': 'billing-use-platform' }]],
    ['grace ended', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_GRACE_PAST }, []],
    ['below the minimum', { path: '/admin/plan', billingOffered: true, summary: STARTER_PLAN }, [{ 'data-action': 'billing-use-own-key' }]],
    ['no plan', { path: '/admin/plan', billingOffered: true, summary: NO_PLAN }, []],
    ['member', { path: '/admin/plan', billingOffered: true, owner: false, summary: TEAM_PLAN }, []],
    ['own key on a plan', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM }, [{ 'data-action': 'billing-use-platform' }]],
    ['unreadable', { path: '/admin/plan', billingOffered: true, summary: UNREADABLE }, []],
  ];
  for (const [label, options, clicks] of states) {
    const page = await harness(options);
    assert.doesNotMatch(page.html(), /credit|markup|refund|multiplier/i, label);
    for (const target of clicks) {
      await page.click(target);
      assert.doesNotMatch(page.html(), /credit|markup|refund|multiplier/i, `${label} after ${target['data-action']}`);
    }
  }
  const onboarding = await harness({ path: '/admin/onboarding', billingOffered: true, summary: OWN_KEY_GRACE });
  const steps: Array<[string, Record<string, string> | null]> = [
    ['the funding choice', null],
    ['the provider step on Chickpea\'s models', { 'data-action': 'onboarding-funding', 'data-funding': 'platform' }],
    ['a provider chosen', { 'data-action': 'onboarding-provider-select', 'data-provider': 'anthropic' }],
    ['the funding choice again', { 'data-action': 'onboarding-funding-change' }],
    ['the provider step on your own key', { 'data-action': 'onboarding-funding', 'data-funding': 'own_key' }],
  ];
  for (const [label, target] of steps) {
    if (target) await onboarding.click(target);
    assert.doesNotMatch(onboarding.html(), /credit|markup|refund|multiplier/i, `onboarding: ${label}`);
  }
  assert.match(onboarding.html(), /Choose your model provider/, 'the walk reached the own-key provider step');
});

test('standalone shows nothing new: no billing request, no page, and onboarding goes straight to providers', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: false, summary: TEAM_PLAN });
  assert.equal(page.requests.some((request) => request.path.startsWith('/admin/api/billing')), false);
  assert.doesNotMatch(page.html(), /open-billing|<h1 class="page-title">Plan<\/h1>/);
  assert.notEqual(page.location.pathname, '/admin/plan');

  const onboarding = await harness({ path: '/admin/onboarding', billingOffered: false });
  assert.match(onboarding.html(), /Choose your model provider/);
  assert.doesNotMatch(onboarding.html(), /Chickpea&rsquo;s models|onboarding-funding|Change how you pay/);
});

test('hosted onboarding offers Chickpea\'s models first; choosing them skips the key', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: OWN_KEY_GRACE });
  const offer = page.html();
  assert.match(offer, /Choose how to pay for models/);
  const platform = offer.indexOf('data-funding="platform"');
  const ownKey = offer.indexOf('data-funding="own_key"');
  assert.ok(platform >= 0 && ownKey > platform, 'Chickpea\'s models come first, your own key second');
  assertShows(offer, 'Use Chickpea’s models, or connect a model provider with your own API key.');
  assertShows(offer, '<strong>Use Chickpea’s models</strong><span>No API key needed. Replies draw on your workspace’s usage.</span>');
  assertShows(offer, '<strong>Use your own key</strong><span>Connect an Anthropic, OpenAI, or OpenRouter API key. The provider bills you directly.</span>');

  await page.click({ 'data-action': 'onboarding-funding', 'data-funding': 'platform' });
  assert.ok(page.requests.some((request) => request.method === 'POST' && request.path === '/admin/api/onboarding/funding' &&
    JSON.stringify(request.body) === JSON.stringify({ expectedRevision: 'revision_1', funding: 'platform' })));
  assert.match(page.html(), /<span class="onboarding-provider-tab-status">No key needed<\/span>/);
  assert.match(page.html(), /<p class="onboarding-lede">Choose a provider\. No API key is needed\.<\/p>/);
  assert.match(page.html(), /Choose the provider whose models Chickpea should use\./);
  assert.doesNotMatch(page.html(), /finish the setup it needs|shows the setup it needs/);
  assert.doesNotMatch(page.html(), /onboarding-provider-key|Paste your key|Workers AI/);

  await page.click({ 'data-action': 'onboarding-provider-select', 'data-provider': 'anthropic' });
  assert.match(page.html(), /<h2>Use Anthropic<\/h2><p class="onboarding-provider-ready">Anthropic is ready to use\.<\/p>/);
  await page.click({ 'data-action': 'onboarding-provider-continue' });
  assert.equal(page.requests.some((request) => request.path.startsWith('/admin/api/providers/')), false, 'no key is saved or validated');
  assert.ok(page.requests.some((request) => request.path === '/admin/api/onboarding/provider' &&
    (request.body as { providerId: string }).providerId === 'anthropic'));
  assert.match(page.html(), /Choose your model/);
});

test('choosing your own key in hosted onboarding keeps the key step', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: OWN_KEY_GRACE });
  await page.click({ 'data-action': 'onboarding-funding', 'data-funding': 'own_key' });
  assert.ok(page.requests.some((request) => request.method === 'POST' && request.path === '/admin/api/onboarding/funding' &&
    (request.body as { funding: string }).funding === 'own_key'));
  await page.click({ 'data-action': 'onboarding-provider-select', 'data-provider': 'anthropic' });
  assert.match(page.html(), /Needs API key/);
  assert.match(page.html(), /id="onboarding-provider-key"/);
  assert.doesNotMatch(page.html(), /onboarding-provider-tab-status">No key needed/);
});

test('a reload continues from the saved choice: Chickpea\'s models to keyless providers, your own key to the key step', async () => {
  const platform = await harness({ path: '/admin/onboarding', billingOffered: true, summary: TEAM_PLAN, savedFunding: 'platform' });
  assert.match(platform.html(), /onboarding-provider-tab-status">No key needed/);
  assert.doesNotMatch(platform.html(), /Choose how to pay for models/);
  assert.match(platform.html(), /data-action="onboarding-funding-change"[^>]*>Change how you pay<\/button>/);
  await platform.click({ 'data-action': 'onboarding-funding-change' });
  assert.match(platform.html(), /Choose how to pay for models/);

  const ownKey = await harness({ path: '/admin/onboarding', billingOffered: true, summary: OWN_KEY_GRACE, savedFunding: 'own_key' });
  assert.doesNotMatch(ownKey.html(), /Choose how to pay for models|onboarding-provider-tab-status">No key needed/);
  await ownKey.click({ 'data-action': 'onboarding-provider-select', 'data-provider': 'openai' });
  assert.match(ownKey.html(), /id="onboarding-provider-key"/);
  assert.equal(ownKey.requests.some((request) => request.path === '/admin/api/onboarding/funding'), false);
});
