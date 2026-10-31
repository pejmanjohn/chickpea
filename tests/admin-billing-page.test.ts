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
import {
  NO_PLAN, OFFERS, OWN_KEY_NO_PLAN, PERIOD, PLAN_NO_PERIOD, STARTER_PLAN, TEAM_DOWNGRADING, TEAM_ENDING, TEAM_PLAN, TRIAL_GRANT, usd,
} from './helpers/billing-summaries.ts';

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
const TRIAL: BillingSummary = { ...NO_PLAN, trial: TRIAL_GRANT };
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
  /** Admin's Agent list, for the avatars beside use by Agent. */
  agents?: unknown[];
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
    choseChickpeaModels: async () => undefined,
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
    if (path === '/admin/api/agents') return response({ agents: options.agents ?? [] });
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
    browserSetupOffered: !options.billingOffered, websiteLoginsOffered: !options.billingOffered,
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
  /** Picks a plan size in a plan card's select. */
  const choose = (cardKey: 'platform' | 'own_key', planKey: string) => {
    listeners.change!({ target: actionTarget({ 'data-action': 'billing-plan-level', 'data-card': cardKey }, planKey) });
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
    html: () => html, renders, timerDelays, requests, assigned, location, click, choose, saveKey, firePoll, serverHtml,
    portCalls: billing?.calls ?? [], releasePlatform: () => releasePlatform(), releaseModels: () => releaseModels(),
  };
}

/** The page's HTML with its entities decoded, so copy can be matched as a person reads it. */
function decoded(html: string): string {
  return html.replace(/&rsquo;/g, '’').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”').replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
}

/** What a person reads: the text without tags, its spaces collapsed. */
function text(html: string): string {
  return decoded(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function assertShows(html: string, copy: string): void {
  assert.ok(text(html).includes(copy), `the page shows "${copy}" in: ${text(html).slice(0, 400)}`);
}

function assertHides(html: string, copy: string): void {
  assert.ok(!text(html).includes(copy), `the page does not show "${copy}"`);
}

/** The sentence under the page title. */
function lede(html: string): string {
  return decoded(/<p class="plan-lede">([^<]*)<\/p>/.exec(html)?.[1] ?? '');
}

/** The status card. */
function hero(html: string): string {
  const start = html.indexOf('<section class="plan-hero');
  assert.ok(start >= 0, 'the page shows the status card');
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}

type Card = 'platform' | 'own_key';

/** One plan card: Models included (platform) or Your own API key (own_key). */
function card(html: string, which: Card): string {
  const heading = html.indexOf(`aria-labelledby="plan-card-${which}"`);
  assert.ok(heading >= 0, `the page shows the ${which} card`);
  const start = html.lastIndexOf('<article', heading);
  return html.slice(start, html.indexOf('</article>', heading) + '</article>'.length);
}

/** A card's button as a person reads it, with where it leads: a link's path, a Checkout's plan key, and its tone. */
function cardStep(html: string, which: Card): string {
  const action = /<(button|a) ([^>]*class="btn ([^"]*) plan-card-action"[^>]*)>([^<]*)<\/\1>/.exec(card(html, which));
  if (!action) return 'no button';
  const [, element, attributes, tone, label] = action as unknown as [string, string, string, string, string];
  if (element === 'a') return `${decoded(label)} → ${/href="([^"]*)"/.exec(attributes)?.[1]}`;
  if (/ disabled/.test(attributes)) return `${decoded(label)} (disabled)`;
  const key = /data-key="([^"]*)"/.exec(attributes)?.[1];
  return `${decoded(label)} [${tone.includes('btn-primary') ? 'primary' : 'soft'}${key ? ` ${key}` : ''}]`;
}

function cardTag(html: string, which: Card): string {
  return decoded(/<p class="plan-card-tag">([^<]*)<\/p>/.exec(card(html, which))?.[1] ?? '');
}

/** The plan sizes a card's select offers, as a person reads them, and the one it shows. */
function cardLevels(html: string, which: Card): { options: string[]; selected: string } {
  const options = [...card(html, which).matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)];
  return {
    options: options.map((option) => decoded(option[3]!)),
    selected: options.find((option) => option[2])?.[1] ?? '',
  };
}

const fundingWrites = (requests: Array<{ path: string }>) => requests.filter((request) => request.path === '/admin/api/billing/funding');
const billingWrites = (requests: Array<{ path: string; method: string; body: unknown }>) =>
  requests.filter((request) => request.path.startsWith('/admin/api/billing/')).map((request) => [request.method, request.path, request.body]);
const billingReads = (requests: Array<{ path: string; method: string }>) =>
  requests.filter((request) => request.method === 'GET' && request.path === '/admin/api/billing').length;

/** The Plus plan with an own key, part-way through its period: 122 of its 400 tasks used. */
const OWN_KEY_PLUS: BillingSummary = {
  ...NO_PLAN,
  funding: 'own_key',
  plan: { key: 'plus', name: 'Plus', priceCents: 10_000 },
  period: PERIOD,
  planUsage: { usedMicros: usd(36.6), includedMicros: usd(120), onPacePercent: 64 },
};
/** The Starter plan with all of its usage used and nothing in reserve. */
const STARTER_USED_UP: BillingSummary = { ...STARTER_PLAN, planUsage: { usedMicros: usd(60), includedMicros: usd(60), onPacePercent: null } };
const OWN_KEY_USED_UP: BillingSummary = { ...OWN_KEY_PLUS, planUsage: { usedMicros: usd(120), includedMicros: usd(120), onPacePercent: null } };

test('an Owner on the Team plan reads what is left, the tasks it covers, the meter, and what carried over, with Add usage beside it', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan');
  assert.match(html, /<h1 class="page-title">Plan<\/h1>/);
  assert.match(html, /data-action="open-billing"[^>]*>Plan<\/button>/, 'the section switcher names the page');
  assert.match(html, /<span class="chan-name">Overview<\/span><span class="chan-meta">Models included<\/span>/);
  assert.equal(lede(html), 'Your workspace is on the $200 plan with models included.');
  assert.match(html, /data-action="billing-manage">Manage billing<\/button>/);
  const status = hero(html);
  assertShows(status, 'This month $172 left About 375 tasks · Renews Nov 7');
  assert.match(status, /role="meter" aria-label="Plan usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="53"><span class="plan-meter-fill" style="width: 53%"><\/span><span class="plan-meter-pace" style="left: 80%"><\/span>/);
  assertShows(status, '$128 of $240 plan usage On pace for 80% by Nov 7');
  assertShows(status, '+$20 carried over until Nov 7');
  assertShows(status, '+$40 extra usage until Sep 14, 2027');
  assertShows(status, 'Add usage $25 $50 $100 Keeps 12 months');
  for (const dollars of [25, 50, 100]) {
    assert.match(status, new RegExp(`class="btn btn-soft" data-action="billing-add-extra-usage" data-key="extra_usage_${dollars}" aria-label="Add \\$${dollars} of extra usage">\\$${dollars}</button>`));
  }
  assert.doesNotMatch(status, /plan-hero-alert|is-out/);
  assert.deepEqual(billingWrites(page.requests), []);
});

test('on an own key, the status counts exact tasks left and the meter counts tasks used', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_PLUS })).html();
  assert.equal(lede(html), 'Your workspace is on the $100 plan with its own API key.');
  assert.match(html, /<span class="chan-meta">Own API key<\/span>/);
  const status = hero(html);
  assertShows(status, 'This month 278 tasks left $83.40 of usage left · Renews Nov 7 · Your provider bills tokens');
  assertShows(status, '122 of 400 tasks used On pace for 64% by Nov 7');
  assert.match(status, /aria-label="Plan tasks"[^>]*aria-valuenow="30"/);
  assertHides(status, 'About');
});

test('a rate card whose tasks draw nothing shows what is left in dollars and sizes without task counts, instead of no page', async () => {
  const free = { ...OFFERS, taskFeeMicros: usd(0) };
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...OWN_KEY_PLUS, offers: free } })).html();
  const status = hero(html);
  assertShows(status, 'This month $83.40 left Renews Nov 7 · Your provider bills tokens');
  assertShows(status, '$36.60 of $120 plan usage On pace for 64% by Nov 7');
  assertHides(status, 'tasks');
  assert.deepEqual(cardLevels(html, 'own_key').options, ['$100 a month', '$200 a month', '$300 a month', '$500 a month']);
  assert.equal(cardLevels(html, 'platform').options[2], '$100 a month · about 800 tasks', 'with models included a typical task still costs its tokens');
  const noPlan = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...OWN_KEY_NO_PLAN, offers: free } })).html());
  assertShows(noPlan, 'Your Agents can still chat. With your own API key, plans start at $100 a month.');
});

test('used up, the meter turns red, Add usage turns primary, and the alert says what is paused and when it starts again', async () => {
  const cases: Array<[string, BillingSummary, boolean, string]> = [
    ['models included', STARTER_USED_UP, true,
      'Your Agents are paused. Add usage to keep them working now, or they start again when your plan renews Nov 7.'],
    ['an own key', OWN_KEY_USED_UP, true,
      'Tasks are paused, and your Agents can still chat. Add usage to keep tasks going, or they start again when your plan renews Nov 7.'],
    ['a plan that ends', { ...STARTER_USED_UP, pendingChange: TEAM_ENDING.pendingChange }, true,
      'Your Agents are paused. Add usage to keep them working now.'],
    ['a Member on models included', STARTER_USED_UP, false,
      'Your Agents are paused. An Owner can add usage to keep them working now, or they start again when your plan renews Nov 7.'],
    ['a Member on an own key', OWN_KEY_USED_UP, false,
      'Tasks are paused, and your Agents can still chat. An Owner can add usage to keep tasks going, or they start again when your plan renews Nov 7.'],
  ];
  for (const [label, summary, owner, alert] of cases) {
    const status = hero((await harness({ path: '/admin/plan', billingOffered: true, owner, summary })).html());
    assert.match(status, /<section class="plan-hero is-out"/, label);
    assert.match(status, /<div class="plan-meter is-out"/, label);
    assert.equal(decoded(/<p class="plan-hero-alert" role="status">.*?<span>([^<]*)<\/span><\/p>/.exec(status)?.[1] ?? ''), alert, label);
    assertShows(status, 'Used up');
    assertHides(status, 'About');
    const buttons = [...status.matchAll(/class="btn (btn-\w+)" data-action="billing-add-extra-usage"/g)].map((match) => match[1]);
    assert.deepEqual(buttons, owner ? ['btn-primary', 'btn-primary', 'btn-primary'] : [], label);
  }
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_USED_UP })).html()), '$0 left Renews Nov 7');
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_USED_UP })).html()), '0 tasks left $0 of usage left');
});

test('the plan\'s usage used up is not the workspace\'s: what carried over and extra usage keep the Agents working, and debt counts against them', async () => {
  const planUsedUp: BillingSummary = { ...TEAM_PLAN, planUsage: { usedMicros: usd(240), includedMicros: usd(240), onPacePercent: null } };
  const working = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: planUsedUp })).html());
  assertShows(working, '$60 left About 125 tasks');
  assertShows(working, '$240 of $240 plan usage Used up');
  assert.doesNotMatch(working, /is-out|plan-hero-alert|btn-primary/);
  const owing = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...planUsedUp, debtMicros: usd(60) } })).html());
  assertShows(owing, '$0 left');
  assert.match(owing, /plan-hero-alert/, 'what the workspace owes uses up what it has');
});

test('a trial shows what is left, the tasks that covers, when it ends, and how much is used, and its plans are on offer', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TRIAL });
  const html = page.html();
  assert.equal(lede(html), 'Your free trial includes $50 of usage, with models included.');
  assert.match(html, /<span class="chan-meta">Free trial<\/span>/);
  assert.doesNotMatch(html, /billing-manage|billing-add-extra-usage/, 'a trial has nothing to manage and no plan to add usage to');
  const status = hero(html);
  assertShows(status, 'Free trial $32.50 left About 70 tasks · Ends Nov 6');
  assert.match(status, /aria-label="Trial usage"[^>]*aria-valuenow="35"/);
  assertShows(status, '$17.50 of $50 used No card needed');
  assert.match(html, /<h2 class="section-title" id="plan-cards-heading">Choose a plan<\/h2><p class="hint">Both include every feature and connector\. Pay for models with us, or bring your own key\.<\/p>/);

  const usedUp = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...NO_PLAN, trial: { ...TRIAL_GRANT, remainingMicros: usd(0) } } })).html());
  assertShows(usedUp, 'Free trial $0 left Ends Nov 6');
  assertShows(usedUp, 'Your trial’s usage is used up. Choose a plan to keep your Agents working.');
  assert.match(usedUp, /plan-meter is-out/);

  const beside = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, trial: TRIAL_GRANT } })).html());
  assertShows(beside, 'This month $204.50 left', );
  assertShows(beside, '+$32.50 trial usage until Nov 6');
});

test('an own key with no plan says tasks are paused while chat goes on, and offers the lowest plan for an own key', async () => {
  for (const owner of [true, false]) {
    const page = await harness({ path: '/admin/plan', billingOffered: true, owner, summary: OWN_KEY_NO_PLAN });
    const html = page.html();
    assert.equal(lede(html), 'Your workspace pays for models with its own API key, and has no plan yet.');
    assert.match(html, /<span class="chan-meta">Own API key<\/span>/);
    const status = hero(html);
    assert.match(status, /<section class="plan-hero is-muted"/);
    assertShows(status, 'No plan Tasks are paused Your Agents can still chat. With your own API key, plans start at $100 a month, which covers 400 tasks.');
    assert.equal(/data-action="billing-choose-plan"/.test(status), owner, owner ? 'an Owner can choose it' : 'a Member cannot');
  }
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_NO_PLAN });
  assert.match(hero(page.html()), /class="btn btn-primary" data-action="billing-choose-plan" data-key="plus" data-at="hero">Choose the \$100 plan<\/button>/);
  await page.click({ 'data-action': 'billing-choose-plan', 'data-key': 'plus', 'data-at': 'hero' });
  assert.deepEqual(page.portCalls, [['checkout', { kind: 'plan', key: 'plus' }]]);
  assert.deepEqual(page.assigned, ['https://checkout.stripe.com/c/pay/plus']);
  assert.match(hero(page.html()), /data-key="plus" data-at="hero" disabled>Opening Stripe&hellip;<\/button>/);

  const team = { ...OWN_KEY_NO_PLAN, offers: { ...OWN_KEY_NO_PLAN.offers, ownKeyMinimumPlanKey: 'team' } };
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: team })).html()), 'plans start at $200 a month, which covers 800 tasks.');
});

test('models included with no plan or trial says the Agents are paused, and extra usage waits for a plan', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: FROZEN })).html();
  assert.equal(lede(html), 'Your workspace has no plan yet.');
  const status = hero(html);
  assert.match(status, /<section class="plan-hero is-muted"/);
  assertShows(status, 'No plan Your Agents are paused Choose a plan to get them working again.');
  assertShows(status, '$40 of extra usage waits for a plan until Oct 7, 2027');
  assertHides(status, '+$40');
  assert.doesNotMatch(html, /billing-add-extra-usage|billing-manage/);
  assert.doesNotMatch(html, /plan-use-heading/, 'no plan and no use, so no usage section');
});

test('a plan with no period yet shows its monthly usage and the tasks it covers, with no meter', async () => {
  const status = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: PLAN_NO_PERIOD })).html());
  assertShows(status, 'Each month $240 of usage a month About 500 tasks');
  assertShows(status, '+$40 extra usage');
  assert.doesNotMatch(status, /role="meter"|plan-hero-alert/);
  assertHides(status, 'Renews');
  assert.match(status, /billing-add-extra-usage/, 'extra usage stays on sale with a plan');
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, funding: 'own_key' } })).html()),
    'Each month 800 tasks a month $240 of usage a month · Your provider bills tokens');
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, pendingChange: TEAM_ENDING.pendingChange } })).html()),
    'About 500 tasks · Ends Nov 7');
});

test('a plan cancelled in Stripe\'s portal says when it ends, and a downgrade names the plan it changes to, in place of when it renews, to everyone', async () => {
  for (const owner of [true, false]) {
    const ending = hero((await harness({ path: '/admin/plan', billingOffered: true, owner, summary: TEAM_ENDING })).html());
    assertShows(ending, 'About 375 tasks · Ends Nov 7');
    assertHides(ending, 'Renews');
    const downgrading = hero((await harness({ path: '/admin/plan', billingOffered: true, owner, summary: TEAM_DOWNGRADING })).html());
    assertShows(downgrading, 'About 375 tasks · Changes to the Chickpea $50 plan on Nov 7');
    assertHides(downgrading, 'Renews');
  }
});

test('the cards offer every plan with models included and the own-key plans with your own key, each counted in tasks', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN })).html();
  assert.match(html, /<h2 class="section-title" id="plan-cards-heading">Your plan<\/h2><p class="hint">Change your plan&rsquo;s size, or how your workspace pays for models\.<\/p>/);
  assert.deepEqual(cardLevels(html, 'platform'), {
    options: ['$25 a month · about 60 tasks', '$50 a month · about 125 tasks', '$100 a month · about 250 tasks',
      '$200 a month · about 500 tasks', '$300 a month · about 800 tasks', '$500 a month · about 1,300 tasks'],
    selected: 'team',
  });
  assert.deepEqual(cardLevels(html, 'own_key'), {
    options: ['$100 a month · 400 tasks', '$200 a month · 800 tasks', '$300 a month · 1,200 tasks', '$500 a month · 2,000 tasks'],
    selected: 'team',
  });
  assertShows(card(html, 'platform'), 'Models included Claude, GPT, and open models through our provider accounts. One bill. $200 / month');
  assertShows(card(html, 'own_key'), 'Your own API key Bring your Anthropic, OpenAI, or OpenRouter key. $200 / month');
  assertShows(html, 'Prices in US dollars. Tax added where required. Pricing questions');
  assert.match(html, /<a href="https:\/\/chickpea\.co\/pricing#questions" target="_blank" rel="noopener">Pricing questions<\/a>/);

  const starter = (await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_PLAN })).html();
  assert.equal(cardLevels(starter, 'platform').selected, 'starter', 'the current plan, where it fits the card');
  assert.equal(cardLevels(starter, 'own_key').selected, 'plus', 'else the lowest plan for an own key');
  assert.equal(cardLevels((await harness({ path: '/admin/plan', billingOffered: true, summary: NO_PLAN })).html(), 'platform').selected, 'plus');
});

test('each card\'s button is the next step toward paying its way at the size it shows', async () => {
  const NO_KEY_AT_ALL: OwnKeyFacts = { savedKeys: new Set(), defaultModel: undefined, agents: [] };
  const cases: Array<[string, BillingSummary, OwnKeyFacts, Card, string | null, string]> = [
    ['models included on Team, at Team', TEAM_PLAN, KEYED, 'platform', null, 'Your current plan (disabled)'],
    ['models included on Team, at $500', TEAM_PLAN, KEYED, 'platform', 'business', 'Change to the $500 plan [primary business]'],
    ['models included with no plan', NO_PLAN, KEYED, 'platform', null, 'Choose the $100 plan [primary plus]'],
    ['models included with no plan, at $25', NO_PLAN, KEYED, 'platform', 'solo', 'Choose the $25 plan [primary solo]'],
    ['models included in a trial', TRIAL, KEYED, 'platform', null, 'Choose the $100 plan [primary plus]'],
    ['an own key from Team, at Team, with the key', TEAM_PLAN, KEYED, 'own_key', null, 'Switch to your own key [soft]'],
    ['an own key from Team, at Team, without the key', TEAM_PLAN, NEEDS_ANTHROPIC, 'own_key', null, 'Add your Anthropic key → /admin/settings/providers?return=plan'],
    ['an own key from Team, with no default model or key', TEAM_PLAN, NO_KEY_AT_ALL, 'own_key', null, 'Add your API key → /admin/settings/providers?return=plan'],
    ['an own key from Team, at $300', TEAM_PLAN, KEYED, 'own_key', 'growth', 'Choose the $300 plan [soft growth]'],
    ['an own key from Starter', STARTER_PLAN, KEYED, 'own_key', null, 'Choose the $100 plan [soft plus]'],
    ['an own key with no plan yet', NO_PLAN, KEYED, 'own_key', null, 'Choose the $100 plan [soft plus]'],
    ['an own key on Team, at Team', OWN_KEY_TEAM, KEYED, 'own_key', null, 'Your current plan (disabled)'],
    ['an own key on Team, at $100', OWN_KEY_TEAM, KEYED, 'own_key', 'plus', 'Change to the $100 plan [primary plus]'],
    ['an own key with no plan', OWN_KEY_NO_PLAN, KEYED, 'own_key', null, 'Choose the $100 plan [primary plus]'],
    ['models included from an own key', OWN_KEY_TEAM, KEYED, 'platform', null, 'Switch to models included [soft]'],
    ['models included from an own key, at $500', OWN_KEY_TEAM, KEYED, 'platform', 'business', 'Switch to models included [soft]'],
    ['models included from an own key with no plan', OWN_KEY_NO_PLAN, KEYED, 'platform', null, 'Switch to models included [soft]'],
  ];
  for (const [label, summary, ownKey, which, size, step] of cases) {
    const page = await harness({ path: '/admin/plan', billingOffered: true, summary, ownKey });
    if (size) page.choose(which, size);
    assert.equal(cardStep(page.html(), which), step, label);
  }
});

test('a card\'s Checkout opens Stripe for the size it shows, and says so in that card when Stripe cannot open', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  page.choose('platform', 'business');
  await page.click({ 'data-action': 'billing-choose-plan', 'data-key': 'business', 'data-at': 'platform' });
  assert.deepEqual(page.portCalls, [['checkout', { kind: 'plan', key: 'business' }]]);
  assert.deepEqual(page.assigned, ['https://checkout.stripe.com/c/pay/business']);
  const html = page.html();
  assert.match(card(html, 'platform'), /data-key="business" data-at="platform" disabled>Opening Stripe&hellip;<\/button>/, 'the busy button stays until the browser leaves');
  assert.match(card(html, 'own_key'), /<select [^>]*disabled>/, 'nothing else can be chosen meanwhile');
  assert.match(hero(html), /data-key="extra_usage_25"[^>]* disabled>\$25<\/button>/);

  const failing = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_PLAN, stripeFails: new Error('Stripe is down.') });
  await failing.click({ 'data-action': 'billing-choose-plan', 'data-key': 'plus', 'data-at': 'own_key' });
  assertShows(card(failing.html(), 'own_key'), 'Stripe could not be opened. Try again.');
  assertHides(card(failing.html(), 'platform'), 'Stripe could not be opened');
  assertHides(hero(failing.html()), 'Stripe could not be opened');
  assert.equal(cardStep(failing.html(), 'own_key'), 'Choose the $100 plan [soft plus]', 'the button can be pressed again');
  assert.deepEqual(failing.assigned, []);
});

test('a plan the host refuses for an own key names the lowest plan for one, in the card that asked', async () => {
  for (const [minimum, price] of [['plus', '$100'], ['team', '$200']] as const) {
    const summary: BillingSummary = { ...OWN_KEY_TEAM, offers: { ...OWN_KEY_TEAM.offers, ownKeyMinimumPlanKey: minimum } };
    const page = await harness({ path: '/admin/plan', billingOffered: true, summary, stripeFails: new BillingRefusal('own_key_plan_required') });
    await page.click({ 'data-action': 'billing-choose-plan', 'data-key': 'growth', 'data-at': 'own_key' });
    assert.match(card(page.html(), 'own_key'), new RegExp(`<p class="field-error" role="alert">Your own API key needs the \\${price} plan or higher\\.</p>`));
    assertHides(page.html(), 'Stripe could not be opened');
    assert.equal(billingReads(page.requests), 1, 'the plan is not read again');
  }
});

test('the tag and ring mark how the workspace pays now', async () => {
  const cases: Array<[string, BillingSummary, string, string]> = [
    ['models included on a plan', TEAM_PLAN, 'Current plan', ''],
    ['a trial', TRIAL, 'Recommended', ''],
    ['models included with no plan', NO_PLAN, 'Recommended', ''],
    ['an own key on a plan', OWN_KEY_TEAM, '', 'Current plan'],
    ['an own key with no plan', OWN_KEY_NO_PLAN, '', 'Your setup'],
  ];
  for (const [label, summary, platform, ownKey] of cases) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, summary })).html();
    assert.deepEqual([cardTag(html, 'platform'), cardTag(html, 'own_key')], [platform, ownKey], label);
    assert.deepEqual([/class="plan-card is-marked"/.test(card(html, 'platform')), /class="plan-card is-marked"/.test(card(html, 'own_key'))], [!!platform, !!ownKey], label);
  }
});

test('each card says what its size includes and what paying its way gives', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, ownKey: KEYED })).html();
  assertShows(card(html, 'platform'), 'Replies stop using your key, and model tokens draw on your plan’s usage at list price.');
  assertShows(card(html, 'platform'), 'Model tokens at list price, no markup 20% bonus usage every month Unused usage rolls over for one month Every feature and connector');
  assertShows(card(html, 'own_key'), 'Your provider bills tokens, so the whole plan goes to tasks, 30¢ each.');
  assertShows(card(html, 'own_key'), 'Tokens at your own provider rates Chat replies included Unused usage rolls over for one month Every feature and connector Using your Anthropic key. Manage keys');
  assert.match(card(html, 'own_key'), /<a class="hint-link" href="\/admin\/settings\/providers">Manage keys<\/a>/);
  assert.doesNotMatch(card(html, 'own_key'), /plan-needs/, 'an own key on a plan needs nothing more');

  const platform = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  assertShows(card(platform.html(), 'platform'), '$240 of usage a month, 20% more than you pay. Task counts assume a typical mix on the default model.');
  platform.choose('platform', 'solo');
  assertShows(card(platform.html(), 'platform'), '$25 / month');
  assertShows(card(platform.html(), 'platform'), '$30 of usage a month, 20% more than you pay.');

  const keyGone = card((await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, ownKey: NEEDS_ANTHROPIC })).html(), 'own_key');
  assertShows(keyGone, 'Your default model needs an Anthropic API key. Add key');

  const plain: BillingSummary = { ...OWN_KEY_TEAM, offers: { ...OFFERS, rolloverMonths: 0, chatReplyFeeMicros: usd(0.05) } };
  const page = (await harness({ path: '/admin/plan', billingOffered: true, summary: plain })).html();
  assert.doesNotMatch(page, /rolls over|carries over/, 'no rollover, so nothing says it rolls over');
  assertHides(page, 'Chat replies included');
});

test('the own-key card lists what an own key still needs: the size it shows, and a key for the default model', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  const needs = card(page.html(), 'own_key');
  assertShows(needs, 'To switch Done: The $200 plan Not yet: An Anthropic API key, for your default model. Add key');
  assert.match(needs, /<a class="hint-link" href="\/admin\/settings\/providers\?return=plan">Add key<\/a>/);
  page.choose('own_key', 'growth');
  assertShows(card(page.html(), 'own_key'), 'Not yet: The $300 plan');

  const ownKey = card((await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_NO_PLAN, ownKey: NEEDS_ANTHROPIC })).html(), 'own_key');
  assertShows(ownKey, 'To do tasks Not yet: The $100 plan Not yet: An Anthropic API key, for your default model. Add key');
  assert.match(ownKey, /<a class="hint-link" href="\/admin\/settings\/providers">Add key<\/a>/, 'already on an own key, so nothing to switch on return');

  const keyed = card((await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_NO_PLAN, ownKey: KEYED })).html(), 'own_key');
  assertShows(keyed, 'Done: An Anthropic API key, for your default model');
  assertHides(keyed, 'Add key');

  const anyKey = card((await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, ownKey: { savedKeys: new Set(), defaultModel: undefined, agents: [] },
  })).html(), 'own_key');
  assertShows(anyKey, 'Not yet: A model provider API key. Add key');
});

test('an Owner on the plan with a saved key switches to it from its card only after confirming there', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, ownKey: KEYED });
  await page.click({ 'data-action': 'billing-switch-funding' });
  const confirming = card(page.html(), 'own_key');
  assertShows(confirming, 'Switch to your own key? Your provider bills you for tokens directly, and your plan pays for tasks. Cancel Switch to your own key');
  assert.doesNotMatch(confirming, /will stop replying/, 'no Agent is named when every pinned model has a key');
  assert.doesNotMatch(card(page.html(), 'platform'), /billing-funding-confirm/);
  await page.click({ 'data-action': 'billing-funding-cancel' });
  assertHides(page.html(), 'Switch to your own key?');
  assert.equal(cardStep(page.html(), 'own_key'), 'Switch to your own key [soft]');
  assert.deepEqual(fundingWrites(page.requests), [], 'nothing switches before the Owner confirms');

  await page.click({ 'data-action': 'billing-switch-funding' });
  page.choose('own_key', 'growth');
  assert.ok(!text(page.html()).includes('Switch to your own key?'), 'choosing another size closes the question');

  page.choose('own_key', 'team');
  await page.click({ 'data-action': 'billing-switch-funding' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/funding', { funding: 'own_key' }]]);
  assert.deepEqual(page.portCalls, [['chooseFunding', 'own_key']]);
  const html = page.html();
  assert.equal(lede(html), 'Your workspace is on the $200 plan with its own API key.', 'the page turns into the own-key view');
  assert.equal(cardTag(html, 'own_key'), 'Current plan');
  assert.equal(cardStep(html, 'own_key'), 'Your current plan (disabled)');
  assert.equal(cardStep(html, 'platform'), 'Switch to models included [soft]');
  assertShows(hero(html), '573 tasks left');
});

test('the confirmation names each Agent whose pinned model has no saved key, in the singular for one', async () => {
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { ...KEYED, agents: [{ name: 'Research', model: 'openai/gpt-5.6-terra' }, { name: 'Ops <Desk>', model: 'openrouter/openai/gpt-5.6-terra' }, { name: 'Writer' }] },
  });
  assert.doesNotMatch(page.html(), /will stop replying/, 'only the confirmation warns');
  await page.click({ 'data-action': 'billing-switch-funding' });
  assert.match(card(page.html(), 'own_key'), /and your plan pays for tasks\. These Agents will stop replying until a key is added for their model&rsquo;s provider: Research, Ops &lt;Desk&gt;\.<\/p>/);

  const one = await harness({
    path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN,
    ownKey: { ...KEYED, agents: [{ name: 'Research', model: 'openai/gpt-5.6-terra' }, { name: 'Writer' }] },
  });
  await one.click({ 'data-action': 'billing-switch-funding' });
  assert.match(card(one.html(), 'own_key'), /and your plan pays for tasks\. This Agent will stop replying until a key is added for its model&rsquo;s provider: Research\.<\/p>/);
  assertHides(one.html(), 'These Agents');
});

test('a switch to your own key that fails, or that the host refuses below the lowest plan for it, says so under the open confirmation', async () => {
  const cases: Array<[Error, string]> = [
    [new Error('The host is down.'), 'Could not switch to your own key. Try again.'],
    [new BillingRefusal('own_key_plan_required'), 'Your own API key needs the $100 plan or higher.'],
  ];
  for (const [failure, message] of cases) {
    const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, switchFails: failure });
    await page.click({ 'data-action': 'billing-switch-funding' });
    await page.click({ 'data-action': 'billing-funding-confirm' });
    assert.deepEqual(page.portCalls, [['chooseFunding', 'own_key']], 'Admin\'s own check passed and the host was asked');
    const ownKey = card(page.html(), 'own_key');
    const confirm = ownKey.indexOf('data-action="billing-funding-confirm">Switch to your own key</button>');
    assert.ok(confirm >= 0, 'the confirmation stays open and can be retried');
    assert.ok(ownKey.indexOf(`<p class="field-error" role="alert">${message}</p>`) > confirm, `"${message}" follows it`);
    assertHides(card(page.html(), 'platform'), message);
    assert.equal(billingReads(page.requests), 1, 'the plan is not read again');
  }
});

test('an Owner on their own key switches to models included from its card only after confirming there', async () => {
  const home = await harness({ path: '/admin/agents', billingOffered: true, summary: OWN_KEY_TEAM });
  assert.match(home.html(), /data-action="open-billing"[^>]*>Plan<\/button>/, 'the nav entry is there on your own key');
  assert.equal(home.requests.some((request) => request.path.startsWith('/admin/api/billing')), false, 'no billing read until the page opens');
  await home.click({ 'data-action': 'open-billing' });
  assert.equal(home.location.pathname, '/admin/plan');

  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM });
  await page.click({ 'data-action': 'billing-switch-funding' });
  assertShows(card(page.html(), 'platform'), 'Switch to models included? Replies will stop using your key and draw on your plan’s usage. Cancel Switch to models included');
  await page.click({ 'data-action': 'billing-funding-cancel' });
  assert.deepEqual(fundingWrites(page.requests), [], 'nothing switches before the Owner confirms');

  await page.click({ 'data-action': 'billing-switch-funding' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/funding', { funding: 'platform' }]]);
  assert.equal(lede(page.html()), 'Your workspace is on the $200 plan with models included.');
  assert.equal(cardStep(page.html(), 'platform'), 'Your current plan (disabled)', 'the card is current, and its select changes the plan');
  page.choose('platform', 'business');
  assert.equal(cardStep(page.html(), 'platform'), 'Change to the $500 plan [primary business]');
});

test('a switch to models included that fails keeps the confirmation open in its card with a retryable error', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, switchFails: new Error('The host is down.') });
  await page.click({ 'data-action': 'billing-switch-funding' });
  await page.click({ 'data-action': 'billing-funding-confirm' });
  const platform = card(page.html(), 'platform');
  assertShows(platform, 'Could not switch to models included. Try again.');
  assert.match(platform, /data-action="billing-funding-confirm">Switch to models included<\/button>/);
});

test('Add usage and Manage billing ask the host for a Stripe page and open the URL it returns', async () => {
  const extra = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  await extra.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_50' });
  assert.deepEqual(extra.assigned, ['https://checkout.stripe.com/c/pay/extra_usage_50']);
  assert.match(hero(extra.html()), /data-key="extra_usage_50"[^>]* disabled>Opening Stripe&hellip;<\/button>/, 'the busy button stays until the browser leaves');
  assert.match(hero(extra.html()), /data-key="extra_usage_25"[^>]* disabled>\$25<\/button>/, 'only the button pressed is opening');

  const portal = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  await portal.click({ 'data-action': 'billing-manage' });
  assert.deepEqual(portal.assigned, ['https://billing.stripe.com/p/session/portal']);
  assert.deepEqual([...extra.portCalls, ...portal.portCalls], [['checkout', { kind: 'extra_usage', key: 'extra_usage_50' }], ['portal']]);

  const down = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, stripeFails: new Error('Stripe is down.') });
  await down.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' });
  assertShows(hero(down.html()), 'Stripe could not be opened. Try again.');
  assert.match(hero(down.html()), /data-key="extra_usage_25"[^>]*>\$25<\/button>/, 'the button can be pressed again');
  assertHides(card(down.html(), 'platform'), 'Stripe could not be opened');
});

test('extra usage the host refuses for want of a plan says to choose one first, in the status card', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, stripeFails: new BillingRefusal('plan_required') });
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' });
  assert.match(hero(page.html()), /<p class="field-error" role="alert">Choose a plan first\. Extra usage is available while your workspace has a plan\. Choose a plan, then add extra usage\.<\/p>/);
  assertHides(page.html(), 'Stripe could not be opened');
  assert.deepEqual(page.assigned, []);
  assert.equal(billingReads(page.requests), 1, 'the plan is not read again');
});

test('usage this period shows a bar per Agent, scaled to the largest, with its avatar, and a toggle to people only when there are people', async () => {
  const agents = [{ id: 'agent_chickpea', name: 'Chickpea', slackPresence: { avatar: { url: 'https://cdn.example/chickpea.png' } } }];
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, agents })).html();
  assert.match(html, /<h2 class="section-title" id="plan-use-heading">Usage this period<\/h2><p class="hint">Since Oct 7\.<\/p>/);
  const rows = [...html.matchAll(/<li class="plan-use-row">(.*?)<\/li>/g)].map((row) => row[1]!);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /<img src="https:\/\/cdn\.example\/chickpea\.png" alt="">.*<span class="plan-use-name">Chickpea<\/span><span class="plan-use-track" aria-hidden="true"><span style="width: 100%"><\/span><\/span><span class="plan-use-amount">\$30\.25<\/span>/);
  assert.match(rows[1]!, /<span class="plan-use-avatar is-other" aria-hidden="true"><\/span><span class="plan-use-name">Other<\/span>.*width: 23%.*\$7</, 'use by no Agent or one gone gathers last');
  assert.match(html, /data-action="billing-use-by" data-by="agent" aria-pressed="true">By Agent<\/button>/);

  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  assert.match(page.html(), /<span class="plan-use-avatar is-letter" aria-hidden="true">C<\/span><span class="plan-use-name">Chickpea<\/span>/, 'an Agent Admin cannot show reads by its initial');
  await page.click({ 'data-action': 'billing-use-by', 'data-by': 'person' });
  assert.match(page.html(), /aria-pressed="true">By person<\/button>/);
  assertShows(page.html(), 'Maya Chen $31.50 Other $6');
  assertHides(page.html(), '$30.25');

  const agentsOnly = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, use: { ...TEAM_PLAN.use, byPerson: [] } } })).html();
  assert.doesNotMatch(agentsOnly, /billing-use-by/, 'a host that records no person shows no toggle');
  assertShows((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, use: { byAgent: [], byPerson: [] } } })).html(), 'No usage yet this period.');
  const noPeriod = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, use: { byAgent: [], byPerson: [] } } })).html();
  assert.match(noPeriod, /id="plan-use-heading">Usage<\/h2><\/div>/);
  assertShows(noPeriod, 'No usage yet.');
});

test('how usage works compares the two ways to pay, marks yours, and says what counts as a task', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN })).html();
  const how = html.slice(html.indexOf('id="plan-how-heading"'));
  assertShows(how, 'How usage works One plan covers your whole workspace. No seats.');
  assertShows(how, 'Models included Yours Your own API key Chat reply Model tokens at list price Included Task Model tokens + 30¢ 30¢ ' +
    'Who bills tokens Chickpea, on your plan Your provider, directly Plan sizes $25 to $500 a month $100 to $500 a month');
  assertShows(how, 'What counts as a task? A reply where an Agent works in your tools, like reading channels or documents, using connectors, or writing code. ' +
    'However many steps it takes, it’s one task and one 30¢ fee.');
  assertShows(how, '“Make this reply friendlier” Chat “Summarize #support and file the bugs in Linear” 1 task “Research three competitors’ pricing and write it up” 1 task');
  assertShows(how, '20% bonus usage on every plan Unused plan usage carries over one month Extra usage keeps 12 months');
  assert.match((await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM })).html(), /<th scope="col">Your own API key <span class="plan-yours">Yours<\/span><\/th>/);
  const chatFee = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, offers: { ...OFFERS, chatReplyFeeMicros: usd(0.05) } } })).html();
  assertShows(chatFee, 'Chat reply Model tokens + 5¢ 5¢');
});

test('a Member sees the status and that an Owner changes the plan, with no buttons, cards, use, or how usage works', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: TEAM_PLAN });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan', 'a Member may open the page');
  assert.equal(lede(html), 'Your workspace is on the $200 plan with models included.');
  assertShows(hero(html), 'This month $172 left About 375 tasks · Renews Nov 7');
  assertShows(hero(html), '+$20 carried over until Nov 7');
  assert.match(html, /<p class="plan-member-note"><span class="plan-chip-dot" aria-hidden="true"><\/span>An Owner can change the plan, add usage, or switch how your workspace pays for models\.<\/p>/);
  assert.match(html, /data-action="open-billing"[^>]*>Plan<\/button>/);
  assert.doesNotMatch(html, /data-action="billing-|<select|plan-card|plan-use|plan-how/);

  const ownKey = (await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: OWN_KEY_NO_PLAN })).html();
  assert.doesNotMatch(ownKey, /data-action="billing-|plan-card/);
});

test('the meter\'s dollar figures give its percentage', async () => {
  const meterFigures = (html: string) => {
    const match = /(\$[\d,]+(?:\.\d\d)?) of (\$[\d,]+(?:\.\d\d)?) plan usage/.exec(text(hero(html)));
    assert.ok(match, 'the page shows the meter');
    const dollars = (figure: string) => Number(figure.replace(/[$,]/g, ''));
    return { used: dollars(match[1]!), included: dollars(match[2]!), percent: Number(/aria-valuenow="(\d+)"/.exec(hero(html))?.[1]) };
  };
  const nonRound: BillingSummary = {
    ...TEAM_PLAN,
    planUsage: { usedMicros: 37_456_789 as UsageMicros, includedMicros: 60_000_000 as UsageMicros, onPacePercent: null },
  };
  const edge: BillingSummary = {
    ...TEAM_PLAN,
    planUsage: { usedMicros: 239_999_999 as UsageMicros, includedMicros: 240_000_000 as UsageMicros, onPacePercent: null },
  };
  for (const summary of [TEAM_PLAN, nonRound, edge]) {
    const { used, included, percent } = meterFigures((await harness({ path: '/admin/plan', billingOffered: true, summary })).html());
    assert.equal(Math.floor((used / included) * 100), percent, `${used} of ${included}`);
  }
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: nonRound })).html();
  assertShows(hero(html), '$37.45 of $60 plan usage');
  assertHides(html, 'On pace');
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: edge })).html()), '$239.99 of $240 plan usage');
});

test('every date reads as its UTC day, whatever timezone the server and browser run in', async () => {
  assert.equal(new Date('2026-11-07T23:30:00Z').getDate(), 8, 'this file runs where a late UTC hour is the next day');
  const edges: BillingSummary = {
    ...TEAM_PLAN,
    period: { start: new Date('2026-10-07T23:30:00Z'), end: new Date('2026-11-07T23:30:00Z') },
    rollover: { remainingMicros: usd(20), expiresAt: new Date('2026-11-07T23:30:00Z') },
    trial: { ...TRIAL_GRANT, expiresAt: new Date('2026-11-06T23:30:00Z') },
  };
  const plan = (await harness({ path: '/admin/plan', billingOffered: true, summary: edges })).html();
  assertShows(plan, 'Renews Nov 7');
  assertShows(plan, 'On pace for 80% by Nov 7');
  assertShows(plan, '+$20 carried over until Nov 7');
  assertShows(plan, 'Since Oct 7.');
  assertShows(plan, '+$32.50 trial usage until Nov 6');
  const frozen = (await harness({
    path: '/admin/plan', billingOffered: true,
    summary: { ...FROZEN, extraUsage: { ...FROZEN.extraUsage!, expiresAt: new Date('2027-10-07T23:30:00Z') } },
  })).html();
  assertShows(frozen, 'waits for a plan until Oct 7, 2027');
  // A day after the period's end, so a page that printed the period's end instead would read Nov 7.
  for (const at of [new Date('2026-11-08T00:30:00Z'), new Date('2026-11-08T23:30:00Z')]) {
    const ending = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, pendingChange: { kind: 'ends', at } } })).html();
    assertShows(hero(ending), '· Ends Nov 8');
    const changing = (await harness({
      path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, pendingChange: { ...TEAM_DOWNGRADING.pendingChange!, at } },
    })).html();
    assertShows(hero(changing), '· Changes to the Chickpea $50 plan on Nov 8');
  }
});

test('a plan the host cannot read says so, with a retry', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: UNREADABLE });
  assert.match(page.html(), /<p class="field-error">Your plan could not be loaded\.<\/p><button type="button" class="btn btn-ghost" data-action="billing-retry">Retry<\/button>/);
  assert.equal(lede(page.html()), '', 'a plan that could not be read is not described');
  await page.click({ 'data-action': 'billing-retry' });
  assert.equal(billingReads(page.requests), 2, 'Retry reads the plan again');
});

const BEFORE_KEY = 'Save a key for your default model’s provider to switch to your own key.';
const SWITCH_UNFINISHED = 'Your key is saved, but the switch to your own key did not finish. Go back to Plan to try again.';
const BACK_TO_PLAN = '<a class="btn btn-primary btn-sm" href="/admin/plan">Back to Plan</a></div>';
const OWN_KEY_LEDE = 'Your workspace is on the $200 plan with its own API key.';

test('sent from Plan, saving the default model\'s key switches to the own key once and returns to Plan', async () => {
  const page = await harness({ path: '/admin/settings/providers?return=plan', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC });
  assert.ok(page.html().includes(`<div class="callout"><span>Save a key for your default model&rsquo;s provider to switch to your own key.</span>${BACK_TO_PLAN}`));
  assert.deepEqual(billingWrites(page.requests), [], 'nothing switches before a key is saved');

  await page.saveKey('anthropic');
  assert.deepEqual(billingWrites(page.requests), [['POST', '/admin/api/billing/funding', { funding: 'own_key' }]]);
  assert.deepEqual(page.portCalls, [['chooseFunding', 'own_key']]);
  assert.equal(`${page.location.pathname}${page.location.search}`, '/admin/plan');
  assert.equal(lede(page.html()), OWN_KEY_LEDE);
  assert.equal(cardTag(page.html(), 'own_key'), 'Current plan');
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

/** Words the Plan page and onboarding never use. The Plan page says "models included", never "Chickpea's models". */
const FORBIDDEN_WORDS = /credit|refund|multiplier|cache|prefix|working reply/i;
const PLAN_ONLY_WORDS = /Chickpea(&rsquo;|’|')s models/;

test('no Plan page or onboarding state uses words the customer never sees', async () => {
  const states: Array<[string, Parameters<typeof harness>[0], Array<Record<string, string>>]> = [
    ['plan', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN }, [{ 'data-action': 'billing-switch-funding' }, { 'data-action': 'billing-use-by', 'data-by': 'person' }]],
    ['frozen', { path: '/admin/plan', billingOffered: true, summary: FROZEN }, []],
    ['trial beside a plan', { path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, trial: TRIAL_GRANT } }, []],
    ['trial without a plan', { path: '/admin/plan', billingOffered: true, summary: TRIAL }, []],
    ['plan with no period', { path: '/admin/plan', billingOffered: true, summary: PLAN_NO_PERIOD }, []],
    ['plan ending', { path: '/admin/plan', billingOffered: true, summary: TEAM_ENDING }, []],
    ['plan changing', { path: '/admin/plan', billingOffered: true, summary: TEAM_DOWNGRADING }, []],
    ['used up', { path: '/admin/plan', billingOffered: true, summary: STARTER_USED_UP }, []],
    ['own key used up', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_USED_UP }, []],
    ['member, plan with no period', { path: '/admin/plan', billingOffered: true, owner: false, summary: PLAN_NO_PERIOD }, []],
    ['own key without a plan', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_NO_PLAN }, [{ 'data-action': 'billing-switch-funding' }]],
    ['member, own key without a plan', { path: '/admin/plan', billingOffered: true, owner: false, summary: OWN_KEY_NO_PLAN }, []],
    ['below the minimum', { path: '/admin/plan', billingOffered: true, summary: STARTER_PLAN }, []],
    ['no plan', { path: '/admin/plan', billingOffered: true, summary: NO_PLAN }, []],
    ['member', { path: '/admin/plan', billingOffered: true, owner: false, summary: TEAM_PLAN }, []],
    ['own key on a plan', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM }, [{ 'data-action': 'billing-switch-funding' }]],
    ['unreadable', { path: '/admin/plan', billingOffered: true, summary: UNREADABLE }, []],
    ['needs a key', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, ownKey: NEEDS_ANTHROPIC }, []],
    ['extra usage refused for want of a plan', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, stripeFails: new BillingRefusal('plan_required') },
      [{ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' }]],
    ['a plan refused below the own-key plan', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, stripeFails: new BillingRefusal('own_key_plan_required') },
      [{ 'data-action': 'billing-choose-plan', 'data-key': 'plus', 'data-at': 'own_key' }]],
    ['own key refused below its plan', { path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN, switchFails: new BillingRefusal('own_key_plan_required') },
      [{ 'data-action': 'billing-switch-funding' }, { 'data-action': 'billing-funding-confirm' }]],
    ['models included refused', { path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM, switchFails: new Error('The host is down.') },
      [{ 'data-action': 'billing-switch-funding' }, { 'data-action': 'billing-funding-confirm' }]],
  ];
  for (const [label, options, clicks] of states) {
    const page = await harness(options);
    const plan = () => page.html().slice(page.html().indexOf('<main'));
    assert.doesNotMatch(page.html(), FORBIDDEN_WORDS, label);
    assert.doesNotMatch(plan(), PLAN_ONLY_WORDS, label);
    for (const target of clicks) {
      await page.click(target);
      assert.doesNotMatch(page.html(), FORBIDDEN_WORDS, `${label} after ${target['data-action']}`);
      assert.doesNotMatch(plan(), PLAN_ONLY_WORDS, `${label} after ${target['data-action']}`);
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
