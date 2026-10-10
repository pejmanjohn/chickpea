import './helpers/non-utc-time-zone.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { Hono } from 'hono';

import { createBillingAdminApi } from '../src/admin/billing-api.ts';
import { setRequestPrincipal } from '../src/auth/service.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  BillingRefusal,
  configurePlatformBilling,
  type BillingSummary,
  type PlatformBillingPort,
  type UsageMicros,
} from '../src/config/platform-billing.ts';
import type { ProviderKeyId } from '../src/config/provider-keys.ts';
import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';
import { NO_PLAN, OWN_KEY_NO_PLAN, PLAN_NO_PERIOD, STARTER_PLAN, TEAM_DOWNGRADING, TEAM_ENDING, TEAM_PLAN, usd } from './helpers/billing-summaries.ts';

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

function actionTarget(attributes: Record<string, string>, value?: string) {
  return {
    value,
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
/** The default model is Anthropic's and no key is saved. */
const NEEDS_ANTHROPIC: OwnKeyFacts = { savedKeys: new Set(), defaultModel: 'anthropic/claude-sonnet-5-5', agents: [] };

const FROZEN: BillingSummary = {
  ...NO_PLAN,
  extraUsage: { remainingMicros: usd(40), frozen: true, expiresAt: new Date('2027-10-07T17:00:00Z') },
};
const TRIAL: BillingSummary = { ...NO_PLAN, trial: { remainingMicros: usd(32.5), expiresAt: new Date('2026-11-06T17:00:00Z') } };
const OWN_KEY_TEAM: BillingSummary = { ...TEAM_PLAN, funding: 'own_key' };
const UNREADABLE: BillingSummary = { ...TEAM_PLAN, offers: { ...TEAM_PLAN.offers, ownKeyMinimumPlanKey: 'retired_pro' } };

const CHOOSE_PROVIDER = {
  stage: 'choose_provider', revision: 'revision_1', agentId: null, redirectTo: null,
  workspace: { id: 'TACME', name: 'Acme' }, channel: null, providerId: null, modelId: null, models: [],
  slackAppId: 'AACME', tryStartedAt: null, completedAt: null,
};
const TRY = {
  ...CHOOSE_PROVIDER, stage: 'try', revision: 'revision_try', agentId: 'agent_chickpea',
  providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-5-5', tryStartedAt: 1_800_000_000_000,
};

function fakePort(initial: BillingSummary, fails: { switch?: Error | undefined; stripe?: Error | undefined }) {
  const calls: unknown[][] = [];
  let summary = initial;
  const port: PlatformBillingPort = {
    async summary() { return summary; },
    async checkout(_installationId, request) {
      calls.push(['checkout', request]);
      if (fails.stripe) throw fails.stripe;
      return { url: `https://checkout.stripe.com/c/pay/${request.key}` };
    },
    async portal() {
      calls.push(['portal']);
      return { url: 'https://billing.stripe.com/p/session/portal' };
    },
    async chooseFunding(_installationId, funding) {
      calls.push(['chooseFunding', funding]);
      if (fails.switch) throw fails.switch;
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
  selfHosted?: boolean;
  owner?: boolean;
  /** A workspace admin who is not the Owner, who reaches Settings but not the Owner's billing. */
  admin?: boolean;
  ownKey?: OwnKeyFacts;
  onboarding?: Record<string, unknown>;
  onboardingUnread?: boolean;
  modelsHeld?: boolean;
  /** The page's clock; Date.now() reads it. */
  clock?: { now: number };
  /** Timers of a second or more wait for firePoll() instead of running. */
  manualPolls?: boolean;
  platformFailures?: number;
  platformFailureBody?: unknown;
  platformHeld?: boolean;
  switchFails?: Error;
  stripeFails?: Error;
}) {
  let html = '';
  const renders: string[] = [];
  const timerDelays: number[] = [];
  const pendingPolls: Array<() => void> = [];
  const clock = options.clock;
  const PageDate = clock ? class extends Date { static override now() { return clock.now; } } : Date;
  const app = { className: '', get innerHTML() { return html; }, set innerHTML(value: string) { html = value; renders.push(value); } };
  const listeners: Record<string, Listener> = {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const assigned: string[] = [];
  let onboarding: Record<string, unknown> = options.onboarding ?? CHOOSE_PROVIDER;
  let platformFailures = options.platformFailures ?? 0;
  let releasePlatform = () => {};
  const platformGate = options.platformHeld ? new Promise<void>((resolve) => { releasePlatform = resolve; }) : undefined;
  let releaseModels = () => {};
  const modelsGate = options.modelsHeld ? new Promise<void>((resolve) => { releaseModels = resolve; }) : undefined;
  const start = new URL(options.path, 'https://chickpea.example');
  const location = {
    pathname: start.pathname, search: start.search,
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
  const role = options.admin ? 'admin' : options.owner === false ? 'member' : 'owner';
  const owner = role === 'owner';
  const principal: AuthPrincipal = {
    userId: `user_${role}`, membershipId: `membership_${role}`,
    organizationId: 'org_page', role, authenticatorKind: 'test_slack_session',
    credentialId: 'credential_page', correlationId: 'request_page', machine: false,
  };
  const billing = options.summary ? fakePort(options.summary, { switch: options.switchFails, stripe: options.stripeFails }) : undefined;
  const ownKey = options.ownKey ?? KEYED;
  const savedKeys = new Set(ownKey.savedKeys);
  const billingApi = new Hono();
  billingApi.use('*', async (c, next) => {
    setRequestPrincipal(c.req.raw, principal);
    await next();
  });
  billingApi.route('/admin/api', createBillingAdminApi({
    agentNames: async () => new Map([['agent_chickpea', 'Chickpea'], ['agent_research', 'Research']]),
    personNames: async () => new Map([['membership_maya', 'Maya Chen']]),
    ownKeyFacts: async () => ({ ...ownKey, savedKeys }),
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
      await modelsGate;
      return response({ providers: ['anthropic', 'openai', 'openrouter'].map((id) => ({ id, configured: false, suggestions: [] })) });
    }
    if (path === '/admin/api/slack-connection') return response({ connected: true, teamId: 'TACME', teamName: 'Acme' });
    if (path === '/admin/api/providers') {
      return response({ providers: (['anthropic', 'openai'] as const).map((id) => (
        savedKeys.has(id) ? { id, status: 'stored', modelCount: 2 } : { id, status: 'missing', modelCount: null })) });
    }
    const keySave = /^\/admin\/api\/providers\/(anthropic|openai)\/key$/.exec(path);
    if (keySave && method === 'POST') {
      // Validation takes a turn, so a request sent alongside the save reads the keys from before it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const id = keySave[1] as ProviderKeyId;
      savedKeys.add(id);
      return response({ ok: true, provider: { id, status: 'stored', modelCount: 2 }, models: [] });
    }
    if (path === '/admin/api/onboarding/platform') {
      await platformGate;
      if (platformFailures > 0) {
        platformFailures -= 1;
        return response(options.platformFailureBody ?? { error: 'internal_error' }, 500);
      }
      const github = onboarding.githubConnectPath ? { stage: 'connect_github', githubConnectPath: onboarding.githubConnectPath } : {};
      onboarding = { ...TRY, modelId: 'anthropic/claude-opus-5-5', ...github };
      return response(onboarding);
    }
    if (path === '/admin/api/onboarding') return response(onboarding);
    if (path === '/admin/api/onboarding/github') {
      onboarding = { ...onboarding, stage: 'try', revision: 'revision_github_settled' };
      return response(onboarding);
    }
    if (path === '/admin/api/onboarding/provider') {
      onboarding = { ...onboarding, stage: 'choose_model', providerId: body.providerId, models: ['anthropic/claude-sonnet-5-5'] };
      return response(onboarding);
    }
    return response({ error: 'not_found' }, 404);
  };
  const serverHtml = renderAdminPage({
    usageAdminUi: true,
    workspaceAdminUi: role !== 'member',
    installationOwner: owner,
    browserOffered: !options.billingOffered,
    selfHosted: options.selfHosted ?? !options.billingOffered,
    billingOffered: options.billingOffered,
    onboarding: start.pathname === '/admin/onboarding' ? {
      initial: role === 'member' || options.onboardingUnread === true ? null : onboarding,
      githubConnectPath: options.selfHosted ?? !options.billingOffered ? null : onboarding.githubConnectPath as string ?? null,
      githubReturned: !(options.selfHosted ?? !options.billingOffered) && start.searchParams.get('github') === 'connected',
    } : undefined,
  });
  const script = serverHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    console, Date: PageDate, document, fetch, clearTimeout,
    // Try polls the journey; an unref'd timer lets the file's process exit.
    setTimeout: (callback: () => void, ms?: number) => {
      timerDelays.push(ms ?? 0);
      if (options.manualPolls && (ms ?? 0) >= 1000) return pendingPolls.push(callback);
      return setTimeout(callback, ms).unref();
    },
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
  /** Pastes a key into a provider's field on Model providers and validates it. */
  const saveKey = async (provider: ProviderKeyId) => {
    listeners.input!({ target: actionTarget({ 'data-action': 'prov-key-input', 'data-provider': provider }, 'sk-test') });
    await click({ 'data-action': 'prov-validate', 'data-provider': provider });
  };
  const firePoll = async () => {
    const poll = pendingPolls.shift();
    assert.ok(poll, 'a poll is waiting');
    poll();
    await flush();
  };
  return {
    html: () => html, renders, timerDelays, requests, assigned, location, click, saveKey, firePoll, serverHtml,
    portCalls: billing?.calls ?? [], releasePlatform: () => releasePlatform(), releaseModels: () => releaseModels(),
  };
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

const PLAN_LEDE = 'Your plan includes usage for your Agents’ chat and tasks.';
const NO_PLAN_LEDE = 'Your workspace has no plan. Plans include usage for your Agents’ chat and tasks.';

/** The sentence under the page title. */
function lede(html: string): string {
  return decoded(/<h1 class="page-title">Plan<\/h1><p class="hint">([^<]*)<\/p>/.exec(html)?.[1] ?? '');
}

/** The sentence under the plan's name in the Plan section. */
function planTerms(html: string): string {
  return decoded(/<h2 class="section-title">Plan<\/h2><p><strong>[^<]*<\/strong><\/p><p class="hint">([^<]*)<\/p>/.exec(html)?.[1] ?? '');
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
  assert.equal(lede(html), PLAN_LEDE);
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

test('an Owner on a plan with no recorded period sees the plan by name, with no meter, and can still add extra usage', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: PLAN_NO_PERIOD })).html();
  assert.equal(lede(html), PLAN_LEDE);
  assert.match(html, /<div class="usage-card usage-card-primary"><span class="usage-card-label">Plan<\/span><span class="usage-card-value">Team<\/span><\/div>/);
  assertHides(html, 'No plan');
  assert.doesNotMatch(html, /role="meter"/);
  assertHides(html, 'resets');
  assert.match(html, /<h2 class="section-title">Plan<\/h2><p><strong>Team<\/strong><\/p><p class="hint">\$200 a month includes \$240 of usage\.<\/p>/);
  assertHides(html, 'Renews');
  assert.match(html, /<li>Extra usage: \$40<\/li>/);
  for (const dollars of [25, 50, 100]) {
    assert.match(html, new RegExp(`data-action="billing-add-extra-usage" data-key="extra_usage_${dollars}">Add \\$${dollars}</button>`));
  }

  const ownKey = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, funding: 'own_key' } })).html();
  assert.equal(lede(ownKey), 'Your workspace pays for models with its own API key. Your plan covers tasks.');
});

test('a Member on a plan with no recorded period sees the plan by name, not no plan', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: PLAN_NO_PERIOD })).html();
  assert.equal(lede(html), PLAN_LEDE);
  assert.match(html, /<span class="usage-card-label">Plan<\/span><span class="usage-card-value">Team<\/span>/);
  assertHides(html, 'No plan');
});

test('a plan cancelled in Stripe\'s portal says when it ends, and a downgrade names the plan it changes to, in place of when it renews', async () => {
  const ending = (await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_ENDING })).html();
  assert.equal(planTerms(ending), '$200 a month includes $240 of usage. Ends Nov 7.');
  const downgrading = (await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_DOWNGRADING })).html();
  assert.equal(planTerms(downgrading), '$200 a month includes $240 of usage. Changes to the Chickpea $50 plan on Nov 7.');
});

test('the meter of a plan that ends says the day it ends, not that it resets; a plan that changes still resets', async () => {
  const endsNov8: BillingSummary = { ...TEAM_PLAN, pendingChange: { kind: 'ends', at: new Date('2026-11-08T17:00:00Z') } };
  const ending = (await harness({ path: '/admin/plan', billingOffered: true, summary: endsNov8 })).html();
  assertShows(ending, '$128 of $240 used, 53%, ends Nov 8, on pace for 80%');
  assertHides(ending, 'resets');
  assertShows((await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_DOWNGRADING })).html(), '$128 of $240 used, 53%, resets Nov 7, on pace for 80%');
});

test('a plan that renews unchanged still says when it renews, whether the host leaves out the pending change or sends none', async () => {
  for (const summary of [TEAM_PLAN, { ...TEAM_PLAN, pendingChange: null }]) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, summary })).html();
    assert.equal(planTerms(html), '$200 a month includes $240 of usage. Renews Nov 7.');
  }
});

test('a plan with no recorded period still says when it ends or which plan it changes to', async () => {
  for (const [pendingChange, terms] of [
    [TEAM_ENDING.pendingChange!, 'Ends Nov 7.'],
    [TEAM_DOWNGRADING.pendingChange!, 'Changes to the Chickpea $50 plan on Nov 7.'],
  ] as const) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, pendingChange } })).html();
    assert.equal(planTerms(html), `$200 a month includes $240 of usage. ${terms}`);
  }
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
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, stripeFails: new Error('Stripe is down.') });
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' });
  const html = page.html();
  const error = html.indexOf('Stripe could not be opened. Try again.');
  assert.ok(error > html.indexOf('data-key="extra_usage_100"'), 'the error follows the extra usage buttons');
  assert.ok(error < html.indexOf('Usage this period'), 'and stays in their section');
  assert.match(html, /data-key="extra_usage_25">Add \$25<\/button>/, 'the button can be pressed again');
  assert.deepEqual(page.assigned, []);
});

const PLAN_FIRST = 'Choose a plan first. Extra usage is available while your workspace has a plan. Choose a plan, then add extra usage.';
const billingReads = (requests: Array<{ path: string; method: string }>) =>
  requests.filter((request) => request.method === 'GET' && request.path === '/admin/api/billing').length;

test('extra usage the host refuses for want of a plan says to choose one first, beside the extra usage buttons', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, stripeFails: new BillingRefusal('plan_required') });
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' });
  const html = page.html();
  const error = html.indexOf(`<p class="field-error" role="alert">${PLAN_FIRST}</p>`);
  assert.ok(error > html.indexOf('data-key="extra_usage_100"'), 'the reason follows the extra usage buttons');
  assert.ok(error < html.indexOf('Usage this period'), 'and stays in their section');
  assertHides(html, 'Stripe could not be opened');
  assert.deepEqual(page.assigned, []);
  assert.equal(billingReads(page.requests), 1, 'the plan is not read again');
});

test('a plan choice the host refuses for an own key names the lowest plan for one, beside the plans', async () => {
  for (const [minimum, price] of [['plus', '$100'], ['team', '$200']] as const) {
    const summary: BillingSummary = { ...OWN_KEY_TEAM, offers: { ...OWN_KEY_TEAM.offers, ownKeyMinimumPlanKey: minimum } };
    const page = await harness({ path: '/admin/plan', billingOffered: true, summary, stripeFails: new BillingRefusal('own_key_plan_required') });
    await page.click({ 'data-action': 'billing-change-plan' });
    await page.click({ 'data-action': 'billing-choose-plan', 'data-key': 'plus' });
    const html = page.html();
    const error = html.indexOf(`<p class="field-error" role="alert">Your own API key needs the ${price} plan or higher.</p>`);
    assert.ok(error > html.indexOf('data-action="billing-manage"'), `the ${price} plan is named in the Plan section`);
    assert.ok(error < html.indexOf('id="billing-plans-heading"'), 'above the plans');
    assertHides(html, 'Stripe could not be opened');
    assert.deepEqual(page.portCalls, [['checkout', { kind: 'plan', key: 'plus' }]]);
    assert.equal(billingReads(page.requests), 1, 'the plan is not read again');
  }
});

test('frozen extra usage shows until when it keeps, and no plan means nothing to add it to', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: FROZEN });
  const html = page.html();
  assert.equal(lede(html), NO_PLAN_LEDE);
  assertHides(html, PLAN_LEDE);
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
  assert.equal(lede(html), 'Your trial includes usage for your Agents’ chat and tasks.');
  assertHides(html, PLAN_LEDE);
  assert.match(html, /<span class="usage-card-label">Trial<\/span><span class="billing-meter-text">\$32\.50 of trial usage left, until Nov 6<\/span>/);
  assert.doesNotMatch(html, /role="meter"|Plan usage/);

  const both = await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, trial: TRIAL.trial } });
  assert.match(both.html(), /<li>Extra usage: \$40<\/li><li>\$32\.50 of trial usage left, until Nov 6<\/li><\/ul>/);
  assert.match(both.html(), /<span class="usage-card-label">Plan usage<\/span>/);
  assert.equal(lede(both.html()), PLAN_LEDE, 'a plan\'s meter outranks the trial');

  const noPeriod = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, trial: TRIAL.trial } })).html();
  assert.match(noPeriod, /<span class="usage-card-label">Plan<\/span><span class="usage-card-value">Team<\/span>/);
  assert.match(noPeriod, /<li>Extra usage: \$40<\/li><li>\$32\.50 of trial usage left, until Nov 6<\/li><\/ul>/);
  assert.equal(lede(noPeriod), PLAN_LEDE, 'a plan outranks the trial without a period too');
});

test('on their own key with no plan, an Owner and a Member read only that it needs the $100 plan or higher', async () => {
  for (const owner of [true, false]) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, owner, summary: OWN_KEY_NO_PLAN })).html();
    const role = owner ? 'an Owner' : 'a Member';
    assert.equal(html.split('<div class="callout"><span>Your own API key needs the $100 plan or higher.</span></div>').length, 2, `${role} reads the sentence once`);
    assert.doesNotMatch(html, /charges/i, `${role} reads nothing about charges`);
  }
});

test('an own key with no plan shows which plans an own key can choose, and offers Chickpea\'s models', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_NO_PLAN });
  const html = page.html();
  assert.equal(lede(html), 'Your workspace pays for models with its own API key.', 'no plan, so no plan covers tasks');
  assert.match(html, /<span class="chan-meta">Own API key<\/span>/);
  assert.doesNotMatch(html, /usage-card-primary/, 'no meter, trial or plan card on an own key without them');
  assert.match(html, /<h2 class="section-title">Plan<\/h2><p class="hint">No plan<\/p>/);
  assert.match(html, /data-action="billing-change-plan">Choose a plan<\/button>/);
  assert.doesNotMatch(html, /<h2 class="section-title">Extra usage<\/h2>|billing-add-extra-usage/);
  assert.match(html, /<h2 class="section-title">Usage<\/h2><\/div>[\s\S]*<th>Agent<\/th>/);
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
  assert.equal(lede(html), NO_PLAN_LEDE);
  assertHides(html, PLAN_LEDE);
  assert.match(html, /<span class="usage-card-value">No plan<\/span><span class="hint">Choose a plan for monthly usage\.<\/span>/);
  assert.match(html, /data-action="billing-change-plan">Choose a plan<\/button>/);
  assert.doesNotMatch(html, /billing-add-extra-usage|billing-manage|billing-lines/);
  assertShows(html, 'Choose a plan to add extra usage.');
  assert.match(html, /<h2 class="section-title">Usage<\/h2><\/div>/, 'no period, so no "since"');
  assert.match(html, /<td colspan="2">No usage yet\.<\/td>/);
  assert.match(html, /data-action="billing-use-own-key">Use your own key instead<\/button>/);
});

test('a host that records no person shows the Agent table alone, with no empty Person table beside it', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, use: { ...TEAM_PLAN.use, byPerson: [] } } })).html();
  assert.match(html, /<th>Agent<\/th><th class="number">Used<\/th>[\s\S]*<td>Chickpea<\/td><td class="number">\$30\.25<\/td><\/tr><tr><td>Other<\/td><td class="number">\$7<\/td>/);
  assert.doesNotMatch(html, /<th>Person<\/th>/);
  assertHides(html, 'No usage yet');

  const none = (await harness({ path: '/admin/plan', billingOffered: true, summary: NO_PLAN })).html();
  assert.equal(none.match(/No usage yet\./g)?.length, 1, 'with no use at all, the empty message shows once');
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

  const ownKey = (await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: OWN_KEY_NO_PLAN })).html();
  assert.match(ownKey, /<div class="usage-contract"><p>An Owner can change the plan and how your workspace pays for models\.<\/p><\/div>/);
  assert.doesNotMatch(ownKey, /data-action="billing-|<h2 class="section-title">Plan<\/h2>/);
});

test('the meter\'s dollar figures give its percentage', async () => {
  const nonRound: BillingSummary = {
    ...TEAM_PLAN,
    planUsage: { usedMicros: 37_456_789 as UsageMicros, includedMicros: 60_000_000 as UsageMicros, onPacePercent: null },
  };
  const edge: BillingSummary = {
    ...TEAM_PLAN,
    planUsage: { usedMicros: 239_999_999 as UsageMicros, includedMicros: 240_000_000 as UsageMicros, onPacePercent: null },
  };
  for (const summary of [TEAM_PLAN, nonRound, edge]) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, summary })).html();
    const { used, included, percent } = meterFigures(html);
    assert.equal(Math.floor((used / included) * 100), percent, `${used} of ${included}`);
  }
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: nonRound })).html();
  assertShows(html, '$37.45 of $60 used, 62%, resets Nov 7</span>');
  assertHides(html, 'on pace');
  assertShows((await harness({ path: '/admin/plan', billingOffered: true, summary: edge })).html(), '$239.99 of $240 used, 99%');
});

test('every date reads as its UTC day, whatever timezone the server and browser run in', async () => {
  assert.equal(new Date('2026-11-07T23:30:00Z').getDate(), 8, 'this file runs where a late UTC hour is the next day');
  const edges: BillingSummary = {
    ...TEAM_PLAN,
    period: { start: new Date('2026-10-07T23:30:00Z'), end: new Date('2026-11-07T23:30:00Z') },
    trial: { remainingMicros: usd(32.5), expiresAt: new Date('2026-11-06T23:30:00Z') },
  };
  const plan = (await harness({ path: '/admin/plan', billingOffered: true, summary: edges })).html();
  assertShows(plan, 'resets Nov 7');
  assertShows(plan, 'Renews Nov 7.');
  assertShows(plan, 'Since Oct 7.');
  assertShows(plan, '$32.50 of trial usage left, until Nov 6');
  const frozen = (await harness({
    path: '/admin/plan', billingOffered: true,
    summary: { ...FROZEN, extraUsage: { ...FROZEN.extraUsage!, expiresAt: new Date('2027-10-07T23:30:00Z') } },
  })).html();
  assertShows(frozen, 'available when you renew, until Oct 7, 2027');
  // A day after the period's end, so a page that printed the period's end instead would read Nov 7.
  for (const at of [new Date('2026-11-08T00:30:00Z'), new Date('2026-11-08T23:30:00Z')]) {
    const ending = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, pendingChange: { kind: 'ends', at } } })).html();
    assert.equal(planTerms(ending), '$200 a month includes $240 of usage. Ends Nov 8.');
    const changing = (await harness({
      path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, pendingChange: { ...TEAM_DOWNGRADING.pendingChange!, at } },
    })).html();
    assert.equal(planTerms(changing), '$200 a month includes $240 of usage. Changes to the Chickpea $50 plan on Nov 8.');
  }
});

test('a plan the host cannot read says so, with a retry', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: UNREADABLE });
  assert.match(page.html(), /<p class="field-error">Your plan could not be loaded\.<\/p><button type="button" class="btn btn-ghost" data-action="billing-retry">Retry<\/button>/);
  assert.equal(lede(page.html()), '', 'a plan that could not be read is not described');
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

test('the confirmation names each Agent whose pinned model has no saved key, in the singular for one', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { ...KEYED, agents: [{ name: 'Research', model: 'openai/gpt-5.6-terra' }, { name: 'Ops <Desk>', model: 'openrouter/openai/gpt-5.6-terra' }, { name: 'Writer' }] },
  });
  assert.doesNotMatch(page.html(), /will stop replying/, 'only the confirmation warns');
  await page.click({ 'data-action': 'billing-use-own-key' });
  assert.match(page.html(), /and your plan covers tasks\. These Agents will stop replying until a key is added for their model&rsquo;s provider: Research, Ops &lt;Desk&gt;\.<\/span>/);

  const one = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { ...KEYED, agents: [{ name: 'Research', model: 'openai/gpt-5.6-terra' }, { name: 'Writer' }] },
  });
  await one.click({ 'data-action': 'billing-use-own-key' });
  assert.match(one.html(), /and your plan covers tasks\. This Agent will stop replying until a key is added for its model&rsquo;s provider: Research\.<\/span>/);
  assertHides(one.html(), 'These Agents');
});

test('a switch to your own key that fails shows its error beside the open confirmation', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, switchFails: new Error('The host is down.') });
  await page.click({ 'data-action': 'billing-use-own-key' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  const html = page.html();
  const confirm = html.indexOf('data-action="billing-funding-confirm">Switch to your own key</button>');
  const error = html.indexOf('Could not switch to your own key. Try again.');
  assert.ok(confirm >= 0, 'the confirmation stays open and can be retried');
  assert.ok(error > confirm, 'the error follows the confirmation, not the Stripe buttons');
});

test('a switch to your own key the host refuses below the lowest plan for it names that plan beside the open confirmation', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, switchFails: new BillingRefusal('own_key_plan_required') });
  await page.click({ 'data-action': 'billing-use-own-key' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(page.portCalls, [['chooseFunding', 'own_key']], 'Admin\'s own check passed and the host was asked');
  const html = page.html();
  const confirm = html.indexOf('data-action="billing-funding-confirm">Switch to your own key</button>');
  const error = html.indexOf('<p class="field-error" role="alert">Your own API key needs the $100 plan or higher.</p>');
  assert.ok(confirm >= 0, 'the confirmation stays open');
  assert.ok(error > confirm, 'the reason follows the confirmation');
  assertHides(html, 'Could not switch to your own key');
  assert.equal(billingReads(page.requests), 1, 'the plan is not read again');
});

const KEY_LINK = '<a class="btn btn-ghost" href="/admin/settings/providers?return=plan">Use your own key instead</a></div>';
const BEFORE_KEY = 'Save a key for your default model’s provider to switch to your own key.';
const SWITCH_UNFINISHED = 'Your key is saved, but the switch to your own key did not finish. Go back to Plan to try again.';
const BACK_TO_PLAN = '<a class="btn btn-primary btn-sm" href="/admin/plan">Back to Plan</a></div>';
const OWN_KEY_LEDE = 'Your workspace pays for models with its own API key. Your plan covers tasks.';

test('an Owner on the plan whose default model has no key is told which key to add', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { savedKeys: new Set(['openrouter']), defaultModel: 'anthropic/claude-sonnet-5-5', agents: [] },
  });
  assert.ok(page.html().includes(`${KEY_LINK}<p class="hint">Your default model needs an Anthropic API key. Add one in Settings first.</p>`));
  assert.doesNotMatch(page.html(), /billing-use-own-key/);
});

test('an Owner on the plan with no saved key is sent to Model providers to add one first', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { savedKeys: new Set(), defaultModel: undefined, agents: [] },
  });
  assert.ok(page.html().includes(`${KEY_LINK}<p class="hint">Add a provider API key in Settings first.</p>`));
  assert.doesNotMatch(page.html(), /billing-use-own-key/);
  assert.deepEqual(billingWrites(page.requests), []);
});

test('sent from Plan, saving the default model\'s key switches to the own key once and returns to Plan', async () => {
  const page = await harness({ path: '/admin/settings/providers?return=plan', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  assert.ok(page.html().includes(`<div class="callout"><span>Save a key for your default model&rsquo;s provider to switch to your own key.</span>${BACK_TO_PLAN}`));
  assert.deepEqual(billingWrites(page.requests), [], 'nothing switches before a key is saved');

  await page.saveKey('anthropic');
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/funding', { funding: 'own_key' }]]);
  assert.deepEqual(page.portCalls, [['chooseFunding', 'own_key']]);
  assert.equal(`${page.location.pathname}${page.location.search}`, '/admin/plan');
  assert.equal(lede(page.html()), OWN_KEY_LEDE);
});

test('sent from Plan, a key the switch cannot use stays on Settings, says the switch did not finish, and tries nothing more', async () => {
  const page = await harness({ path: '/admin/settings/providers?return=plan', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  await page.saveKey('openai');
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/funding', { funding: 'own_key' }]]);
  assert.deepEqual(page.portCalls, [], 'the funding is unchanged');
  assert.equal(`${page.location.pathname}${page.location.search}`, '/admin/settings/providers?return=plan');
  assert.ok(page.html().includes(`<div class="callout"><span>${SWITCH_UNFINISHED}</span>${BACK_TO_PLAN}`));
  assertHides(page.html(), BEFORE_KEY);
  assert.doesNotMatch(page.html(), /own_key_missing/);
  await flush();
  assert.equal(fundingWrites(page.requests).length, 1, 'no retry by itself');
});

test('a key saved in Settings without the Plan marker switches nothing', async () => {
  const page = await harness({ path: '/admin/settings/providers', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  assertHides(page.html(), BEFORE_KEY);
  await page.saveKey('anthropic');
  assert.deepEqual(billingWrites(page.requests), []);
  assert.equal(page.location.pathname, '/admin/settings/providers');
});

test('a workspace admin who is not the Owner, sent with the Plan marker, sees no callout and switches nothing', async () => {
  const page = await harness({ path: '/admin/settings/providers?return=plan', billingOffered: true, admin: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  assert.match(page.html(), /data-settings-panel="providers">/, 'an admin reaches Model providers');
  assertHides(page.html(), BEFORE_KEY);
  await page.saveKey('anthropic');
  assert.deepEqual(billingWrites(page.requests), []);
  assertHides(page.html(), SWITCH_UNFINISHED);
});

test('standalone with the Plan marker typed shows no callout and makes no billing request', async () => {
  const page = await harness({ path: '/admin/settings/providers?return=plan', billingOffered: false, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  assertHides(page.html(), BEFORE_KEY);
  await page.saveKey('anthropic');
  assert.equal(page.requests.some((request) => request.path.startsWith('/admin/api/billing')), false);
  assertHides(page.html(), SWITCH_UNFINISHED);
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
  assert.equal(lede(page.html()), PLAN_LEDE);
  assert.match(page.html(), /data-action="billing-use-own-key">Use your own key instead<\/button>/, 'the page turns into the platform view');
});

test('a switch to Chickpea\'s models that fails keeps the confirmation open with a retryable error', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, switchFails: new Error('The host is down.') });
  await page.click({ 'data-action': 'billing-use-platform' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assertShows(page.html(), 'Could not switch to Chickpea’s models. Try again.');
  assert.match(page.html(), /data-action="billing-funding-confirm">Switch to Chickpea&rsquo;s models<\/button>/);
});

const FORBIDDEN_WORDS = /credit|markup|refund|multiplier|\bsteps\b|cache|prefix|working reply/i;

test('no Plan page or onboarding state uses words the customer never sees', async () => {
  const states: Array<[string, Parameters<typeof harness>[0], Array<Record<string, string>>]> = [
    ['plan', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN }, [{ 'data-action': 'billing-change-plan' }, { 'data-action': 'billing-use-own-key' }]],
    ['frozen', { path: '/admin/plan', billingOffered: true, summary: FROZEN }, [{ 'data-action': 'billing-change-plan' }]],
    ['trial', { path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, trial: TRIAL.trial } }, []],
    ['trial without a plan', { path: '/admin/plan', billingOffered: true, summary: TRIAL }, []],
    ['plan with no period', { path: '/admin/plan', billingOffered: true, summary: PLAN_NO_PERIOD }, [{ 'data-action': 'billing-change-plan' }]],
    ['plan ending', { path: '/admin/plan', billingOffered: true, summary: TEAM_ENDING }, []],
    ['plan changing', { path: '/admin/plan', billingOffered: true, summary: TEAM_DOWNGRADING }, []],
    ['member, plan with no period', { path: '/admin/plan', billingOffered: true, owner: false, summary: PLAN_NO_PERIOD }, []],
    ['own key without a plan', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_NO_PLAN }, [{ 'data-action': 'billing-change-plan' }, { 'data-action': 'billing-use-platform' }]],
    ['member, own key without a plan', { path: '/admin/plan', billingOffered: true, owner: false, summary: OWN_KEY_NO_PLAN }, []],
    ['below the minimum', { path: '/admin/plan', billingOffered: true, summary: STARTER_PLAN }, [{ 'data-action': 'billing-use-own-key' }]],
    ['no plan', { path: '/admin/plan', billingOffered: true, summary: NO_PLAN }, []],
    ['member', { path: '/admin/plan', billingOffered: true, owner: false, summary: TEAM_PLAN }, []],
    ['own key on a plan', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM }, [{ 'data-action': 'billing-use-platform' }]],
    ['unreadable', { path: '/admin/plan', billingOffered: true, summary: UNREADABLE }, []],
    ['needs a key', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC }, []],
    ['extra usage refused for want of a plan', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, stripeFails: new BillingRefusal('plan_required') },
      [{ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' }]],
    ['a plan refused below the own-key plan', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, stripeFails: new BillingRefusal('own_key_plan_required') },
      [{ 'data-action': 'billing-change-plan' }, { 'data-action': 'billing-choose-plan', 'data-key': 'plus' }]],
    ['own key refused below its plan', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, switchFails: new BillingRefusal('own_key_plan_required') },
      [{ 'data-action': 'billing-use-own-key' }, { 'data-action': 'billing-funding-confirm' }]],
  ];
  for (const [label, options, clicks] of states) {
    const page = await harness(options);
    assert.doesNotMatch(page.html(), FORBIDDEN_WORDS, label);
    for (const target of clicks) {
      await page.click(target);
      assert.doesNotMatch(page.html(), FORBIDDEN_WORDS, `${label} after ${target['data-action']}`);
    }
  }
  const onboarding: Array<[string, Parameters<typeof harness>[0], Array<Record<string, string>>]> = [
    ['onboarding on Chickpea\'s models', { path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN }, []],
    ['onboarding setup that did not finish', { path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, platformFailures: 1 },
      [{ 'data-action': 'onboarding-platform-retry' }]],
  ];
  for (const [label, options, clicks] of onboarding) {
    const page = await harness(options);
    assert.doesNotMatch(page.html(), FORBIDDEN_WORDS, label);
    for (const target of clicks) {
      await page.click(target);
      assert.doesNotMatch(page.html(), FORBIDDEN_WORDS, `${label} after ${target['data-action']}`);
    }
  }
  const settings = await harness({ path: '/admin/settings/providers?return=plan', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  assertShows(settings.html(), BEFORE_KEY);
  assert.doesNotMatch(settings.html(), FORBIDDEN_WORDS, 'Settings on the way to an own key');
  await settings.saveKey('openai');
  assertShows(settings.html(), SWITCH_UNFINISHED);
  assert.doesNotMatch(settings.html(), FORBIDDEN_WORDS, 'Settings after a switch that did not finish');
});

test('standalone shows nothing new: no billing request, no page, and onboarding goes straight to providers', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: false, summary: TEAM_PLAN });
  assert.equal(page.requests.some((request) => request.path.startsWith('/admin/api/billing')), false);
  assert.doesNotMatch(page.html(), /open-billing|<h1 class="page-title">Plan<\/h1>/);
  assert.notEqual(page.location.pathname, '/admin/plan');

  const onboarding = await harness({ path: '/admin/onboarding', billingOffered: false });
  assert.match(onboarding.html(), /Choose your model provider/);
  assert.equal(platformRequests(onboarding.requests), 0);
});

function progress(html: string): string {
  const start = html.indexOf('<ol class="onboarding-orientation');
  assert.ok(start >= 0, 'the page shows the onboarding progress');
  return html.slice(start, html.indexOf('</ol>', start) + '</ol>'.length);
}

const STANDALONE_AT_CHOOSE_PROVIDER = '<ol class="onboarding-orientation" role="list" aria-label="Onboarding progress">' +
  '<li class="complete"><span class="onboarding-step-label">Connect Slack</span><span class="onboarding-step-note">Done</span></li>' +
  '<li class="active" aria-current="step"><span class="onboarding-step-label">Choose provider</span></li>' +
  '<li class=""><span class="onboarding-step-label">Choose model</span></li>' +
  '<li class=""><span class="onboarding-step-label">Try Chickpea</span><span class="onboarding-step-note">Say hi</span></li></ol>';
const STANDALONE_AT_TRY = '<ol class="onboarding-orientation" role="list" aria-label="Onboarding progress">' +
  '<li class="complete"><span class="onboarding-step-label">Connect Slack</span><span class="onboarding-step-note">Done</span></li>' +
  '<li class="complete"><span class="onboarding-step-label">Choose provider</span><span class="onboarding-step-note">Done</span></li>' +
  '<li class="complete"><span class="onboarding-step-label">Choose model</span><span class="onboarding-step-note">Done</span></li>' +
  '<li class="active" aria-current="step"><span class="onboarding-step-label">Try Chickpea</span><span class="onboarding-step-note">Say hi</span></li></ol>';

test('standalone keeps its four onboarding steps, byte for byte; hosted without Chickpea\'s models starts them at Add to Slack', async () => {
  for (const [mode, selfHosted, first] of [['standalone', true, 'Connect Slack'], ['hosted without Chickpea\'s models', false, 'Add to Slack']] as const) {
    const firstStep = (bar: string) => bar.replace('>Connect Slack<', `>${first}<`);
    const choosing = await harness({ path: '/admin/onboarding', billingOffered: false, selfHosted });
    assert.equal(progress(choosing.html()), firstStep(STANDALONE_AT_CHOOSE_PROVIDER), `${mode} at Choose provider`);
    const trying = await harness({ path: '/admin/onboarding', billingOffered: false, selfHosted, onboarding: TRY });
    assert.equal(progress(trying.html()), firstStep(STANDALONE_AT_TRY), `${mode} at Try`);
  }
});

const platformRequests = (requests: Array<{ path: string; method: string }>) =>
  requests.filter((request) => request.method === 'POST' && request.path === '/admin/api/onboarding/platform').length;
const stepLabels = (html: string) =>
  [...progress(html).matchAll(/<span class="onboarding-step-label">([^<]*)<\/span>/g)].map((match) => match[1]);

test('hosted onboarding on Chickpea\'s models goes from Add to Slack to Try Chickpea, setting up once', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN });
  assert.equal(platformRequests(page.requests), 1);
  assert.deepEqual(stepLabels(page.html()), ['Add to Slack', 'Try Chickpea']);
  assert.match(progress(page.html()), /<li class="active" aria-current="step"><span class="onboarding-step-label">Try Chickpea<\/span><span class="onboarding-step-note">Say hi<\/span><\/li><\/ol>$/);
  assert.match(page.html(), /<p class="onboarding-eyebrow">Step 2 of 2<\/p><h1 class="onboarding-title">Say hi to Chickpea in Slack<\/h1>/);
  assert.doesNotMatch(page.html(), /Choose your model provider|Choose your model/);

  const reload = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, onboarding: TRY });
  assert.match(reload.html(), /Say hi to Chickpea in Slack/);
  assert.deepEqual(stepLabels(reload.html()), ['Add to Slack', 'Try Chickpea']);
  assert.equal(platformRequests(reload.requests), 0, 'a journey at Try sets nothing up again');
});

test('while Chickpea sets up, the page says it is moving into the workspace, as step 1, and nothing else asks again', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, platformHeld: true });
  assert.ok(page.html().includes('<section class="onboarding-panel"><p class="onboarding-eyebrow">Step 1 of 2</p><h1 class="onboarding-title">Setting up Chickpea in Acme</h1>' +
    '<p class="onboarding-lede">Chickpea is unpacking in your workspace. This takes a few seconds.</p>' +
    '<div class="onboarding-progress" aria-hidden="true"><i></i></div></section>'));
  assert.match(page.html(), /data-scene="setting-up"[\s\S]*<p class="onboarding-caption">Moving in…<\/p>/);
  const unnamed = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, platformHeld: true, onboarding: { ...CHOOSE_PROVIDER, workspace: { id: 'TACME', name: null } } });
  assert.match(unnamed.html(), /<h1 class="onboarding-title">Setting up Chickpea&hellip;<\/h1>/, 'a workspace without a name is not named');
  assert.deepEqual(stepLabels(page.html()), ['Add to Slack', 'Try Chickpea']);
  await page.click({ 'data-action': 'toggle-swap' });
  assert.equal(platformRequests(page.requests), 1, 'a render while it runs sends nothing more');
  page.releasePlatform();
  await flush();
  assert.match(page.html(), /Say hi to Chickpea in Slack/);
  assert.equal(platformRequests(page.requests), 1);
});

test('with Connect GitHub offered, it is the step between Add to Slack and Try Chickpea', async () => {
  const github = { ...CHOOSE_PROVIDER, githubConnectPath: '/github/connect' };
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, onboarding: github });
  assert.deepEqual(stepLabels(page.html()), ['Add to Slack', 'Connect GitHub', 'Try Chickpea']);
  assert.match(progress(page.html()), /<li class="active" aria-current="step"><span class="onboarding-step-label">Connect GitHub<\/span><span class="onboarding-step-note">Optional<\/span><\/li>/);
  assert.match(page.html(), /Let Agents work on your code/);
});

test('setup that does not finish offers Try again, never the provider steps, and Try again reaches Try', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, platformFailures: 1 });
  assert.equal(platformRequests(page.requests), 1);
  assert.ok(page.html().includes('<section class="onboarding-panel"><p class="onboarding-eyebrow">Setup</p><h1 class="onboarding-title">Setup did not finish</h1>' +
    '<p class="field-error" role="alert">Chickpea could not finish setting up. Try again.</p>' +
    '<p class="hint">Code: internal_error</p>' +
    '<div class="onboarding-actions"><button type="button" class="btn btn-primary" data-action="onboarding-platform-retry">Try again</button></div></section>'));
  assert.doesNotMatch(page.html(), /Choose your model provider|onboarding-provider-tab/);
  await flush();
  assert.equal(platformRequests(page.requests), 1, 'a failure waits for Try again');

  await page.click({ 'data-action': 'onboarding-platform-retry' });
  assert.equal(platformRequests(page.requests), 2);
  assert.match(page.html(), /Say hi to Chickpea in Slack/);
});

test('the failed setup card names the route\'s error code, and shows no code line when the response has none', async () => {
  const coded = await harness({
    path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, platformFailures: 1, platformFailureBody: { error: 'workspace_mismatch' },
  });
  assert.ok(coded.html().includes('Chickpea could not finish setting up. Try again.</p><p class="hint">Code: workspace_mismatch</p>'));
  const uncoded = await harness({
    path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, platformFailures: 1, platformFailureBody: 'Bad gateway',
  });
  assert.match(uncoded.html(), /Setup did not finish/);
  assert.doesNotMatch(uncoded.html(), /Code:/);
  await uncoded.click({ 'data-action': 'onboarding-platform-retry' });
  assert.match(uncoded.html(), /Say hi to Chickpea in Slack/);
});

test('a journey already past the provider step sets up the same way', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, onboarding: { ...CHOOSE_PROVIDER, stage: 'choose_model', providerId: 'openai' } });
  assert.equal(platformRequests(page.requests), 1, 'a journey already past the provider sets up too');
  assert.match(page.html(), /Say hi to Chickpea in Slack/);
});


test('on Chickpea\'s models the step bar is the same from the first paint to Chickpea is ready, with or without GitHub', async () => {
  for (const [githubConnectPath, steps] of [[undefined, ['Add to Slack', 'Try Chickpea']], ['/github/connect', ['Add to Slack', 'Connect GitHub', 'Try Chickpea']]] as const) {
    const github = githubConnectPath ? { githubConnectPath } : {};
    const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, platformHeld: true, onboarding: { ...CHOOSE_PROVIDER, ...github } });
    assert.match(page.renders[0]!, /Setting up Chickpea in Acme/, 'the first paint is already setting up');
    assert.match(progress(page.renders[0]!), /<li class="active" aria-current="step"><span class="onboarding-step-label">Add to Slack<\/span><span class="onboarding-step-note">Your workspace<\/span><\/li>/,
      'setting up belongs to adding Chickpea to Slack');
    page.releasePlatform();
    await flush();
    if (githubConnectPath) {
      assert.match(page.html(), /Let Agents work on your code/);
      await page.click({ 'data-action': 'onboarding-github-skip' });
    }
    assert.match(page.html(), new RegExp(`<p class="onboarding-eyebrow">Step ${steps.length} of ${steps.length}</p>`));
    const ready = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, onboarding: { ...TRY, ...github, stage: 'complete' } });
    for (const html of [...page.renders, ...ready.renders]) assert.deepEqual(stepLabels(html), steps);
  }
});

test('the boot\'s other requests never move a journey back once setup moved it on', async () => {
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, modelsHeld: true });
  assert.match(page.html(), /Say hi to Chickpea in Slack/, 'setup finished before the boot\'s requests');
  page.releaseModels();
  await flush();
  assert.match(page.html(), /Say hi to Chickpea in Slack/);
  assert.equal(page.requests.filter(({ path, method }) => method === 'GET' && path === '/admin/api/onboarding').length, 0,
    'the page carries the journey, so nothing asks for it again');
  assert.equal(platformRequests(page.requests), 1);
});

test('Try checks for Chickpea\'s first reply every second for two minutes, then less often for a tab left open', async () => {
  const clock = { now: Date.parse('2026-10-09T12:00:00Z') };
  const page = await harness({ path: '/admin/onboarding', billingOffered: true, summary: NO_PLAN, onboarding: TRY, clock, manualPolls: true });
  assert.match(page.html(), /Say hi to Chickpea in Slack/);
  const polls = () => page.timerDelays.filter((ms) => ms >= 1000);
  assert.deepEqual(polls(), [1000]);
  clock.now += 119_000;
  await page.firePoll();
  assert.deepEqual(polls(), [1000, 1000], 'still every second inside the first two minutes');
  clock.now += 2_000;
  await page.firePoll();
  assert.deepEqual(polls(), [1000, 1000, 5000], 'every five seconds after two minutes');
  clock.now += 10 * 60_000;
  await page.firePoll();
  assert.deepEqual(polls(), [1000, 1000, 5000, 15000], 'every fifteen seconds after ten minutes');
  assert.equal(page.requests.filter(({ path, method }) => method === 'GET' && path === '/admin/api/onboarding').length, 3);
});

const stepBar = (html: string) => html.match(/<ol class="onboarding-orientation[\s\S]*?<\/ol>/)?.[0];
const scene = (html: string) => html.match(/<aside class="onboarding-scene[\s\S]*?<\/aside>/)?.[0];

test('the server paints the same scene and step bar the script paints first, at every stage and in every mode', async () => {
  const stages = ['choose_provider', 'choose_model', 'connect_github', 'try', 'complete'];
  const modes: Array<[string, { billingOffered: boolean; selfHosted?: boolean; github?: string }]> = [
    ['Chickpea\'s models with GitHub', { billingOffered: true, github: '/github/connect' }],
    ['Chickpea\'s models without GitHub', { billingOffered: true }],
    ['own key, hosted, with GitHub', { billingOffered: false, selfHosted: false, github: '/github/connect' }],
    ['standalone', { billingOffered: false, selfHosted: true }],
  ];
  for (const [mode, { billingOffered, selfHosted, github }] of modes) {
    for (const stage of stages) {
      for (const search of stage === 'connect_github' ? ['', '?github=connected'] : ['']) {
        const onboarding = { ...TRY, stage, ...(github ? { githubConnectPath: github } : {}) };
        const page = await harness({
          path: `/admin/onboarding${search}`, billingOffered, ...(selfHosted === undefined ? {} : { selfHosted }),
          summary: NO_PLAN, onboarding, platformHeld: true,
        });
        const server = stepBar(page.serverHtml.slice(0, page.serverHtml.indexOf('<script')));
        assert.ok(server, `${mode} at ${stage}${search}: the server paints a step bar`);
        assert.equal(server, stepBar(page.renders[0]!), `${mode} at ${stage}${search}`);
        const serverScene = scene(page.serverHtml.slice(0, page.serverHtml.indexOf('<script')));
        assert.ok(serverScene, `${mode} at ${stage}${search}: the server paints the scene`);
        assert.equal(serverScene, scene(page.renders[0]!), `${mode} at ${stage}${search}: the same scene`);
      }
    }
  }
});
