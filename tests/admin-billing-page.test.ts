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
  type AutoTopUpUpdate,
  type BillingSummary,
  type PlatformBillingPort,
  type SavedCardResult,
  type UsageMicros,
} from '../src/config/platform-billing.ts';
import type { ProviderKeyId } from '../src/config/provider-keys.ts';
import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';
import {
  NO_PLAN, OFFERS, OWN_KEY_NO_PLAN, PERIOD, PLAN_NO_PERIOD, PLUS_HELD, STARTER_AT_LIMIT, STARTER_PLAN, STARTER_TOP_UP, STARTER_TOPPED, TEAM_DOWNGRADING,
  TEAM_ENDING, TEAM_PLAN, TOP_UP_OFFERS, TOP_UP_ON, TRIAL_GRANT, TWO_FEE_OFFERS, usd,
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

function fakePort(
  initial: BillingSummary,
  fails: { switch?: Error | undefined; stripe?: Error | undefined },
  extra: Partial<PlatformBillingPort> = {},
) {
  const calls: unknown[][] = [];
  let summary = initial;
  const port: PlatformBillingPort = {
    ...extra,
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
  return { port, calls, setSummary: (next: BillingSummary) => { summary = next; } };
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
  /** Port methods beyond the ones every host has: auto top-up, and purchases on the saved card. */
  port?: Partial<PlatformBillingPort>;
  /** Rewrites what the billing API answers, as a server from another release would. */
  billingResponse?: (path: string, body: unknown) => unknown;
  /** The tab's sessionStorage, which survives the trip to Stripe and back. */
  session?: Map<string, string>;
  /** Model providers reports Chickpea's models serving every provider, as on models included. */
  platformFunded?: boolean;
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
    querySelector(selector: string) {
      return { focus() { focused.push(selector); } };
    },
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
  const billing = options.summary ? fakePort(options.summary, { switch: options.switchFails, stripe: options.stripeFails }, options.port) : undefined;
  const focused: string[] = [];
  const ownKey = options.ownKey ?? KEYED;
  const savedKeys = new Set(ownKey.savedKeys);
  const billingApi = new Hono();
  billingApi.use('*', async (c, next) => {
    setRequestPrincipal(c.req.raw, principal);
    await next();
  });
  billingApi.route('/admin/api', createBillingAdminApi({
    agentNames: async () => new Map([
      ['agent_chickpea', 'Chickpea'], ['agent_research', 'Research'],
      ...(options.agents ?? []).map((agent) => { const { id, name } = agent as { id: string; name: string }; return [id, name] as [string, string]; }),
    ]),
    personNames: async () => new Map([['membership_maya', 'Maya Chen']]),
    ownKeyFacts: async () => ({ ...ownKey, savedKeys }),
    choseChickpeaModels: async () => undefined,
    actor: async () => ({ membershipId: principal.membershipId, slackUserId: 'U_OWNER' }),
  }));
  const fetch = async (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<FakeResponse> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path.startsWith('/admin/api/billing')) {
      configurePlatformBilling(billing?.port);
      const served = await billingApi.request(path, {
        method, headers: { 'content-type': 'application/json', ...init?.headers }, ...(init?.body ? { body: init.body } : {}),
      }, ENV);
      if (!options.billingResponse) return served;
      return response(options.billingResponse(path, JSON.parse(await served.text())), served.status);
    }
    if (path === '/admin/api/agents') return response({ agents: options.agents ?? [] });
    if (path === '/admin/api/assignments') return response({ assignments: [] });
    if (path === '/admin/api/models') {
      await modelsGate;
      return response({ providers: ['anthropic', 'openai', 'openrouter'].map((id) => ({ id, configured: false, suggestions: [] })) });
    }
    if (path === '/admin/api/slack-connection') return response({ connected: true, teamId: 'TACME', teamName: 'Acme' });
    if (path === '/admin/api/providers') {
      return response({ providers: (['anthropic', 'openai'] as const).map((id) => ({
        ...(savedKeys.has(id) ? { id, status: 'stored', modelCount: 2 } : { id, status: 'missing', modelCount: null }),
        ...(options.platformFunded ? { platformFunded: true } : {}),
      })) });
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
    sessionStorage: storage(options.session ?? new Map()),
  }, { filename: 'admin-billing-page-inline.js' });
  await flush();
  const click = async (attributes: Record<string, string>) => {
    listeners.click!({ target: actionTarget(attributes), preventDefault() {} });
    await flush();
  };
  /** Picks an option in a select by its action. */
  const select = async (action: string, value: string) => {
    listeners.change!({ target: actionTarget({ 'data-action': action }, value) });
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
    html: () => html, renders, timerDelays, requests, assigned, location, click, choose, select, saveKey, firePoll, serverHtml,
    portCalls: billing?.calls ?? [], releasePlatform: () => releasePlatform(), releaseModels: () => releaseModels(),
    setSummary: (next: BillingSummary) => billing?.setSummary(next), focused,
  };
}

function storage(entries: Map<string, string>) {
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
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

test('an Owner on the Team plan reads what is left of the plan, the tasks it covers, the meter, and a line each for what carried over and extra usage, with Add usage beside it', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: TEAM_PLAN });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan');
  assert.match(html, /<h1 class="page-title">Plan<\/h1>/);
  assert.match(html, /data-action="open-billing"[^>]*>Plan<\/button>/, 'the section switcher names the page');
  assert.match(html, /<span class="chan-name">Overview<\/span><span class="chan-meta">Models included<\/span>/);
  assert.equal(lede(html), 'Your workspace is on the $200 plan with models included.');
  assert.match(html, /data-action="billing-manage">Manage billing<\/button>/);
  const status = hero(html);
  assertShows(status, 'This month $132 left About 275 tasks · Renews Nov 7');
  assert.match(status, /role="meter" aria-label="Plan usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="53"><span class="plan-meter-fill" style="width: 53%"><\/span><span class="plan-meter-pace" style="left: 80%"><\/span>/);
  assertShows(status, '$128 of $240 plan usage On pace for 80% by Nov 7');
  assertShows(status, 'Includes $20 carried over from last month, which expires Nov 7.');
  assertShows(status, 'Plus $40 of extra usage for when this runs out. It keeps until Sep 14, 2027.');
  assert.doesNotMatch(status, /plan-chip|is-extra/, 'no chips and no extra usage bar while the plan has usage left');
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
      'Your Agents are paused. Add usage to keep them working, or they start again when your plan renews Nov 7.'],
    ['an own key', OWN_KEY_USED_UP, true,
      'Tasks are paused, and your Agents can still chat. Add usage to keep tasks going, or they start again when your plan renews Nov 7.'],
    ['a plan that ends', { ...STARTER_USED_UP, pendingChange: TEAM_ENDING.pendingChange }, true,
      'Your Agents are paused. Add usage to keep them working.'],
    ['a Member on models included', STARTER_USED_UP, false,
      'Your Agents are paused. An Owner can add usage to keep them working, or they start again when your plan renews Nov 7.'],
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

test('the plan\'s usage used up is not the workspace\'s: extra usage keeps the Agents working under its own bar, and debt counts against it', async () => {
  const planUsedUp: BillingSummary = {
    ...TEAM_PLAN,
    planUsage: { usedMicros: usd(240), includedMicros: usd(240), onPacePercent: null },
    rollover: null,
    extraUsage: { ...TEAM_PLAN.extraUsage!, remainingMicros: usd(42.1), totalMicros: usd(50) },
  };
  const working = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: planUsedUp })).html());
  assertShows(working, 'Your usage $42.10 left About 90 tasks');
  assertHides(working, 'This month');
  assertShows(working, '$240 of $240 plan usage Used up, renews Nov 7');
  assert.match(working, /class="plan-meter is-extra" role="meter" aria-label="Extra usage"[^>]*aria-valuenow="15"/);
  assertShows(working, '$7.90 of $50 extra usage $42.10 left, keeps until Sep 14, 2027');
  assertHides(working, 'Plus $42.10');
  assert.doesNotMatch(working, /is-out|plan-hero-alert|btn-primary/);
  const noTotal = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...planUsedUp, extraUsage: TEAM_PLAN.extraUsage } })).html());
  assert.doesNotMatch(noTotal, /is-extra/, 'with no total from the host there is no bar to fill');
  assertShows(noTotal, '$40 left, keeps until Sep 14, 2027');
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
  assertShows(beside, 'This month $164.50 left', );
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
  assertShows(status, 'Plus $40 of extra usage for when this runs out.');
  assert.doesNotMatch(status, /role="meter"|plan-hero-alert/);
  assertHides(status, 'Renews');
  assert.match(status, /billing-add-extra-usage/, 'extra usage stays on sale with a plan');
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, funding: 'own_key' } })).html()),
    'Each month 800 tasks a month $240 of usage a month · Your provider bills tokens');
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLAN_NO_PERIOD, pendingChange: TEAM_ENDING.pendingChange } })).html()),
    'About 500 tasks · Ends Nov 7');
});

test('a plan whose usage the host holds for the own key counts only what is left to spend, says why, and opens the switch', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: PLUS_HELD });
  const status = hero(page.html());
  assertShows(status, 'Your usage $32.50 left');
  assertHides(status, 'of usage a month');
  assertShows(status, 'Your $100 plan’s usage is held for your own API key. Switch to your own key to use it for 400 tasks.');
  assertShows(status, '+$32.50 trial usage');
  assert.match(status, /<button type="button" class="btn btn-primary btn-sm" data-action="billing-own-key-switch">Switch to your own key<\/button>/);

  await page.click({ 'data-action': 'billing-own-key-switch' });
  assert.match(card(page.html(), 'own_key'), /data-action="billing-funding-confirm"/, 'the own-key card asks to confirm the switch');
  assert.ok(page.focused.includes('[data-action="billing-funding-cancel"]'));
  await page.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(page.portCalls, [['chooseFunding', 'own_key']]);
  assertHides(page.html(), 'held for your own API key');
});

test('held plan usage sends an Owner without the key to add it first, and tells everyone else an Owner can switch', async () => {
  const keyless = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: PLUS_HELD, ownKey: NEEDS_ANTHROPIC })).html());
  assert.match(keyless, /<a class="btn btn-primary btn-sm" href="\/admin\/settings\/providers\?return=plan">Add your Anthropic key<\/a>/);
  assert.doesNotMatch(keyless, /billing-own-key-switch/);

  const member = hero((await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: PLUS_HELD })).html());
  assertShows(member, 'Your $100 plan’s usage is held for your own API key. An Owner can switch to your own key to use it.');
  assert.doesNotMatch(member, /billing-own-key-switch|return=plan/);

  const partial: BillingSummary = {
    ...PLUS_HELD, planUsage: { usedMicros: usd(10), includedMicros: usd(60), onPacePercent: null }, heldForOwnKey: { usageMicros: usd(60) },
  };
  const metered = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: partial })).html());
  assertShows(metered, '$60 of your $100 plan’s usage is held for your own API key. Switch to your own key to use it for 200 tasks.');
  assertShows(metered, '$10 of $60 plan usage');

  const onOwnKey = hero((await harness({ path: '/admin/plan', billingOffered: true, summary: { ...PLUS_HELD, funding: 'own_key' } })).html());
  assertHides(onOwnKey, 'held for your own API key');
});

test('with held plan usage and the trial used up, the page says the switch or extra usage keeps the Agents working, not auto top-up', async () => {
  const out: BillingSummary = { ...PLUS_HELD, trial: { ...TRIAL_GRANT, remainingMicros: usd(0) } };
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: out, port: { updateAutoTopUp: async () => {} } })).html();
  assertShows(hero(html), 'Your Agents are paused. Switch to your own key, or add usage, to keep them working.');
  assertHides(hero(html), 'while auto top-up adds usage');
  assertShows(html, 'Auto top-up starts with your plan’s usage, when you switch to your own key. Until then, your Agents pause when this usage runs out.');

  const member = (await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: out })).html();
  assertShows(hero(member), 'Your Agents are paused until an Owner switches to your own key or adds usage.');
});

test('a plan cancelled in Stripe\'s portal says when it ends, and a downgrade names the plan it changes to, in place of when it renews, to everyone', async () => {
  for (const owner of [true, false]) {
    const ending = hero((await harness({ path: '/admin/plan', billingOffered: true, owner, summary: TEAM_ENDING })).html());
    assertShows(ending, 'About 275 tasks · Ends Nov 7');
    assertHides(ending, 'Renews');
    const downgrading = hero((await harness({ path: '/admin/plan', billingOffered: true, owner, summary: TEAM_DOWNGRADING })).html());
    assertShows(downgrading, 'About 275 tasks · Changes to the Chickpea $50 plan on Nov 7');
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
  assertShows(hero(html), '440 tasks left');
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

test('a long usage list opens on the six largest rows, with a button for the rest', async () => {
  const named = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `agent_${index}`, name: `Agent ${index}` }));
  const summary = (agents: { id: string }[]) => ({ ...TEAM_PLAN, use: { byAgent: agents.map((agent, index) => ({ id: agent.id, usageMicros: usd(40 - index) })), byPerson: [] } });
  const names = (html: string) => [...html.matchAll(/<span class="plan-use-name">(.*?)<\/span>/g)].map((match) => match[1]);

  const nine = named(9);
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: summary(nine), agents: nine });
  assert.deepEqual(names(page.html()), ['Agent 0', 'Agent 1', 'Agent 2', 'Agent 3', 'Agent 4', 'Agent 5']);
  assert.match(page.html(), /data-action="billing-use-all" aria-expanded="false">Show all 9<\/button>/);
  await page.click({ 'data-action': 'billing-use-all' });
  assert.equal(names(page.html()).length, 9);
  assert.match(page.html(), /data-action="billing-use-all" aria-expanded="true">Show fewer<\/button>/);
  await page.click({ 'data-action': 'billing-use-all' });
  assert.equal(names(page.html()).length, 6);

  const seven = named(7);
  const whole = (await harness({ path: '/admin/plan', billingOffered: true, summary: summary(seven), agents: seven })).html();
  assert.equal(names(whole).length, 7, 'one row past six shows whole');
  assert.doesNotMatch(whole, /billing-use-all/);
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
  assertHides(how, 'paid from it');
  assert.match((await harness({ path: '/admin/plan', billingOffered: true, summary: OWN_KEY_TEAM })).html(), /<th scope="col">Your own API key <span class="plan-yours">Yours<\/span><\/th>/);
  const chatFee = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...TEAM_PLAN, offers: { ...OFFERS, chatReplyFeeMicros: usd(0.05) } } })).html();
  assertShows(chatFee, 'Chat reply Model tokens + 5¢ 5¢');
});

test('a Member sees the status and that an Owner changes the plan, with no buttons, cards, use, or how usage works', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, owner: false, summary: TEAM_PLAN });
  const html = page.html();
  assert.equal(page.location.pathname, '/admin/plan', 'a Member may open the page');
  assert.equal(lede(html), 'Your workspace is on the $200 plan with models included.');
  assertShows(hero(html), 'This month $132 left About 275 tasks · Renews Nov 7');
  assertShows(hero(html), 'Includes $20 carried over from last month, which expires Nov 7.');
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
  assertShows(plan, 'Includes $20 carried over from last month, which expires Nov 7.');
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

test('on models included, a saved key\'s provider card says the key waits for the switch, and links an Owner to it', async () => {
  const providerCard = (html: string, id: string) =>
    new RegExp(`<article class="prov-row provider-card[^"]*" data-provider-card="${id}">[\\s\\S]*?</article>`).exec(html)?.[0] ?? '';
  const owner = (await harness({ path: '/admin/settings/providers', billingOffered: true, summary: TEAM_PLAN, platformFunded: true })).html();
  const saved = providerCard(owner, 'anthropic');
  assertShows(saved, 'Your key is saved, but Chickpea’s models are in use. Switch to your own key on the Plan page to use it.');
  assert.match(saved, /<a class="hint-link" href="\/admin\/plan\?step=own-key">Switch to your own key<\/a>/);
  assertHides(saved, 'optional');
  assertShows(providerCard(owner, 'openai'), 'Chickpea’s models are in use. No API key needed. Your own API key is optional.');

  const admin = (await harness({ path: '/admin/settings/providers', billingOffered: true, admin: true, summary: TEAM_PLAN, platformFunded: true })).html();
  assertShows(providerCard(admin, 'anthropic'), 'Your key is saved, but Chickpea’s models are in use. An Owner can switch to your own key on the Plan page.');
  assert.doesNotMatch(providerCard(admin, 'anthropic'), /step=own-key/);
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

/** The When usage runs out card. */
function autoCard(html: string): string {
  const start = html.indexOf('<section class="plan-auto');
  assert.ok(start >= 0, 'the page shows the When usage runs out card');
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}

/** A host with auto top-up that records each update. */
function topUpHost(updates: AutoTopUpUpdate[]): Partial<PlatformBillingPort> {
  return { async updateAutoTopUp(_installationId, update) { updates.push(update); } };
}

test('an Owner on a plan reads auto top-up under the usage card: what it adds, its monthly limit, this month\'s top-ups, and the card it charges', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP });
  const html = page.html();
  assert.ok(html.indexOf('plan-hero') < html.indexOf('plan-auto') && html.indexOf('plan-auto') < html.indexOf('plan-card'), 'between the usage card and the plan cards');
  const card = autoCard(html);
  assertShows(card, 'When usage runs out Auto top-up On When your usage runs out, adds $50 of extra usage so your Agents keep working. Up to $50 a month. Extra usage keeps 12 months. Edit');
  assertShows(card, 'Top-ups this month: $0 of your $50 limit Limit resets Nov 7');
  assertShows(card, 'Top-ups are charged to Visa ending 4242, plus tax. Update card');
  assert.match(card, /<input type="checkbox" data-action="billing-top-up-toggle" aria-label="Auto top-up" checked>/);
  assertHides(card, 'You allow');
  assertShows(hero(html), 'This month $23.40 left About 50 tasks · Renews Nov 7');
});

test('editing auto top-up shows the authorization only when the pack or the limit rises, and Save sends the version the Owner agreed to', async () => {
  const updates: AutoTopUpUpdate[] = [];
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP, port: topUpHost(updates) });
  await page.click({ 'data-action': 'billing-top-up-edit' });
  let card = autoCard(page.html());
  assertShows(card, 'Adds extra usage when your plan’s usage runs out, up to a monthly limit. Extra usage keeps 12 months while you have a plan.');
  assertHides(card, 'paid from it');
  assertShows(card, 'Each time, add $25 $50 $100 About 100 tasks with models included');
  assert.deepEqual([...card.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((option) => decoded(option[3]!)),
    ['Same as your plan · $50 a month', '$100 a month', '$150 a month', '$200 a month', '$300 a month', '$500 a month']);
  assert.match(card, /data-key="extra_usage_100" disabled>\$100</, 'a pack larger than the limit could never fire');
  assertShows(card, 'Top-ups stop at the limit until your plan renews.');
  assertHides(card, 'You allow', );
  await page.select('billing-top-up-limit', '10000');
  card = autoCard(page.html());
  assertShows(card, 'You allow Chickpea to charge Visa ending 4242 up to $100 a month, plus tax, for extra usage. You can turn this off at any time. Cancel Save');
  await page.click({ 'data-action': 'billing-top-up-save' });
  assert.deepEqual(billingWrites(page.requests).at(-1), ['POST', '/admin/api/billing/auto-top-up',
    { change: 'on', pack: 'plan', limit: 10000, consentVersion: '2026-11-04' }]);
  assert.deepEqual(updates, [{
    change: { kind: 'on', pack: { rule: 'plan' }, limit: { rule: 'fixed', cents: 10000 } },
    by: { membershipId: 'membership_owner', slackUserId: 'U_OWNER' },
    consentVersion: '2026-11-04',
  }]);

  await page.click({ 'data-action': 'billing-top-up-edit' });
  await page.click({ 'data-action': 'billing-top-up-pack', 'data-key': 'extra_usage_25' });
  assertHides(autoCard(page.html()), 'You allow');
  await page.click({ 'data-action': 'billing-top-up-save' });
  assert.deepEqual(billingWrites(page.requests).at(-1), ['POST', '/admin/api/billing/auto-top-up', { change: 'on', pack: 'extra_usage_25', limit: 'plan' }]);
  assert.deepEqual(updates[1], {
    change: { kind: 'on', pack: { rule: 'fixed', key: 'extra_usage_25' }, limit: { rule: 'plan' } },
    by: { membershipId: 'membership_owner', slackUserId: 'U_OWNER' },
    consentVersion: null,
  }, 'a smaller pack raises nothing, so no consent is recorded');
});

test('turning auto top-up off works at once; turning it on opens its settings with the authorization, and nothing changes until the Owner confirms', async () => {
  const updates: AutoTopUpUpdate[] = [];
  const on = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP, port: topUpHost(updates) });
  await on.click({ 'data-action': 'billing-top-up-toggle' });
  assert.deepEqual(updates.map((update) => [update.change, update.consentVersion]), [[{ kind: 'off' }, null]]);

  const offSummary: BillingSummary = { ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, enabled: false, explicitlyOff: true } };
  const off = await harness({ path: '/admin/plan', billingOffered: true, summary: offSummary, port: topUpHost(updates) });
  let card = autoCard(off.html());
  assertShows(card, 'When usage runs out, your Agents pause until your plan renews Nov 7. Auto top-up Adds extra usage when your plan’s usage runs out, up to a monthly limit.');
  assert.match(card, /aria-label="Auto top-up">/, 'the switch is off');
  assertHides(card, 'Top-ups this month');
  await off.click({ 'data-action': 'billing-top-up-toggle' });
  card = autoCard(off.html());
  assertShows(card, 'You allow Chickpea to charge Visa ending 4242 up to $50 a month, plus tax, for extra usage. You can turn this off at any time. Cancel Turn on auto top-up');
  assert.equal(updates.length, 1, 'opening the settings charges and changes nothing');
  await off.click({ 'data-action': 'billing-top-up-cancel' });
  assertHides(autoCard(off.html()), 'You allow');
  await off.click({ 'data-action': 'billing-top-up-toggle' });
  await off.click({ 'data-action': 'billing-top-up-save' });
  assert.deepEqual(updates[1]!.change, { kind: 'on', pack: { rule: 'plan' }, limit: { rule: 'plan' } });
  assert.equal(updates[1]!.consentVersion, '2026-11-04');
});

test('the page sends the version of the authorization it shows, not one the API hands it, so a page from before the copy changed records no consent to text it never showed', async () => {
  const calls: unknown[][] = [];
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP,
    port: { ...topUpHost([]), ...savedCardHost(calls) },
    billingResponse: (_path, body) => JSON.parse(JSON.stringify(body).replaceAll('"2026-11-04"', '"2099-01-01"')),
  });
  await page.click({ 'data-action': 'billing-top-up-edit' });
  await page.select('billing-top-up-limit', '10000');
  assertShows(autoCard(page.html()), 'You allow Chickpea to charge Visa ending 4242 up to $100 a month');
  await page.click({ 'data-action': 'billing-top-up-save' });
  assert.deepEqual(billingWrites(page.requests).at(-1), ['POST', '/admin/api/billing/auto-top-up',
    { change: 'on', pack: 'plan', limit: 10000, consentVersion: '2026-11-04' }]);

  page.choose('platform', 'plus');
  await page.click({ 'data-action': 'billing-plan-change', 'data-key': 'plus', 'data-at': 'platform' });
  assertShows(card(page.html(), 'platform'), 'You allow Chickpea to charge Visa ending 4242 up to $100 a month');
  await page.click({ 'data-action': 'billing-plan-change-confirm' });
  assert.deepEqual(billingWrites(page.requests).at(-1), ['POST', '/admin/api/billing/plan-change', { key: 'plus', consentVersion: '2026-11-04' }]);

  const down = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP, port: savedCardHost(calls) });
  down.choose('platform', 'solo');
  await down.click({ 'data-action': 'billing-plan-change', 'data-key': 'solo', 'data-at': 'platform' });
  await down.click({ 'data-action': 'billing-plan-change-confirm' });
  assert.deepEqual(billingWrites(down.requests).at(-1), ['POST', '/admin/api/billing/plan-change', { key: 'solo' }],
    'a change that shows no authorization sends no version');
});

test('paused at the limit, the Owner reads why, Raise limit opens the settings, and the card compares the next plan in usage', async () => {
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_AT_LIMIT });
  const html = page.html();
  assert.equal(decoded(/<p class="plan-hero-alert" role="status">.*?<span>([^<]*)<\/span><\/p>/.exec(hero(html))?.[1] ?? ''),
    'Your Agents are paused. Auto top-up added its $50 limit for this month. Raise the limit or upgrade to keep them working, or they start again when your plan renews Nov 7.');
  const card = autoCard(html);
  assertShows(card, 'Auto top-up Limit reached When your usage runs out, adds $50 of extra usage');
  assert.match(card, /class="btn btn-primary btn-sm" data-action="billing-top-up-edit">Raise limit</);
  assertShows(card, 'Top-ups this month: $50 of your $50 limit Limit resets Nov 7');
  assert.match(card, /class="plan-meter is-out" role="meter" aria-label="Top-ups this month"/);
  assertShows(card, 'Your $50 plan and $50 of top-ups covered $110 of usage this month. The $100 plan includes $120 a month. See the $100 plan');
  await page.click({ 'data-action': 'billing-top-up-edit' });
  assertShows(autoCard(page.html()), 'Monthly limit');

  const largest: BillingSummary = {
    ...STARTER_AT_LIMIT,
    plan: { key: 'business', name: 'Business', priceCents: 50_000 },
    planUsage: { usedMicros: usd(600), includedMicros: usd(600), onPacePercent: null },
    autoTopUp: { ...TOP_UP_ON, pack: { rule: 'plan', key: 'extra_usage_100' }, limit: { rule: 'plan', cents: 50_000 }, usedCents: 50_000 },
  };
  const top = (await harness({ path: '/admin/plan', billingOffered: true, summary: largest })).html();
  assertShows(hero(top), 'Auto top-up added its $500 limit for this month. Raise the limit to keep them working, or they start again');
  assertHides(autoCard(top), 'See the');
});

test('with the plan used up and the limit reached, extra usage left keeps the Agents working and the card says no more top-ups this month', async () => {
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_TOPPED })).html();
  assertShows(hero(html), 'Your usage $42.10 left About 90 tasks');
  assertShows(hero(html), '$7.90 of $50 extra usage $42.10 left, keeps until Oct 28, 2027');
  const card = autoCard(html);
  assertShows(card, 'No more top-ups this month. When this extra usage runs out, your Agents pause until Nov 7. Auto top-up On');
  assert.match(card, /data-action="billing-top-up-edit">Edit</);
  assertHides(card, 'See the');
});

test('with a 25¢ task fee on plan usage and 30¢ on extra usage, plan cards and how usage works show 25¢, and a 0% bonus shows no bonus', async () => {
  const twoFees: BillingSummary = { ...TEAM_PLAN, offers: TWO_FEE_OFFERS, planUsage: { usedMicros: usd(128), includedMicros: usd(200), onPacePercent: 80 } };
  const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: twoFees })).html();
  assertShows(hero(html), 'This month $92 left About 225 tasks');
  const how = html.slice(html.indexOf('id="plan-how-heading"'));
  assertShows(how, 'Chat reply Model tokens at list price Included Task Model tokens + 25¢ 25¢ Who bills tokens');
  assertShows(how, 'it’s one task and one 25¢ fee.');
  assertShows(how, 'Unused plan usage carries over one month Extra usage keeps 12 months, and tasks paid from it are 30¢');
  assertShows(card(html, 'platform'), '$200 of usage a month. Task counts assume a typical mix on the default model.');
  assertShows(card(html, 'platform'), 'Model tokens at list price, no markup Unused usage rolls over for one month Every feature and connector');
  for (const which of ['platform', 'own_key'] as const) assertHides(card(html, which), '30¢');
  assertHides(html, 'bonus');
  assertHides(html, 'more than you pay');

  const ownKey = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...twoFees, funding: 'own_key' } })).html();
  assertShows(card(ownKey, 'own_key'), 'Your provider bills tokens, so the whole plan goes to tasks, 25¢ each.');
  assertShows(hero(ownKey), 'This month 368 tasks left');
});

test('with a 30¢ task fee on extra usage, auto top-up and buying extra usage say so, and count extra usage\'s tasks at 30¢', async () => {
  const twoFees: BillingSummary = { ...STARTER_TOP_UP, offers: TWO_FEE_OFFERS, planUsage: { usedMicros: usd(36.6), includedMicros: usd(50), onPacePercent: 96 } };
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: twoFees, port: savedCardHost([]) });
  assertShows(autoCard(page.html()), 'When your usage runs out, adds $50 of extra usage so your Agents keep working. Up to $50 a month. ' +
    'Extra usage keeps 12 months. Tasks paid from it are 30¢. Edit');
  await page.click({ 'data-action': 'billing-top-up-edit' });
  assertShows(autoCard(page.html()), 'Adds extra usage when your plan’s usage runs out, up to a monthly limit. ' +
    'Extra usage keeps 12 months while you have a plan. Tasks paid from it are 30¢.');
  assertShows(autoCard(page.html()), 'Each time, add $25 $50 $100 About 100 tasks with models included');
  await page.click({ 'data-action': 'billing-top-up-cancel' });
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_50' });
  assertShows(hero(page.html()), 'Add $50 of usage? It’s charged to Visa ending 4242, plus tax, and keeps 12 months. Tasks paid from it are 30¢. Cancel Add $50');

  const ownKey: BillingSummary = {
    ...twoFees,
    funding: 'own_key',
    plan: { key: 'plus', name: 'Plus', priceCents: 10_000 },
    planUsage: { usedMicros: usd(36.6), includedMicros: usd(100), onPacePercent: 64 },
    autoTopUp: { ...TOP_UP_ON, pack: { rule: 'plan', key: 'extra_usage_100' }, limit: { rule: 'plan', cents: 10_000 } },
  };
  assertShows(autoCard((await harness({ path: '/admin/plan', billingOffered: true, summary: ownKey })).html()),
    'On your own key your Agents can always chat. Only tasks use your plan, and $100 of extra usage is 333 tasks.');

  const topped: BillingSummary = { ...STARTER_TOPPED, offers: TWO_FEE_OFFERS, planUsage: { usedMicros: usd(50), includedMicros: usd(50), onPacePercent: null } };
  assertShows(hero((await harness({ path: '/admin/plan', billingOffered: true, summary: topped })).html()), 'Your usage $42.10 left About 90 tasks');
});

test('with two task fees, at the top-up limit the card compares the next plan\'s task fee, and says it covers this month only when its usage does', async () => {
  const starter: BillingSummary = { ...STARTER_AT_LIMIT, offers: TWO_FEE_OFFERS, planUsage: { usedMicros: usd(50), includedMicros: usd(50), onPacePercent: null } };
  assertShows(autoCard((await harness({ path: '/admin/plan', billingOffered: true, summary: starter })).html()),
    'Your $50 plan and $50 of top-ups covered $100 of usage this month. The $100 plan covers that as plan usage, at 25¢ a task instead of 30¢. See the $100 plan');
  const team: BillingSummary = {
    ...starter,
    plan: { key: 'team', name: 'Team', priceCents: 20_000 },
    planUsage: { usedMicros: usd(200), includedMicros: usd(200), onPacePercent: null },
    autoTopUp: { ...TOP_UP_ON, pack: { rule: 'plan', key: 'extra_usage_100' }, limit: { rule: 'plan', cents: 20_000 }, usedCents: 20_000 },
  };
  assertShows(autoCard((await harness({ path: '/admin/plan', billingOffered: true, summary: team })).html()),
    'Your $200 plan and $200 of top-ups covered $400 of usage this month. The $300 plan includes $300 a month, at 25¢ a task instead of 30¢. See the $300 plan');
});

test('a declined card pauses auto top-up: the Owner reads why and when, updates the card, and tries again once', async () => {
  const updates: AutoTopUpUpdate[] = [];
  const declined: BillingSummary = {
    ...STARTER_AT_LIMIT,
    autoTopUp: { ...TOP_UP_ON, pause: { kind: 'declined', at: new Date('2026-10-28T20:00:00Z') } },
  };
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: declined, port: topUpHost(updates) });
  const html = page.html();
  assertShows(hero(html), 'Your Agents are paused. Auto top-up couldn’t charge your card. Update it, or add usage, to keep them working.');
  const card = autoCard(html);
  assertShows(card, 'Auto top-up is paused because your card was declined. Auto top-up Paused');
  assertShows(card, 'Your card was declined on Oct 28, so auto top-up is paused. Update your card, then try again. Update card Try again');
  assert.equal([...card.matchAll(/data-action="billing-update-card"/g)].length, 1, 'the foot drops its own Update card');
  await page.click({ 'data-action': 'billing-top-up-retry' });
  assert.deepEqual(updates.map((update) => update.change), [{ kind: 'retry' }]);
  await page.click({ 'data-action': 'billing-update-card' });
  assert.deepEqual(page.assigned, ['https://billing.stripe.com/p/session/portal']);

  const unconfirmed = autoCard((await harness({
    path: '/admin/plan', billingOffered: true,
    summary: { ...declined, autoTopUp: { ...TOP_UP_ON, pause: { kind: 'needs_confirmation', amountCents: 5_000, url: 'https://invoice.stripe.com/i/test' } } },
  })).html());
  assertShows(unconfirmed, 'Your bank asked you to confirm a $50 charge. Confirm it to turn auto top-up back on. Confirm payment');
  assert.match(unconfirmed, /<a class="btn btn-primary btn-sm" data-action="billing-confirm-payment" href="https:\/\/invoice\.stripe\.com\/i\/test">/);
});

test('an Owner who pays with Link reads their Link account wherever the page names the card, never digits or "needs a saved card"', async () => {
  const link = { ...TOP_UP_ON, card: { kind: 'link' } } as const;
  const linked: BillingSummary = { ...STARTER_TOP_UP, autoTopUp: link };
  const calls: unknown[][] = [];
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: linked, port: { ...topUpHost([]), ...savedCardHost(calls) } });
  const auto = autoCard(page.html());
  assertShows(auto, 'Top-ups are charged to your Link account, plus tax. Update payment method');
  for (const hidden of ['needs a saved card', 'Update card', 'Add card', 'ending']) assertHides(auto, hidden);
  await page.click({ 'data-action': 'billing-top-up-edit' });
  await page.select('billing-top-up-limit', '10000');
  assertShows(autoCard(page.html()), 'You allow Chickpea to charge your Link account up to $100 a month, plus tax, for extra usage. You can turn this off at any time.');

  const upgrade = await harness({ path: '/admin/plan', billingOffered: true, summary: linked, port: savedCardHost(calls) });
  upgrade.choose('platform', 'plus');
  await flush();
  await upgrade.click({ 'data-action': 'billing-plan-change', 'data-key': 'plus', 'data-at': 'platform' });
  assertShows(card(upgrade.html(), 'platform'), 'You allow Chickpea to charge your Link account up to $100 a month, plus tax, for extra usage. Charged to your Link account, plus tax.');

  const atLimit: BillingSummary = { ...STARTER_AT_LIMIT, autoTopUp: { ...STARTER_AT_LIMIT.autoTopUp!, card: { kind: 'link' } } };
  const add = await harness({ path: '/admin/plan', billingOffered: true, summary: atLimit, port: savedCardHost(calls) });
  await add.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_50' });
  assertShows(hero(add.html()), 'Add $50 of usage? It’s charged to your Link account, plus tax, and keeps 12 months.');

  const paused = async (pause: NonNullable<NonNullable<BillingSummary['autoTopUp']>['pause']>) =>
    (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...STARTER_AT_LIMIT, autoTopUp: { ...link, pause } } })).html();
  const declined = await paused({ kind: 'declined', at: new Date('2026-10-28T20:00:00Z') });
  assertShows(hero(declined), 'Your Agents are paused. Auto top-up couldn’t charge your Link account. Update it, or add usage, to keep them working.');
  assertShows(autoCard(declined), 'Auto top-up is paused because your Link payment was declined. Auto top-up Paused');
  assertShows(autoCard(declined), 'Your Link payment was declined on Oct 28, so auto top-up is paused. Update your payment method, then try again. Update payment method Try again');
  const pastDue = await paused({ kind: 'past_due' });
  assertShows(hero(pastDue), 'Your plan’s last payment didn’t go through. Update your payment method to keep them working.');
  assertShows(autoCard(pastDue), 'Update your payment method to pay it. Update payment method');
  for (const html of [declined, pastDue]) assertHides(autoCard(html) + hero(html), 'card');

  const refused = await harness({
    path: '/admin/plan', billingOffered: true, summary: linked,
    port: { ...savedCardHost(calls), async changePlan() { throw new BillingRefusal('past_due'); } },
  });
  refused.choose('platform', 'plus');
  await flush();
  await refused.click({ 'data-action': 'billing-plan-change', 'data-key': 'plus', 'data-at': 'platform' });
  await refused.click({ 'data-action': 'billing-plan-change-confirm' });
  assertShows(refused.html(), 'Your plan\'s last payment didn\'t go through. Update your payment method in Manage billing, then try again.');
});

test('Admins and Members read only whether auto top-up is on and reached its limit: no amounts, card, or reasons', async () => {
  for (const role of [{ owner: false }, { admin: true }]) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_AT_LIMIT, ...role })).html();
    assertShows(hero(html), 'Your Agents are paused. An Owner can raise the auto top-up limit or upgrade to keep them working, or they start again when your plan renews Nov 7.');
    const card = autoCard(html);
    assertShows(card, 'When usage runs out Auto top-up On. Limit reached this month.');
    for (const hidden of ['$', 'Visa', '4242', 'declined', 'Edit', 'Raise']) assertHides(card, hidden);
    const declined = autoCard((await harness({
      path: '/admin/plan', billingOffered: true, ...role,
      summary: { ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, pause: { kind: 'declined', at: new Date('2026-10-28T20:00:00Z') } } },
    })).html());
    assertShows(declined, 'Auto top-up On');
    assertHides(declined, 'declined');
  }
  const off = autoCard((await harness({
    path: '/admin/plan', billingOffered: true, owner: false, summary: { ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, enabled: false } },
  })).html());
  assertShows(off, 'Auto top-up Off');
});

test('a cancelled plan turns auto top-up off until a new plan, and its switch is locked', async () => {
  const card = autoCard((await harness({
    path: '/admin/plan', billingOffered: true, summary: { ...STARTER_TOP_UP, pendingChange: { kind: 'ends', at: PERIOD.end } },
  })).html());
  assert.match(card, /class="plan-auto is-muted"/);
  assertShows(card, 'Your plan ends Nov 7, so auto top-up is off. Auto top-up Turned off when the plan was cancelled. It turns on again with a new plan.');
  assert.match(card, /aria-label="Auto top-up" disabled>/);
  assertHides(card, 'charged to');
});

test('on an own key, auto top-up states its pack in exact tasks', async () => {
  const ownKey: BillingSummary = {
    ...STARTER_TOP_UP,
    funding: 'own_key',
    plan: { key: 'plus', name: 'Plus', priceCents: 10_000 },
    planUsage: { usedMicros: usd(36.6), includedMicros: usd(120), onPacePercent: 64 },
    autoTopUp: { ...TOP_UP_ON, pack: { rule: 'plan', key: 'extra_usage_100' }, limit: { rule: 'plan', cents: 10_000 } },
  };
  const card = autoCard((await harness({ path: '/admin/plan', billingOffered: true, summary: ownKey })).html());
  assertShows(card, 'On your own key your Agents can always chat. Only tasks use your plan, and $100 of extra usage is 333 tasks.');
  assertShows(card, 'When your tasks run out, adds $100 of extra usage so your Agents keep working. Up to $100 a month.');
});

test('a trial says auto top-up turns on with a plan, and each plan card discloses it before Checkout', async () => {
  const trial: BillingSummary = { ...NO_PLAN, trial: TRIAL_GRANT, autoTopUp: null, offers: TOP_UP_OFFERS };
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: trial });
  const html = page.html();
  const auto = autoCard(html);
  assert.match(auto, /class="plan-auto is-muted"/);
  assertShows(auto, 'When usage runs out Auto top-up turns on with your plan. During the free trial, your Agents pause when its usage runs out.');
  assertHides(auto, 'Auto top-up On');
  page.choose('platform', 'starter');
  await flush();
  assertShows(card(page.html(), 'platform'), 'Choose the $50 plan Includes auto top-up. When the plan’s usage runs out, we add $50 of extra usage, up to $50 a month. You can change it any time.');
  page.choose('platform', 'team');
  await flush();
  assertShows(card(page.html(), 'platform'), 'we add $100 of extra usage, up to $200 a month.');
  assertShows(card(page.html(), 'own_key'), 'Includes auto top-up. When the plan’s usage runs out, we add $100 of extra usage, up to $100 a month.');
  const unsized = (await harness({ path: '/admin/plan', billingOffered: true, summary: { ...trial, offers: OFFERS } })).html();
  assertShows(card(unsized, 'platform'), 'Includes auto top-up. When the plan’s usage runs out, we add extra usage, up to $100 a month.');
});

test('a host with no auto top-up shows none of it: no card, no disclosure, no settings', async () => {
  for (const summary of [TEAM_PLAN, { ...NO_PLAN, trial: TRIAL_GRANT }, STARTER_USED_UP]) {
    const html = (await harness({ path: '/admin/plan', billingOffered: true, summary })).html();
    assertHides(html, 'When usage runs out');
    assertHides(html, 'auto top-up');
    assertHides(html, 'Auto top-up');
  }
});

/** A host that changes plans and sells extra usage on the saved card, recording each call. */
function savedCardHost(calls: unknown[][], result: SavedCardResult = { kind: 'done' }): Partial<PlatformBillingPort> {
  return {
    async previewPlanChange(_installationId, planKey) {
      calls.push(['preview', planKey]);
      return planKey === 'solo'
        ? { kind: 'downgrade', at: PERIOD.end }
        : { kind: 'upgrade', todayCents: 1_613, addedMicros: usd(19.35) };
    },
    async changePlan(_installationId, request) { calls.push(['changePlan', request]); return result; },
    async buyExtraUsage(_installationId, request) { calls.push(['buyExtraUsage', request]); return result; },
  };
}

test('with a host that changes plans on the saved card, an upgrade is confirmed in its card: today\'s charge, the usage it adds, and auto top-up\'s new limit', async () => {
  const calls: unknown[][] = [];
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP, port: savedCardHost(calls) });
  page.choose('platform', 'plus');
  await flush();
  assert.equal(cardStep(page.html(), 'platform'), 'Change to the $100 plan [primary plus]');
  await page.click({ 'data-action': 'billing-plan-change', 'data-key': 'plus', 'data-at': 'platform' });
  const platform = card(page.html(), 'platform');
  assertShows(platform, 'Move to the $100 plan? Today you pay $16.13 for the rest of this month, and $19.35 of usage is added right away. From Nov 7, it’s $100 a month with $120 of usage.');
  assertShows(platform, 'Auto top-up’s limit becomes $100 a month, the same as your new plan. You allow Chickpea to charge Visa ending 4242 up to $100 a month, plus tax, for extra usage.');
  assertShows(platform, 'Charged to Visa ending 4242, plus tax. Cancel Move to the $100 plan');
  await page.click({ 'data-action': 'billing-plan-change-confirm' });
  const changed = calls[1]![1] as { idempotencyKey: string };
  assert.deepEqual(calls, [['preview', 'plus'], ['changePlan', {
    planKey: 'plus', by: { membershipId: 'membership_owner', slackUserId: 'U_OWNER' }, consentVersion: '2026-11-04', idempotencyKey: changed.idempotencyKey,
  }]]);
  assert.match(changed.idempotencyKey, /^admin-ui:billing:plan_change:/);
  assert.deepEqual(page.assigned, [], 'paid on the saved card, with no Stripe page');
  assert.match(page.html(), /<p class="plan-banner" role="status">/);
  assertShows(page.html(), 'You’re on the $100 plan. $19.35 of usage was added for the rest of this month.');
});

test('an upgrade raises no limit an Owner fixed, a downgrade waits for the renewal, and a bank that asks to confirm opens Stripe\'s page', async () => {
  const calls: unknown[][] = [];
  const fixed: BillingSummary = {
    ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, pack: { rule: 'fixed', key: 'extra_usage_50' }, limit: { rule: 'fixed', cents: 20_000 } },
  };
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: fixed, port: savedCardHost(calls) });
  page.choose('platform', 'plus');
  await page.click({ 'data-action': 'billing-plan-change', 'data-key': 'plus', 'data-at': 'platform' });
  assertHides(card(page.html(), 'platform'), 'Auto top-up');
  await page.click({ 'data-action': 'billing-plan-change-confirm' });
  assert.equal((calls.at(-1)![1] as { consentVersion: string | null }).consentVersion, null);

  const packFollows = await harness({
    path: '/admin/plan', billingOffered: true, port: savedCardHost(calls),
    summary: { ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, limit: { rule: 'fixed', cents: 20_000 } } },
  });
  packFollows.choose('platform', 'plus');
  await packFollows.click({ 'data-action': 'billing-plan-change', 'data-key': 'plus', 'data-at': 'platform' });
  assertShows(card(packFollows.html(), 'platform'),
    'Auto top-up adds $100 each time on your new plan. You allow Chickpea to charge Visa ending 4242 up to $200 a month, plus tax, for extra usage.');
  await packFollows.click({ 'data-action': 'billing-plan-change-confirm' });
  assert.equal((calls.at(-1)![1] as { consentVersion: string | null }).consentVersion, '2026-11-04');

  const down = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP, port: savedCardHost(calls) });
  down.choose('platform', 'solo');
  await down.click({ 'data-action': 'billing-plan-change', 'data-key': 'solo', 'data-at': 'platform' });
  assertShows(card(down.html(), 'platform'), 'Move to the $25 plan on Nov 7? You keep this month’s usage until then. Cancel Move to the $25 plan');
  await down.click({ 'data-action': 'billing-plan-change-cancel' });
  assert.equal(cardStep(down.html(), 'platform'), 'Change to the $25 plan [primary solo]');

  const sca = await harness({
    path: '/admin/plan', billingOffered: true, summary: STARTER_TOP_UP,
    port: savedCardHost(calls, { kind: 'redirect', url: 'https://invoice.stripe.com/i/confirm' }),
  });
  sca.choose('platform', 'plus');
  await sca.click({ 'data-action': 'billing-plan-change', 'data-key': 'plus', 'data-at': 'platform' });
  await sca.click({ 'data-action': 'billing-plan-change-confirm' });
  assert.deepEqual(sca.assigned, ['https://invoice.stripe.com/i/confirm']);
});

test('with a host that sells on the saved card, Add usage asks to confirm in the usage card; without one, it opens Checkout as before', async () => {
  const calls: unknown[][] = [];
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_AT_LIMIT, port: savedCardHost(calls) });
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_50' });
  assertShows(hero(page.html()), 'Add $50 of usage? It’s charged to Visa ending 4242, plus tax, and keeps 12 months. Cancel Add $50');
  assert.deepEqual(calls, [], 'nothing is bought until the Owner confirms');
  await page.click({ 'data-action': 'billing-extra-usage-confirm', 'data-key': 'extra_usage_50' });
  const bought = calls[0]![1] as { idempotencyKey: string };
  assert.deepEqual(calls, [['buyExtraUsage', {
    key: 'extra_usage_50', by: { membershipId: 'membership_owner', slackUserId: 'U_OWNER' }, idempotencyKey: bought.idempotencyKey,
  }]]);
  assert.match(bought.idempotencyKey, /^admin-ui:billing:extra_usage:/);
  assertShows(page.html(), 'Added $50 of usage. Your Agents are working again.');

  const checkout = await harness({ path: '/admin/plan', billingOffered: true, summary: STARTER_AT_LIMIT });
  await checkout.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_50' });
  assert.deepEqual(checkout.assigned, ['https://checkout.stripe.com/c/pay/extra_usage_50']);
  const noCard = await harness({
    path: '/admin/plan', billingOffered: true, summary: { ...STARTER_AT_LIMIT, autoTopUp: { ...TOP_UP_ON, card: null } }, port: savedCardHost(calls),
  });
  await noCard.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' });
  assert.deepEqual(noCard.assigned, ['https://checkout.stripe.com/c/pay/extra_usage_25'], 'with no card to charge, Checkout takes it');
});

test('a Slack button\'s step opens its control on the Plan page, once', async () => {
  const calls: unknown[][] = [];
  const add = await harness({ path: '/admin/plan?step=add', billingOffered: true, summary: STARTER_AT_LIMIT, port: savedCardHost(calls) });
  assertShows(hero(add.html()), 'Add $50 of usage?');
  assert.equal(add.location.search, '', 'the step leaves the address once read');

  const raise = await harness({ path: '/admin/plan?step=raise-limit', billingOffered: true, summary: STARTER_AT_LIMIT });
  assertShows(autoCard(raise.html()), 'Monthly limit');
  const turnOn = await harness({
    path: '/admin/plan?step=auto-top-up', billingOffered: true, summary: { ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, enabled: false } },
  });
  assertShows(autoCard(turnOn.html()), 'Turn on auto top-up');

  const upgrade = await harness({ path: '/admin/plan?step=upgrade', billingOffered: true, summary: STARTER_AT_LIMIT, port: savedCardHost(calls) });
  assertShows(card(upgrade.html(), 'platform'), 'Move to the $100 plan?');
  const upgradeCheckout = await harness({ path: '/admin/plan?step=upgrade', billingOffered: true, summary: STARTER_USED_UP });
  assert.equal(cardLevels(upgradeCheckout.html(), 'platform').selected, 'plus', 'without in-app changes, the next plan is chosen in its card');
  assert.ok(upgradeCheckout.focused.includes('[data-action="billing-choose-plan"]'));

  const cardStepPage = await harness({
    path: '/admin/plan?step=card', billingOffered: true,
    summary: { ...STARTER_AT_LIMIT, autoTopUp: { ...TOP_UP_ON, pause: { kind: 'needs_confirmation', amountCents: 5_000, url: 'https://invoice.stripe.com/i/test' } } },
  });
  assert.ok(cardStepPage.focused.includes('[data-action="billing-confirm-payment"]'));
  const choose = await harness({ path: '/admin/plan?step=choose', billingOffered: true, summary: { ...NO_PLAN, trial: TRIAL_GRANT } });
  assert.ok(choose.focused.includes('[data-action="billing-choose-plan"]'));

  const member = await harness({ path: '/admin/plan?step=raise-limit', billingOffered: true, owner: false, summary: STARTER_AT_LIMIT });
  assertHides(member.html(), 'Monthly limit');
});

test('back from Stripe, the page says the payment is in while the usage is added, then what was added', async () => {
  const pending: BillingSummary = { ...STARTER_TOP_UP, lastPurchase: { kind: 'extra_usage', granted: false, usageMicros: usd(50) } };
  const page = await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: pending, manualPolls: true });
  assert.match(page.html(), /<p class="plan-banner is-wait" role="status">/);
  assertShows(page.html(), 'Payment received. Adding your usage…');
  page.setSummary({ ...pending, lastPurchase: { kind: 'extra_usage', granted: true, usageMicros: usd(50) } });
  await page.firePoll();
  assertShows(page.html(), 'Added $50 of usage.');
  assertHides(page.html(), 'Adding your usage');

  const first = await harness({
    path: '/admin/plan?billing=done', billingOffered: true,
    summary: { ...STARTER_TOP_UP, lastPurchase: { kind: 'plan', granted: true, first: true, addedMicros: usd(60) } },
  });
  assertShows(first.html(), 'You’re on the $50 plan, with $60 of usage this month. Auto top-up is on.');
  const upgraded = await harness({
    path: '/admin/plan?billing=done', billingOffered: true,
    summary: { ...STARTER_TOP_UP, lastPurchase: { kind: 'plan', granted: true, first: false, addedMicros: usd(19.35) } },
  });
  assertShows(upgraded.html(), 'You’re on the $50 plan. $19.35 of usage was added for the rest of this month.');

  const unreported = await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: STARTER_TOP_UP });
  assert.doesNotMatch(unreported.html(), /plan-banner/, 'a host that reports no purchase gets no banner');
  const cancelled = await harness({ path: '/admin/plan', billingOffered: true, summary: pending });
  assert.doesNotMatch(cancelled.html(), /plan-banner/, 'without billing=done, as after a cancelled Checkout, there is no banner');
});

test('back from Stripe with plan usage held for the own key, the banner says so instead of waiting for usage', async () => {
  const back = await harness({
    path: '/admin/plan?billing=done', billingOffered: true, manualPolls: true,
    summary: { ...PLUS_HELD, lastPurchase: { kind: 'plan', granted: false, first: true, newPeriod: true, addedMicros: usd(120) } },
  });
  assertShows(back.html(), 'You’re on the $100 plan. Its usage is held for your own API key.');
  assertHides(back.html(), 'Adding your usage');
  assert.ok(!back.timerDelays.includes(2000), 'nothing to wait for, so no poll');
});

test('back from the own-key card\'s Checkout still on models included, the banner offers the switch, or the key it needs first', async () => {
  const session = new Map<string, string>();
  const trial = await harness({ path: '/admin/plan', billingOffered: true, summary: { ...NO_PLAN, trial: TRIAL_GRANT }, session });
  await trial.click({ 'data-action': 'billing-choose-plan', 'data-key': 'plus', 'data-at': 'own_key' });
  assert.deepEqual(trial.portCalls, [['checkout', { kind: 'plan', key: 'plus' }]]);

  const bought: BillingSummary = {
    ...PLUS_HELD, heldForOwnKey: null, planUsage: { usedMicros: usd(0), includedMicros: usd(120), onPacePercent: null },
    lastPurchase: { kind: 'plan', granted: true, first: true, newPeriod: true, addedMicros: usd(120) },
  };
  const keyed = await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: bought, session: new Map(session) });
  assertShows(keyed.html(), 'You’re on the $100 plan, with $120 of usage this month. Auto top-up is on. To pay with your own key, switch to your own key.');
  assert.match(keyed.html(), /<span class="plan-banner-action"><button type="button" class="btn btn-primary btn-sm" data-action="billing-own-key-switch">/);
  await keyed.click({ 'data-action': 'billing-own-key-switch' });
  await keyed.click({ 'data-action': 'billing-funding-confirm' });
  assert.deepEqual(keyed.portCalls, [['chooseFunding', 'own_key']]);
  assert.doesNotMatch(keyed.html(), /plan-banner/, 'the switch settles the banner');

  const keyless = await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: bought, ownKey: NEEDS_ANTHROPIC, session: new Map(session) });
  assertShows(keyless.html(), 'To pay with your own key, add your key, then switch.');
  assert.match(keyless.html(), /<span class="plan-banner-action"><a class="btn btn-primary btn-sm" href="\/admin\/settings\/providers\?return=plan">Add your Anthropic key<\/a>/);

  const read = await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: bought, session });
  assert.match(read.html(), /plan-banner-action/);
  assert.equal(session.size, 0, 'the mark is read once');
  const again = await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: bought, session });
  assertHides(again.html(), 'To pay with your own key');

  const platformCard = new Map<string, string>(session);
  const other = await harness({ path: '/admin/plan', billingOffered: true, summary: { ...NO_PLAN, trial: TRIAL_GRANT }, session: platformCard });
  await other.click({ 'data-action': 'billing-choose-plan', 'data-key': 'plus', 'data-at': 'platform' });
  const fromPlatform = await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: bought, session: platformCard });
  assertShows(fromPlatform.html(), 'You’re on the $100 plan, with $120 of usage this month. Auto top-up is on.');
  assertHides(fromPlatform.html(), 'To pay with your own key');
});

test('?step=own-key opens the switch on the own-key card, or focuses its next step when the switch needs a plan or key first', async () => {
  const granted: BillingSummary = { ...PLUS_HELD, heldForOwnKey: null, planUsage: { usedMicros: usd(0), includedMicros: usd(120), onPacePercent: null } };
  const ready = await harness({ path: '/admin/plan?step=own-key', billingOffered: true, summary: granted });
  assert.match(card(ready.html(), 'own_key'), /data-action="billing-funding-confirm"/);
  assert.ok(ready.focused.includes('[data-action="billing-funding-cancel"]'));
  assert.equal(ready.location.search, '', 'the step is dropped from the address');

  const keyless = await harness({ path: '/admin/plan?step=own-key', billingOffered: true, summary: granted, ownKey: NEEDS_ANTHROPIC });
  assert.doesNotMatch(keyless.html(), /billing-funding-confirm/);
  assert.ok(keyless.focused.includes('.plan-card[aria-labelledby="plan-card-own_key"] .plan-card-action'));

  const onOwnKey = await harness({ path: '/admin/plan?step=own-key', billingOffered: true, summary: { ...granted, funding: 'own_key' } });
  assert.doesNotMatch(onOwnKey.html(), /billing-funding-confirm/);
});

test('back from Stripe after a plan that starts a new period, such as a resubscribe, the banner names the month\'s usage, not the rest of the month', async () => {
  const back = async (lastPurchase: NonNullable<BillingSummary['lastPurchase']>, summary: BillingSummary = STARTER_TOP_UP) =>
    (await harness({ path: '/admin/plan?billing=done', billingOffered: true, summary: { ...summary, lastPurchase } })).html();
  const resubscribed = await back({ kind: 'plan', granted: true, first: false, newPeriod: true, addedMicros: usd(60) });
  assertShows(resubscribed, 'You’re on the $50 plan, with $60 of usage this month. Auto top-up is on.');
  assertHides(resubscribed, 'rest of this month');
  const topUpOff = await back({ kind: 'plan', granted: true, first: false, newPeriod: true, addedMicros: usd(60) },
    { ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, enabled: false, explicitlyOff: true } });
  assertShows(topUpOff, 'You’re on the $50 plan, with $60 of usage this month.');
  assertHides(topUpOff, 'Auto top-up is on');
  assertShows(await back({ kind: 'plan', granted: true, first: false, newPeriod: false, addedMicros: usd(19.35) }),
    'You’re on the $50 plan. $19.35 of usage was added for the rest of this month.');
});

test('trying a saved-card purchase again after its answer was lost sends the same key, so the host charges once', async () => {
  const keys: (string | undefined)[] = [];
  let fail = true;
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: STARTER_AT_LIMIT,
    port: {
      async buyExtraUsage(_installationId, request) {
        keys.push(request.idempotencyKey);
        if (fail) { fail = false; throw new Error('the answer was lost'); }
        return { kind: 'done' };
      },
    },
  });
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_50' });
  await page.click({ 'data-action': 'billing-extra-usage-confirm', 'data-key': 'extra_usage_50' });
  assertShows(hero(page.html()), 'Usage could not be added. Try again.');
  await page.click({ 'data-action': 'billing-extra-usage-confirm', 'data-key': 'extra_usage_50' });
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  assertShows(page.html(), 'Added $50 of usage.');
  await page.click({ 'data-action': 'billing-add-extra-usage', 'data-key': 'extra_usage_25' });
  await page.click({ 'data-action': 'billing-extra-usage-confirm', 'data-key': 'extra_usage_25' });
  assert.notEqual(keys[2], keys[0], 'a new confirm is a new charge');
});

test('trying a paused top-up again after its answer was lost sends the same key; once the host answers, the next try is a new charge', async () => {
  const keys: (string | undefined)[] = [];
  let answers = 0;
  const declined: BillingSummary = {
    ...STARTER_AT_LIMIT,
    autoTopUp: { ...TOP_UP_ON, pause: { kind: 'declined', at: new Date('2026-10-28T20:00:00Z') } },
  };
  const page = await harness({
    path: '/admin/plan', billingOffered: true, summary: declined,
    port: {
      async updateAutoTopUp(_installationId, update) {
        keys.push(update.idempotencyKey);
        if (answers++ === 0) throw new Error('the answer was lost');
      },
    },
  });
  await page.click({ 'data-action': 'billing-top-up-retry' });
  assertShows(autoCard(page.html()), 'Auto top-up could not be changed. Try again.');
  await page.click({ 'data-action': 'billing-top-up-retry' });
  assert.equal(keys.length, 2);
  assert.match(keys[0] ?? '', /^admin-ui:billing:top_up_retry:/);
  assert.equal(keys[0], keys[1], 'the lost answer may have charged, so the host sees one key');
  await page.click({ 'data-action': 'billing-top-up-retry' });
  assert.equal(keys.length, 3);
  assert.notEqual(keys[2], keys[0], 'after an answer, trying again is a new charge');
});

test('an Owner who picked a pack follows the plan again by picking the plan\'s own pack', async () => {
  const updates: AutoTopUpUpdate[] = [];
  const fixed: BillingSummary = { ...STARTER_TOP_UP, autoTopUp: { ...TOP_UP_ON, pack: { rule: 'fixed', key: 'extra_usage_25' } } };
  const page = await harness({ path: '/admin/plan', billingOffered: true, summary: fixed, port: topUpHost(updates) });
  await page.click({ 'data-action': 'billing-top-up-edit' });
  await page.click({ 'data-action': 'billing-top-up-pack', 'data-key': 'extra_usage_50' });
  await page.click({ 'data-action': 'billing-top-up-save' });
  assert.deepEqual(billingWrites(page.requests).at(-1), ['POST', '/admin/api/billing/auto-top-up',
    { change: 'on', pack: 'plan', limit: 'plan', consentVersion: '2026-11-04' }]);
  assert.deepEqual(updates.map((update) => update.change), [{ kind: 'on', pack: { rule: 'plan' }, limit: { rule: 'plan' } }]);
  await page.click({ 'data-action': 'billing-top-up-edit' });
  await page.click({ 'data-action': 'billing-top-up-save' });
  assert.deepEqual(billingWrites(page.requests).at(-1)?.[2], { change: 'on', pack: 'extra_usage_25', limit: 'plan' },
    'an untouched fixed pack stays fixed');
});
