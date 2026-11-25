import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';

/**
 * Admin's "Agents in Slack" section and its token page, run in a VM against
 * a fake of the Owner-only API under /admin/api/slack-apps.
 */

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type Listener = (event: Record<string, unknown>) => void;

interface Row {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  slack: { state: string; reason?: string; attention?: string; cancellable?: boolean };
  waitsForOwnApp?: boolean;
  channels: Array<{ id: string; name: string | null; private: boolean; status: string }>;
}

const respond = (body: unknown, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(body); },
});

const row = (id: string, name: string, handle: string, state: string, extra: Partial<Row> = {}): Row => ({
  id, name, handle, avatarUrl: `https://chickpea.example/assets/agents/${id}/avatar/1`, slack: { state },
  channels: [], ...extra,
});

const salesChannels = [
  { id: 'C0SALES', name: 'sales', private: false, status: 'active' },
  { id: 'C0DEALS', name: 'deals', private: false, status: 'active' },
  { id: 'G0PIPE', name: 'pipeline-private', private: true, status: 'active' },
];

interface ApiState {
  setting: { mode: string; changedBy: string | null; changedAt: number | null };
  token: Record<string, unknown>;
  agents: Row[];
  /** The host does not let Chickpea create or change apps now. */
  paused?: boolean;
}

function apiState(overrides: Partial<ApiState> = {}): ApiState {
  return {
    setting: { mode: 'own_app', changedBy: 'UOWNER', changedAt: 1 },
    token: { stored: true, pastedBy: 'UOWNER', pastedAt: Date.UTC(2026, 10, 23, 12) },
    agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group', { channels: salesChannels })],
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function target(attributes: Record<string, string>) {
  return {
    closest(selector: string) { return selector === '[data-action]' && attributes['data-action'] ? this : null; },
    getAttribute(name: string) { return attributes[name] ?? null; },
  };
}

/** What a person reads: the markup without tags and attributes. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

async function harness(options: {
  offered?: boolean;
  api?: ApiState;
  path?: string;
  storage?: Record<string, string>;
  /** A clock and timers the test moves by hand; without it the page has no timers. */
  clock?: boolean;
  handle?: (path: string, method: string, body: unknown) => FakeResponse | Promise<FakeResponse | undefined> | undefined;
  /** More of the page's options, such as onboarding's. */
  page?: Parameters<typeof renderAdminPage>[0];
  /** The page opens in a tab the browser reports hidden, as a background or automation tab is. */
  hidden?: boolean;
} = {}) {
  const api = options.api ?? apiState();
  let html = '';
  const app = { className: '', get innerHTML() { return html; }, set innerHTML(value: string) { html = value; }, removeAttribute() {} };
  const focused: string[] = [];
  let activeElement: unknown = null;
  const field = { id: 'slack-apps-token', tagName: 'INPUT', value: '', disabled: false, focus() { focused.push('slack-apps-token'); activeElement = field; } };
  const body = { tagName: 'BODY' };
  const clock = { now: Date.UTC(2026, 10, 23, 15) };
  const timers: Array<{ due: number; run: () => void }> = [];
  class ClockDate extends Date {
    constructor(...args: [] | [number]) { if (args.length) super(args[0]); else super(clock.now); }
    static override now() { return clock.now; }
  }
  const listeners: Record<string, Listener> = {};
  const windowListeners: Record<string, Listener> = {};
  const requests: Array<{ path: string; method: string; body: unknown; fieldAtSend: string }> = [];
  const assigned: string[] = [];
  const storage = new Map(Object.entries(options.storage ?? {}));
  const location = {
    pathname: options.path ?? '/admin/destinations/slack/connection',
    search: '',
    assign(url: string) { assigned.push(url); },
  };
  const document = {
    getElementById(id: string) {
      if (id === 'app') return app;
      if (id === 'slack-apps-token') return html.includes('id="slack-apps-token"') ? field : null;
      return null;
    },
    get activeElement() { return activeElement ?? body; },
    visibilityState: options.hidden ? 'hidden' : 'visible',
    body,
    querySelector(selector: string) {
      if (selector === '.main-inner') return { set innerHTML(value: string) { throw new Error(`Admin failed to load: ${value}`); } };
      const control = /^\[data-(?:role|action)="([^"]+)"\]$/.exec(selector);
      if (control && html.includes(`="${control[1]}"`)) return { focus() { focused.push(control[1]!); } };
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type: string, listener: Listener) { if (!listeners[type]) listeners[type] = listener; },
  };
  const fetch = async (path: string, init?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body, fieldAtSend: field.value });
    const handled = await options.handle?.(path, method, body);
    if (handled) return handled;
    if (path === '/admin/api/slack-connection') return respond({ connected: true, teamId: 'TACME', teamName: 'Acme', health: 'healthy' });
    if (path === '/admin/api/agents') return respond({ agents: [] });
    if (path === '/admin/api/assignments') return respond({ assignments: [] });
    if (path === '/admin/api/models' || path === '/admin/api/providers') return respond({ providers: [] });
    if (path === '/admin/api/team') {
      return respond({ viewer: { membershipId: 'membership_owner' }, members: [
        { id: 'membership_owner', slackUserId: 'UOWNER', realName: 'Olivia Owner' },
        { id: 'membership_other', slackUserId: 'UOTHER', realName: 'Omar Owner' },
      ] });
    }
    if (path === '/admin/api/slack-apps' && method === 'GET') return respond(api);
    if (path === '/admin/api/slack-apps/mode' && method === 'PUT') {
      api.setting = { mode: (body as { mode: string }).mode, changedBy: 'UOWNER', changedAt: 2 };
      return respond({ setting: api.setting });
    }
    if (path === '/admin/api/slack-apps/token' && method === 'DELETE') {
      api.token = { stored: false };
      return respond({ token: api.token, removed: 'discarded' });
    }
    return respond({ error: 'not_found' }, 404);
  };
  const script = renderAdminPage({ agentSlackAppsOffered: options.offered !== false, ...options.page }).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    console, Date: options.clock ? ClockDate : Date, document, fetch, JSON, location, URL, URLSearchParams,
    history: {
      pushState(_state: unknown, _title: string, path: string) { location.pathname = new URL(path, 'https://chickpea.example').pathname; },
      replaceState(_state: unknown, _title: string, path: string) { location.pathname = new URL(path, 'https://chickpea.example').pathname; },
    },
    navigator: {},
    window: {
      addEventListener(type: string, listener: Listener) { if (!windowListeners[type]) windowListeners[type] = listener; },
      ...(options.clock ? {
        setTimeout(run: () => void, delay: number) {
          if (!delay) setImmediate(run);
          else timers.push({ due: clock.now + delay, run });
          return timers.length;
        },
      } : {}),
      localStorage: {
        getItem(key: string) { return storage.get(key) ?? null; },
        setItem(key: string, value: string) { storage.set(key, value); },
        removeItem(key: string) { storage.delete(key); },
      },
    },
  }, { filename: 'admin-slack-apps-page-inline.js' });
  await flush();
  const click = async (attributes: Record<string, string>) => {
    listeners.click!({ target: target(attributes) });
    await flush();
  };
  const paste = async (text: string, on: unknown = field) => {
    let prevented = false;
    listeners.paste!({ target: on, clipboardData: { getData: () => text }, preventDefault() { prevented = true; } });
    return prevented;
  };
  const submit = async () => {
    listeners.submit!({ target: { getAttribute: (name: string) => (name === 'data-action' ? 'slack-apps-token-form' : null) }, preventDefault() {} });
    await flush();
  };
  const focusWindow = async () => {
    windowListeners.focus!({});
    await flush();
  };
  /** Moves the clock and runs each timer that falls due, as the browser would. */
  const advance = async (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      timers.sort((a, b) => a.due - b.due);
      if (!timers.length || timers[0]!.due > until) break;
      const next = timers.shift()!;
      clock.now = next.due;
      next.run();
      await flush();
    }
    clock.now = until;
  };
  const pageshow = async (persisted: boolean) => {
    windowListeners.pageshow!({ persisted });
    await flush();
  };
  return {
    html: () => html, text: () => visibleText(html), api, field, body, focused, requests, assigned, storage, location, clock, timers,
    click, paste, submit, focusWindow, advance, pageshow, listeners,
    blur() { activeElement = null; },
  };
}

const sectionRequests = (requests: Array<{ path: string }>) => requests.filter((request) => request.path.startsWith('/admin/api/slack-apps'));

test('Agents in Slack is not on the page, and its API is never called, for anyone but an Owner where the host offers it', async () => {
  const notOffered = await harness({ offered: false });
  assert.match(notOffered.html(), /Connected workspace/);
  assert.doesNotMatch(notOffered.html(), /Agents in Slack/);
  assert.deepEqual(sectionRequests(notOffered.requests), []);

  const tokenPath = await harness({ offered: false, path: '/admin/destinations/slack/connection/token' });
  assert.doesNotMatch(tokenPath.html(), /Let Chickpea create Slack apps/);
  assert.deepEqual(sectionRequests(tokenPath.requests), []);

  const owner = await harness();
  assert.match(owner.html(), /Agents in Slack/);
  assert.equal(sectionRequests(owner.requests).length, 1);
});

test('off: one sentence and a button; with no token stored the button leads to the token page first', async () => {
  const page = await harness({ api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, token: { stored: false } }) });
  assert.match(page.text(), /Agents answer through the Chickpea app\. People mention them by @handle in channels Chickpea is in\./);
  assert.doesNotMatch(page.text(), /Still answering through the Chickpea app/, 'off lists only Agents with a move under way or done');
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  assert.equal(page.location.pathname, '/admin/destinations/slack/connection/token');
  assert.equal(page.requests.some((request) => request.path === '/admin/api/slack-apps/mode'), false, 'nothing turns on before a token is stored');
  const text = page.text();
  assert.match(text, /Let Chickpea create Slack apps for your Agents/);
  assert.match(text, /Slack needs one token from you\. You only do this once for Acme\./);
  assert.match(text, /Open Slack(’|&rsquo;)s app settings\./);
  assert.match(page.html(), /<a class="btn btn-soft btn-sm slack-token-open" href="https:\/\/api\.slack\.com\/apps" target="_blank" rel="noopener"/);
  assert.match(text, /Under Your App Configuration Tokens , choose Generate Token and pick Acme \./);
  assert.match(text, /If Slack already lists a token for Acme and Generate Token isn&#39;t available, copy that token&#39;s Refresh Token and paste it here\./);
  assert.match(text, /Copy the Refresh Token and paste it here\./);
  assert.match(page.html(), /class="slack-token-row highlighted"><span class="slack-token-label">Refresh Token</);
  assert.match(page.html(), /<input id="slack-apps-token" class="input mono" type="password"/);
  assert.doesNotMatch(page.html(), /<input id="slack-apps-token"[^>]* name=/, 'a form sent by the browser itself could carry no token');
  assert.match(text, /Starts with xoxe-/);
  assert.match(text, /Slack lets this token manage the Slack apps you created in Acme\. Chickpea only changes the apps it creates for your Agents\. It&#39;s stored encrypted, and you can remove it any time\./);
  assert.match(text, /These apps belong to you in Slack\. Like any Slack app you own, you can see what its bot can see: messages people send that Agent, and the channels it(’|&rsquo;)s in\./);
});

test('on with a token stored, the button turns the setting on directly', async () => {
  const page = await harness({ api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null } }) });
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  assert.deepEqual(page.requests.find((request) => request.path === '/admin/api/slack-apps/mode')?.body, { mode: 'own_app' });
  assert.equal(page.location.pathname, '/admin/destinations/slack/connection');
  assert.match(page.text(), /Each new Agent gets its own Slack app\./);
  assert.match(page.text(), /Stop creating Slack apps for new Agents/);
});

test('a paste is sent once, the field is empty before it leaves, and success turns the setting on', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const page = await harness({
    api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, token: { stored: false } }),
    handle: async (path, method) => {
      if (path !== '/admin/api/slack-apps/token' || method !== 'PUT') return undefined;
      await held;
      return respond({ token: { stored: true, pastedBy: 'UOWNER', pastedAt: 3 } });
    },
  });
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  page.field.value = '';
  assert.equal(await page.paste('  xoxe-1-a-good-refresh-token  '), true, 'the paste never lands in the field');
  await flush();
  const sent = page.requests.filter((request) => request.path === '/admin/api/slack-apps/token');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body, { refreshToken: 'xoxe-1-a-good-refresh-token' });
  assert.equal(sent[0]!.fieldAtSend, '');
  assert.match(page.text(), /Checking with Slack/);
  assert.match(page.html(), /<input id="slack-apps-token"[^>]* disabled>/);
  await page.paste('xoxe-1-a-good-refresh-token');
  await flush();
  assert.equal(page.requests.filter((request) => request.path === '/admin/api/slack-apps/token').length, 1, 'a second paste while checking sends nothing');
  release();
  await flush();
  assert.deepEqual(page.requests.find((request) => request.path === '/admin/api/slack-apps/mode')?.body, { mode: 'own_app' });
  assert.match(page.text(), /Connected\. From now on, each new Agent gets its own Slack app\./);
  assert.doesNotMatch(page.html(), /xoxe-1-a-good/);
  await page.click({ 'data-action': 'slack-apps-token-back' });
  assert.equal(page.location.pathname, '/admin/destinations/slack/connection');
});

for (const [name, status, error, pasted, sentence] of [
  ['the Access Token', 400, 'not_refresh_token', 'xoxe.xoxp-1-access', "That's the Access Token. Copy the Refresh Token next to it."],
  ['something else', 400, 'not_refresh_token', 'hello', "That isn't a refresh token. Copy the Refresh Token, which starts with xoxe-."],
  ['a token for another workspace', 400, 'other_workspace', 'xoxe-1-other', 'That token is for a different Slack workspace and can no longer be used. Generate a new one for Acme.'],
  ['a token Slack refuses', 400, 'rejected', 'xoxe-1-refused', "Slack didn't accept that token. Generate a new one and paste its Refresh Token."],
  ['a paste while Slack is down', 503, 'slack_down', 'xoxe-1-down', "Slack didn't answer. Try again in a minute."],
] as const) {
  test(`the token page answers ${name} in words, and keeps nothing`, async () => {
    const page = await harness({
      path: '/admin/destinations/slack/connection/token',
      handle: (path, method) => path === '/admin/api/slack-apps/token' && method === 'PUT' ? respond({ error }, status) : undefined,
    });
    await page.paste(pasted);
    await flush();
    assert.ok(page.html().includes(`<p class="field-error" id="slack-apps-token-status" role="alert">${sentence.replace(/'/g, '&#39;')}</p>`), page.text());
    assert.match(page.html(), /class="input mono input-error"/);
    assert.equal(page.field.value, '');
    assert.equal(page.html().includes(pasted), false);
    assert.equal(page.requests.some((request) => request.path === '/admin/api/slack-apps/mode'), false);
  });
}

test('the list shows each Slack state with its action and never an internal identifier', async () => {
  const page = await harness({ api: apiState({ agents: [
    row('agent_new', 'Scout', 'scout', 'not_in_slack', { channels: [{ id: 'C0PEND', name: 'launch', private: false, status: 'pending' }] }),
    row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group', { channels: salesChannels }),
    row('agent_making', 'Standup', 'standup', 'creating'),
    row('agent_ready', 'Helpdesk', 'helpdesk', 'waiting_for_allow'),
    row('agent_switch', 'Billing', 'billing', 'switching'),
    row('agent_token', 'Recruiting', 'recruiting', 'needs_attention', { slack: { state: 'needs_attention', reason: 'config_token_needed' } }),
    row('agent_busy', 'Ops', 'ops', 'needs_attention', { slack: { state: 'needs_attention', reason: 'slack_busy' } }),
    row('agent_undo', 'Legal', 'legal', 'cancelling'),
    row('agent_support', 'Support', 'support', 'own_app', { avatarUrl: null, channels: [{ id: 'C0HELP', name: 'help', private: false, status: 'active' }] }),
  ] }) });
  const html = page.html();
  const text = page.text();
  const order = ['Not in Slack yet', 'Still answering through the Chickpea app', 'With their own Slack app'].map((title) => html.indexOf(`>${title}<`));
  assert.ok(order.every((index) => index > 0) && order[0]! < order[1]! && order[1]! < order[2]!, 'three headings, in order');
  assert.ok(html.indexOf('>Support<') > order[2]!, 'a moved Agent is listed under its own heading');
  assert.match(html, /data-action="slack-apps-start" data-agent="agent_new"[^>]*>Add Scout to Slack</);
  assert.doesNotMatch(text, /@scout/, 'an Agent not in Slack yet has no handle');
  assert.match(html, /data-action="slack-apps-start" data-agent="agent_sales"[^>]*>Move to its own app</);
  assert.match(text, /#sales #deals/);
  assert.match(html, /<span class="slack-apps-channel"><svg[^>]*>.*?<\/svg>pipeline-private<\/span>/);
  assert.match(text, /Creating Standup(’|&rsquo;)s Slack app/);
  assert.match(text, /Ready\. Add Helpdesk to Slack to finish\. Helpdesk keeps answering as it does now until you finish\./);
  assert.match(html, /class="btn btn-primary btn-sm" data-action="slack-apps-start" data-agent="agent_ready"[^>]*>Add Helpdesk to Slack</);
  assert.match(html, /data-action="slack-apps-cancel" data-agent="agent_ready"/);
  assert.match(text, /Moving Billing/);
  assert.match(text, /Chickpea needs a new Slack token to finish Recruiting&#39;s app\./);
  assert.match(html, /data-action="slack-apps-token-open" data-agent="agent_token"[^>]*>Add a token</);
  assert.match(text, /Slack is limiting how fast apps are set up\. Wait a minute, then choose Try again\./);
  assert.match(html, /data-action="slack-apps-start" data-agent="agent_busy"[^>]*>Try again</);
  assert.match(text, /Support @support #help Its own Slack app/);
  assert.match(text, /You added Chickpea&#39;s Slack token on Nov 23, 2026\./);
  for (const internal of [
    /agent_[a-z]+/, /\bC0[A-Z]+\b/, /\bG0PIPE\b/, /UOWNER/, /user_group|not_in_slack|waiting_for_allow|needs_attention|own_app|cancelling|config_token_needed|slack_busy/,
  ]) {
    assert.doesNotMatch(text, internal);
  }
});

// Defect caught: with the setting off, an Agent never published was listed as not in Slack yet with a control to give
// it an app of its own, while every Agent answering through a user group was hidden.
test('off, only Agents with an app of their own or one on its way are listed; on, one not in Slack yet keeps its control', async () => {
  const agents = [
    row('agent_new', 'Scout', 'scout', 'not_in_slack'),
    row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group', { channels: salesChannels }),
    row('agent_ready', 'Helpdesk', 'helpdesk', 'waiting_for_allow'),
    row('agent_support', 'Support', 'support', 'own_app'),
  ];
  const off = await harness({ api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, agents }) });
  assert.doesNotMatch(off.text(), /Not in Slack yet|Scout|Sales Desk/);
  assert.doesNotMatch(off.html(), /data-agent="agent_new"/);
  assert.match(off.html(), /data-action="slack-apps-start" data-agent="agent_ready"[^>]*>Add Helpdesk to Slack</);
  assert.match(off.text(), /Support @support/);

  const on = await harness({ api: apiState({ agents }) });
  assert.match(on.html(), />Not in Slack yet</);
  assert.match(on.html(), /data-action="slack-apps-start" data-agent="agent_new"[^>]*>Add Scout to Slack</);
});

test('the press sends the browser to the Allow URL Start returns, and the result shows once on return', async () => {
  const page = await harness({
    handle: (path) => path === '/admin/api/slack-apps/agents/agent_sales/start'
      ? respond({ next: 'authorize', authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=1.2&state=s', agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow') })
      : undefined,
  });
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.deepEqual(page.requests.find((request) => request.path.endsWith('/start'))?.body, {});
  assert.deepEqual(page.assigned, ['https://slack.com/oauth/v2/authorize?client_id=1.2&state=s']);

  const moved = apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'own_app', { channels: salesChannels })] });
  const back = await harness({ api: moved, storage: Object.fromEntries(page.storage) });
  assert.match(back.text(), /Sales Desk is now its own Slack app\. People keep using @sales-desk\. In #pipeline-private it keeps answering through Chickpea until someone there adds it\./);
  assert.doesNotMatch(back.text(), /joined/, 'which Channels the bot joined is the Owner\'s message in Slack to say');
  const again = await harness({ api: moved, storage: Object.fromEntries(back.storage) });
  assert.doesNotMatch(again.text(), /is now its own Slack app/);
});

test('a press that needs a token leads to the token page, and one that needs permission says so on the row', async () => {
  const tokenNeeded = await harness({
    handle: (path) => path.endsWith('/start') ? respond({ error: 'token_needed' }, 409) : undefined,
  });
  await tokenNeeded.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.equal(tokenNeeded.location.pathname, '/admin/destinations/slack/connection/token');
  assert.deepEqual(tokenNeeded.assigned, []);

  const permission = await harness({
    handle: (path) => path.endsWith('/start') ? respond({ error: 'permission_needed' }, 409) : undefined,
  });
  await permission.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.match(permission.text(), /Chickpea needs one more Slack permission to give @sales-desk its own Slack app\. Choose Update in Slack at the top of this page, then try again\./);
});

test('Cancel puts the Agent back as Start found it', async () => {
  const page = await harness({
    api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow')] }),
    handle: (path) => path.endsWith('/cancel') ? respond({ agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group') }) : undefined,
  });
  await page.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  assert.match(page.html(), /data-agent="agent_sales"[^>]*>Move to its own app</);
});

test('turning the setting off keeps the token, and removing the token is its own control', async () => {
  const page = await harness();
  await page.click({ 'data-action': 'slack-apps-turn-off' });
  assert.match(page.text(), /Stop creating Slack apps for new Agents\? New Agents will answer through the Chickpea app\. Agents that already have their own Slack app keep it\./);
  assert.doesNotMatch(page.text().split('Stop creating Slack apps for new Agents?')[1]!, /token/i, 'turning off does not mention the token');
  await page.click({ 'data-action': 'slack-apps-confirm-apply' });
  assert.deepEqual(page.requests.find((request) => request.path === '/admin/api/slack-apps/mode')?.body, { mode: 'shared' });
  assert.equal(page.requests.some((request) => request.method === 'DELETE'), false);
  assert.match(page.text(), /You added Chickpea&#39;s Slack token on Nov 23, 2026\. Remove token/, 'the token stays, with its own control');

  await page.click({ 'data-action': 'slack-apps-token-remove' });
  assert.match(page.text(), /Remove the Slack token\?/);
  await page.click({ 'data-action': 'slack-apps-confirm-apply' });
  assert.equal(page.requests.filter((request) => request.method === 'DELETE' && request.path === '/admin/api/slack-apps/token').length, 1);
  assert.match(page.text(), /Chickpea deleted its copy of your configuration token and retired that token at Slack\./);
  assert.doesNotMatch(page.text(), /Remove token/);
});

test('the section names who added the token, and an Owner it cannot name stays unnamed', async () => {
  const other = await harness({ api: apiState({ token: { stored: true, pastedBy: 'UOTHER', pastedAt: Date.UTC(2026, 10, 2, 12) } }) });
  assert.match(other.text(), /Omar Owner added Chickpea&#39;s Slack token on Nov 2, 2026\./);
  const unknown = await harness({ api: apiState({ token: { stored: true, pastedBy: 'UGONE', pastedAt: null } }) });
  assert.match(unknown.text(), /An Owner added Chickpea&#39;s Slack token\./);
  assert.doesNotMatch(unknown.text(), /UGONE/);
});

test('a typed token is emptied from the field before it is sent; reached from a link, success changes no setting', async () => {
  const page = await harness({
    path: '/admin/destinations/slack/connection/token',
    api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, token: { stored: false } }),
    handle: (path, method) => path === '/admin/api/slack-apps/token' && method === 'PUT' ? respond({ token: { stored: true } }) : undefined,
  });
  page.field.value = 'xoxe-1-typed-refresh-token';
  await page.submit();
  const sent = page.requests.filter((request) => request.path === '/admin/api/slack-apps/token');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body, { refreshToken: 'xoxe-1-typed-refresh-token' });
  assert.equal(sent[0]!.fieldAtSend, '');
  assert.equal(page.requests.some((request) => request.path === '/admin/api/slack-apps/mode'), false);
  assert.match(page.text(), /Connected\. Continue/);
  assert.doesNotMatch(page.text(), /From now on/);
});

test("the browser follows only Slack's own Allow URL", async () => {
  for (const authorizeUrl of [
    'http://slack.com/oauth/v2/authorize', 'https://slack.com.example/oauth/v2/authorize', 'https://example.com/?next=https://slack.com',
    'javascript:alert(1)', '',
  ]) {
    const page = await harness({
      handle: (path) => path.endsWith('/start')
        ? respond({ next: 'authorize', authorizeUrl, agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow') })
        : undefined,
    });
    await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
    assert.deepEqual(page.assigned, [], authorizeUrl);
    assert.match(page.text(), /Chickpea couldn(&#39;|')t reach Slack\. Try again in a minute\./);
  }
});

test('leaving the token page for another Slack tab shows that tab, not the token page again', async () => {
  const page = await harness({ path: '/admin/destinations/slack/connection/token' });
  assert.match(page.text(), /Let Chickpea create Slack apps for your Agents/);
  await page.click({ 'data-action': 'toggle-add-channel' });
  assert.doesNotMatch(page.text(), /Let Chickpea create Slack apps for your Agents/);
  assert.equal(page.location.pathname, '/admin/destinations/slack/channels');
});

test('the section shows a change made elsewhere when the Owner comes back to the window', async () => {
  const page = await harness();
  assert.match(page.html(), /data-agent="agent_sales"[^>]*>Move to its own app</);
  page.api.agents = [row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow')];
  page.api.setting = { mode: 'shared', changedBy: 'UOTHER', changedAt: 2 };
  await page.focusWindow();
  assert.match(page.text(), /Ready\. Add Sales Desk to Slack to finish\./);
  assert.match(page.text(), /Agents answer through the Chickpea app\./);
});

test('a read already on its way never undoes a Cancel that answered after it left', async () => {
  let release: (response: FakeResponse) => void = () => {};
  let reads = 0;
  const page = await harness({
    api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow')] }),
    handle: (path, method) => {
      if (path.endsWith('/cancel')) return respond({ agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group') });
      if (path !== '/admin/api/slack-apps' || method !== 'GET') return undefined;
      reads += 1;
      return reads === 2 ? new Promise<FakeResponse>((resolve) => { release = resolve; }) : undefined;
    },
  });
  await page.focusWindow();
  assert.equal(reads, 2, 'the second read is on its way');
  await page.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  release(respond(apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow')] })));
  await flush();
  assert.match(page.html(), /data-agent="agent_sales"[^>]*>Move to its own app</);
  assert.doesNotMatch(page.text(), /Ready\. Add Sales Desk/);
});

test('the result says what is new: a move keeps the handle, an add is now in Slack, and a press the page cannot place says neither', async () => {
  const pressed = async (state: string) => {
    const page = await harness({
      api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', state, { channels: salesChannels })] }),
      handle: (path) => path.endsWith('/start')
        ? respond({ next: 'authorize', authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=1.2', agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow') })
        : undefined,
    });
    await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
    return page.storage;
  };
  const moved = apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'own_app', { channels: salesChannels })] });

  const added = await harness({ api: moved, storage: Object.fromEntries(await pressed('not_in_slack')) });
  assert.match(added.text(), /Sales Desk is now in Slack as its own app\. People can message it and mention @sales-desk\. In #pipeline-private it keeps answering through Chickpea until someone there adds it\./);
  assert.doesNotMatch(added.text(), /keep using/);

  // A second press from the Allow row keeps what the first press knew.
  const first = await pressed('not_in_slack');
  const again = await harness({
    api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow')] }), storage: Object.fromEntries(first),
    handle: (path) => path.endsWith('/start') ? respond({ next: 'authorize', authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=1.2', agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow') }) : undefined,
  });
  await again.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.match((await harness({ api: moved, storage: Object.fromEntries(again.storage) })).text(), /Sales Desk is now in Slack as its own app\./);

  // A press made from the Allow row with nothing stored, or an entry from before, cannot tell.
  const unplaced = await harness({ api: moved, storage: Object.fromEntries(await pressed('waiting_for_allow')) });
  assert.match(unplaced.text(), /Sales Desk is now its own Slack app\. In #pipeline-private it keeps answering/);
  assert.doesNotMatch(unplaced.text(), /keep using|can message it/);
  const older = await harness({ api: moved, storage: { 'chickpea.slackApps.pendingMoves': JSON.stringify({ agent_sales: Date.now() - 60_000 }) } });
  assert.match(older.text(), /Sales Desk is now its own Slack app\. In #pipeline-private/);
  assert.doesNotMatch(older.text(), /keep using|can message it/);
});

test('two Agents that finished at once both get their result', async () => {
  const now = Date.now();
  const page = await harness({
    api: apiState({ agents: [
      row('agent_sales', 'Sales Desk', 'sales-desk', 'own_app'),
      row('agent_help', 'Helpdesk', 'helpdesk', 'own_app'),
    ] }),
    storage: { 'chickpea.slackApps.pendingMoves': JSON.stringify({ agent_sales: { at: now, from: 'user_group' }, agent_help: { at: now, from: 'not_in_slack' } }) },
  });
  assert.match(page.text(), /Sales Desk is now its own Slack app\. People keep using @sales-desk\./);
  assert.match(page.text(), /Helpdesk is now in Slack as its own app\. People can message it and mention @helpdesk\./);
});

const attentionRows: Array<[string, RegExp, string[]]> = [
  ['config_token_needed', /Chickpea needs a new Slack token to finish Ops&#39;s app\./, ['Add a token']],
  ['handle_release_failed', /Chickpea couldn&#39;t free the name @ops in Slack\. Choose Update in Slack at the top of this page, then choose Try again\./, ['Try again']],
  ['ambiguous_create', /Slack may have created an app for Ops, but Chickpea didn&#39;t hear back\. Delete any Ops app you don&#39;t recognize in Your Apps in Slack, then choose Try again\./, ['Open Your Apps in Slack', 'Try again']],
  ['create_refused', /Slack didn&#39;t finish Ops&#39;s app\. Choose Try again\. If it keeps happening, check that your workspace allows new apps\./, ['Try again']],
  ['urls_refused', /Slack didn&#39;t finish connecting Ops&#39;s app to Chickpea\. Wait a minute, then choose Try again\./, ['Try again']],
  ['slack_busy', /Slack is limiting how fast apps are set up\. Wait a minute, then choose Try again\./, ['Try again']],
  ['app_removed', /Ops&#39;s Slack app was removed from this workspace\. Open your messages with Chickpea and choose Add Ops to Slack to add it back\./, []],
  ['uninstall_failed', /Chickpea couldn&#39;t remove Ops&#39;s Slack app, so Ops is not archived\. Archive Ops again to finish\./, []],
  ['something_new', /Ops&#39;s Slack app needs your attention\. Open your messages with Chickpea for details\./, []],
];

test('each needs-attention reason reads as one sentence with the action that fixes it, and an unknown one never shows its code', async () => {
  for (const [reason, sentence, labels] of attentionRows) {
    const page = await harness({ api: apiState({ agents: [row('agent_ops', 'Ops', 'ops', 'needs_attention', { slack: { state: 'needs_attention', reason } })] }) });
    assert.match(page.text(), sentence, reason);
    assert.doesNotMatch(page.text(), new RegExp(reason), reason);
    const actions = page.html().split('class="slack-apps-row-action">')[1]!.split('</div>')[0]!;
    assert.deepEqual([...actions.matchAll(/>([^<>]+)<\/(?:button|a)>/g)].map((match) => match[1]), labels, reason);
    if (labels.includes('Try again')) assert.match(actions, /data-action="slack-apps-start" data-agent="agent_ops" aria-label="Try again, Ops"/, reason);
  }
});

// Defects caught: a live app whose update Slack refused listed as still answering through the Chickpea app, or told it
// is unfinished.
test('a live app Slack would not update stays with the Agents that have their own app, with one true sentence and its action', async () => {
  const live = (id: string, name: string, attention: string) => row(id, name, name.toLowerCase(), 'own_app', { slack: { state: 'own_app', attention } });
  const page = await harness({ api: apiState({ agents: [
    row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group'),
    live('agent_token', 'Billing', 'config_token_needed'),
    live('agent_refused', 'Helpdesk', 'update_refused'),
    live('agent_failed', 'Legal', 'update_failed'),
  ] }) });
  const html = page.html();
  const text = page.text();
  const own = html.indexOf('>With their own Slack app<');
  const chickpea = html.indexOf('>Still answering through the Chickpea app<');
  assert.ok(own > chickpea && chickpea > 0);
  for (const name of ['Billing', 'Helpdesk', 'Legal']) assert.ok(html.indexOf(`>${name}<`) > own, `${name} is listed as its own app`);
  assert.match(text, /Chickpea needs a Slack token to update Billing&#39;s Slack app\. Billing keeps answering\./);
  assert.match(html, /data-action="slack-apps-token-open" data-agent="agent_token"[^>]*>Add a token</);
  assert.match(text, /Slack didn&#39;t accept the changes to Helpdesk, so its Slack app still shows its earlier name, handle or description\. Helpdesk keeps answering\. Change Helpdesk, then choose Try again\./);
  assert.match(html, /data-action="slack-apps-start" data-agent="agent_refused"[^>]*>Try again</);
  assert.match(text, /Chickpea couldn&#39;t update Legal&#39;s Slack app with its latest name, handle or picture\. Legal keeps answering\. Choose Try again\./);
  assert.match(html, /data-action="slack-apps-start" data-agent="agent_failed"[^>]*>Try again</);
  assert.doesNotMatch(text, /to finish|config_token_needed|update_refused|update_failed/);
});

test("a needs-attention row's Try again calls Start, which picks the record up where it stopped", async () => {
  const page = await harness({
    api: apiState({ agents: [row('agent_ops', 'Ops', 'ops', 'needs_attention', { slack: { state: 'needs_attention', reason: 'urls_refused' } })] }),
    handle: (path) => path.endsWith('/start') ? respond({ next: 'authorize', authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=1.2', agent: row('agent_ops', 'Ops', 'ops', 'waiting_for_allow') }) : undefined,
  });
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_ops' });
  assert.deepEqual(page.requests.filter((request) => request.path.endsWith('/start')).map((request) => request.path), ['/admin/api/slack-apps/agents/agent_ops/start']);
  assert.deepEqual(page.assigned, ['https://slack.com/oauth/v2/authorize?client_id=1.2']);
});

test('a sentence that points at Update in Slack reloads Slack status, so the bar it names is there', async () => {
  const statusReads = (requests: Array<{ path: string }>) => requests.filter((request) => request.path === '/admin/api/slack-connection').length;
  const quiet = await harness();
  const baseline = statusReads(quiet.requests);
  const named = await harness({ api: apiState({ agents: [row('agent_ops', 'Ops', 'ops', 'needs_attention', { slack: { state: 'needs_attention', reason: 'handle_release_failed' } })] }) });
  assert.equal(statusReads(named.requests), baseline + 1);

  const permission = await harness({ handle: (path) => path.endsWith('/start') ? respond({ error: 'permission_needed' }, 409) : undefined });
  const before = statusReads(permission.requests);
  await permission.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.equal(statusReads(permission.requests), before + 1);
});

test("Start's other answers: the row it carries, the limit on apps in words, and never a raw code", async () => {
  for (const [error, agent] of [
    ['needs_attention', row('agent_sales', 'Sales Desk', 'sales-desk', 'needs_attention', { slack: { state: 'needs_attention', reason: 'slack_busy' } })],
    ['already_own_app', row('agent_sales', 'Sales Desk', 'sales-desk', 'own_app')],
    ['cancelling', row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group')],
  ] as const) {
    const page = await harness({ handle: (path) => path.endsWith('/start') ? respond({ error, agent }, 409) : undefined });
    await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
    assert.doesNotMatch(page.html(), /role="alert"/, error);
    if (error === 'needs_attention') assert.match(page.text(), /Slack is limiting how fast apps are set up/);
    if (error === 'already_own_app') assert.match(page.text(), /Sales Desk @sales-desk #?\s*Its own Slack app/);
    if (error === 'cancelling') assert.match(page.html(), /data-agent="agent_sales"[^>]*>Move to its own app</, 'the press finished the removal');
  }

  const limit = await harness({ handle: (path) => path.endsWith('/start') ? respond({ error: 'app_limit' }, 409) : undefined });
  await limit.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.match(limit.text(), /Acme has reached Slack&#39;s limit on apps, so Sales Desk stays as it is\. Delete an app you no longer need in Your Apps in Slack, then try again\. Open Your Apps in Slack/);
  assert.match(limit.html(), /<a class="hint-link" href="https:\/\/api\.slack\.com\/apps" target="_blank" rel="noopener">Open Your Apps in Slack &nearr;<\/a>/);
  assert.match(limit.html(), /data-agent="agent_sales"[^>]*>Move to its own app</, 'the Agent stays as it was');

  const taken = await harness({ handle: (path) => path.endsWith('/start') ? respond({ error: 'handle_taken', agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group') }, 409) : undefined });
  await taken.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.match(taken.text(), /Another Agent is using @sales-desk in Slack, or is being added with it\. Rename Sales Desk, then try again\./);

  for (const [error, status] of [['something_new', 409], ['', 500]] as const) {
    const odd = await harness({ handle: (path) => path.endsWith('/start') ? respond(error ? { error } : {}, status) : undefined });
    await odd.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
    assert.match(odd.text(), /Chickpea couldn&#39;t reach Slack\. Try again in a minute\./);
    assert.doesNotMatch(odd.text(), /something_new|HTTP/);
  }
});

test('a Cancel Slack did not finish shows as unfinished with one control that finishes it', async () => {
  const page = await harness({
    api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'cancelling', { channels: salesChannels })] }),
    handle: (path) => path.endsWith('/cancel') ? respond({ agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group'), app: 'deleted' }) : undefined,
  });
  const html = page.html();
  assert.ok(html.indexOf('>Still answering through the Chickpea app<') < html.indexOf('>Sales Desk<'));
  assert.match(page.text(), /Removing the Slack app Chickpea made for Sales Desk didn&#39;t finish\. Sales Desk keeps answering as it did before\./);
  assert.doesNotMatch(page.text(), /cancelling/);
  assert.match(html, /data-action="slack-apps-cancel" data-agent="agent_sales" aria-label="Finish removing, Sales Desk"[^>]*>Finish removing</);
  await page.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  assert.match(page.html(), /data-agent="agent_sales"[^>]*>Move to its own app</);
  assert.doesNotMatch(page.text(), /didn&#39;t finish/);
});

test("Cancel's answers: an app left for the Owner, Slack not answering, and a Cancel too late", async () => {
  const waiting = () => apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow')] });
  const left = await harness({
    api: waiting(),
    handle: (path) => path.endsWith('/cancel') ? respond({ agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group'), app: 'left_for_owner' }) : undefined,
  });
  await left.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  assert.match(left.text(), /Chickpea couldn&#39;t delete the Slack app it made for Sales Desk, so delete Sales Desk in Your Apps in Slack\. Sales Desk keeps answering as it did before\. Open Your Apps in Slack/);
  assert.match(left.html(), /<a class="hint-link" href="https:\/\/api\.slack\.com\/apps" target="_blank" rel="noopener">Open Your Apps in Slack &nearr;<\/a>/);

  // Defect caught: an Owner asked to delete in Your Apps an app Slack says does not exist.
  const notFound = await harness({
    api: waiting(),
    handle: (path) => path.endsWith('/cancel') ? respond({ agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group'), app: 'not_found' }) : undefined,
  });
  await notFound.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  assert.match(notFound.text(), /Chickpea couldn&#39;t find the Slack app it made for Sales Desk to delete it\. If Sales Desk still appears in Your Apps in Slack, you can delete it there\. Sales Desk keeps answering as it did before\. Open Your Apps in Slack/);
  assert.doesNotMatch(notFound.text(), /so delete Sales Desk/);

  const deleted = await harness({
    api: waiting(),
    handle: (path) => path.endsWith('/cancel') ? respond({ agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group'), app: 'deleted' }) : undefined,
  });
  await deleted.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  assert.doesNotMatch(deleted.text(), /Your Apps/);

  const stopped = await harness({
    api: waiting(),
    handle: (path) => {
      if (!path.endsWith('/cancel')) return undefined;
      stopped.api.agents = [row('agent_sales', 'Sales Desk', 'sales-desk', 'cancelling')];
      return respond({ error: 'slack_unavailable' }, 503);
    },
  });
  await stopped.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  assert.match(stopped.text(), /Slack didn&#39;t answer\. Try again in a minute\./);
  assert.match(stopped.text(), /didn&#39;t finish\. Sales Desk keeps answering as it did before\./, 'the section reloads and shows the unfinished removal');
  assert.match(stopped.html(), />Finish removing</);

  const late = await harness({
    api: waiting(),
    handle: (path) => {
      if (!path.endsWith('/cancel')) return undefined;
      late.api.agents = [row('agent_sales', 'Sales Desk', 'sales-desk', 'switching')];
      return respond({ error: 'not_waiting' }, 409);
    },
  });
  await late.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_sales' });
  assert.match(late.text(), /Chickpea couldn&#39;t cancel this\. Reload the page and try again\./);
  assert.match(late.text(), /Moving Sales Desk/);
});

// Defects caught: a start that stopped before Slack made any app had no Cancel on its row; Cancel's answer for it
// saying an app was deleted, or saying nothing where Slack may have made one.
test('a row whose start stopped before Slack made any app offers a quiet Cancel, and says what Cancel found', async () => {
  const stopped = (reason: string, cancellable = true) =>
    apiState({ agents: [row('agent_ops', 'Ops', 'ops', 'needs_attention', { slack: { state: 'needs_attention', reason, ...(cancellable ? { cancellable } : {}) } })] });
  const actionsOf = (html: string) => html.split('class="slack-apps-row-action">')[1]!.split('</div>')[0]!;
  for (const [reason, labels] of [
    ['create_refused', ['Try again', 'Cancel']],
    ['slack_busy', ['Try again', 'Cancel']],
    ['config_token_needed', ['Add a token', 'Cancel']],
    ['ambiguous_create', ['Open Your Apps in Slack', 'Try again', 'Cancel']],
  ] as const) {
    const page = await harness({ api: stopped(reason) });
    const actions = actionsOf(page.html());
    assert.deepEqual([...actions.matchAll(/>([^<>]+)<\/(?:button|a)>/g)].map((match) => match[1]), labels, reason);
    assert.match(actions, /<button type="button" class="link-btn" data-action="slack-apps-cancel" data-agent="agent_ops" aria-label="Cancel, Ops">Cancel<\/button>/, reason);
  }
  const made = await harness({ api: stopped('config_token_needed', false) });
  assert.doesNotMatch(actionsOf(made.html()), />Cancel</, 'once Slack made the app, no Cancel');

  const none = await harness({
    api: stopped('create_refused'),
    handle: (path) => path.endsWith('/cancel') ? respond({ agent: row('agent_ops', 'Ops', 'ops', 'user_group'), app: 'none' }) : undefined,
  });
  await none.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_ops' });
  assert.deepEqual(none.requests.filter((request) => request.path.endsWith('/cancel')).map((request) => request.path), ['/admin/api/slack-apps/agents/agent_ops/cancel']);
  assert.match(none.html(), /data-agent="agent_ops"[^>]*>Move to its own app</);
  assert.doesNotMatch(none.text(), /delete|Your Apps|didn&#39;t finish/, 'nothing existed, so nothing is said to be deleted');

  const unanswered = await harness({
    api: stopped('ambiguous_create'),
    handle: (path) => path.endsWith('/cancel') ? respond({ agent: row('agent_ops', 'Ops', 'ops', 'user_group'), app: 'left_for_owner' }) : undefined,
  });
  await unanswered.click({ 'data-action': 'slack-apps-cancel', 'data-agent': 'agent_ops' });
  assert.match(unanswered.text(), /Slack may have made an app for Ops before Chickpea stopped\. If you see one in Your Apps in Slack that you don&#39;t use, delete it\. Open Your Apps in Slack/);
  assert.doesNotMatch(unanswered.text(), /couldn&#39;t delete the Slack app it made/);
  assert.match(unanswered.html(), /<a class="hint-link" href="https:\/\/api\.slack\.com\/apps" target="_blank" rel="noopener">Open Your Apps in Slack &nearr;<\/a>/);
});

const YOUR_APPS_LINK = '<a class="hint-link" href="https://api.slack.com/apps" target="_blank" rel="noopener">Open Your Apps in Slack &nearr;</a>';

const STILL_LISTED = 'If Your Apps in Slack still shows a token for this workspace, copy its Refresh Token, add it in Chickpea again, and remove it again.';
const UNCONFIRMED = `Chickpea deleted its copy of your configuration token, but Slack didn't confirm the token stopped working, so Slack may still accept it. ${STILL_LISTED}`;

// Defect caught: a removal Slack did not finish that sends the Owner to Slack's own Delete, which can leave a token
// nobody can delete or replace; or one that gives no route at all.
test('each removal says what it did: retired, still listed at Slack, not confirmed by Slack, or no token held', async () => {
  for (const [removed, sentence, success] of [
    ['discarded', 'Chickpea deleted its copy of your configuration token and retired that token at Slack.', true],
    ['left_listed', `Chickpea deleted its copy of your configuration token, but Slack may still list it. ${STILL_LISTED}`, false],
    ['unconfirmed', UNCONFIRMED, false],
    ['none', 'Chickpea holds no configuration token for this workspace.', false],
    ['something_new', UNCONFIRMED, false],
  ] as const) {
    const page = await harness({ handle: (path, method) => path === '/admin/api/slack-apps/token' && method === 'DELETE' ? respond({ token: { stored: false }, removed }) : undefined });
    await page.click({ 'data-action': 'slack-apps-token-remove' });
    assert.match(page.text(), /Remove the Slack token\? Chickpea deletes its copy and asks Slack to stop accepting the token\./);
    await page.click({ 'data-action': 'slack-apps-confirm-apply' });
    assert.ok(page.text().includes(sentence.replace(/'/g, '&#39;')), removed);
    assert.equal(page.html().includes('callout callout-success slack-apps-callout'), success, removed);
    assert.equal(page.html().includes(YOUR_APPS_LINK), removed !== 'discarded' && removed !== 'none', `${removed}: a token Slack may still list sends the Owner to Your Apps`);
    assert.equal(/Delete it|12 hours/.test(page.text()), false, `${removed}: never Slack's own Delete, and no clock`);
  }
});

// Defect caught: a route to the section in a tab the browser reports hidden loaded nothing, so it stayed on
// "Loading…" until the tab was focused or the page reloaded.
test('the section loads when its route opens in a hidden tab', async () => {
  const page = await harness({ hidden: true });
  assert.equal(sectionRequests(page.requests).filter((request) => request.path === '/admin/api/slack-apps').length, 1);
  assert.doesNotMatch(page.text(), /Loading…/);
  assert.match(page.html(), /data-agent="agent_sales"[^>]*>Move to its own app</);
});

test('a section that could not load says so, and Try again loads it', async () => {
  let fail = true;
  const page = await harness({ handle: (path, method) => path === '/admin/api/slack-apps' && method === 'GET' && fail ? respond({ error: 'unavailable' }, 503) : undefined });
  assert.match(page.text(), /Agents in Slack couldn&#39;t load\. Try again\./);
  fail = false;
  await page.click({ 'data-action': 'slack-apps-reload' });
  assert.match(page.html(), /data-agent="agent_sales"[^>]*>Move to its own app</);
});

test('after a press the section reads every few seconds for two minutes, then only when the Owner comes back', async () => {
  const page = await harness({
    clock: true,
    handle: (path) => path.endsWith('/start') ? respond({ next: 'creating', agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'creating') }, 202) : undefined,
  });
  page.api.agents = [row('agent_sales', 'Sales Desk', 'sales-desk', 'creating')];
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.match(page.text(), /Creating Sales Desk(’|&rsquo;)s Slack app/);
  const reads = () => page.requests.filter((request) => request.path === '/admin/api/slack-apps' && request.method === 'GET').length;
  const start = reads();
  await page.advance(60_000);
  assert.equal(reads(), start + 15, 'one read every four seconds');
  await page.advance(60_000);
  const atWindow = reads();
  assert.ok(atWindow >= start + 29 && atWindow <= start + 30, String(atWindow - start));
  assert.match(page.text(), /Creating Sales Desk&#39;s Slack app hasn&#39;t finished\. Choose Try again\./);
  assert.match(page.html(), /data-action="slack-apps-start" data-agent="agent_sales" aria-label="Try again, Sales Desk"/);
  await page.advance(60 * 60_000);
  assert.equal(reads(), atWindow, 'no reads after the window');
  assert.equal(page.timers.length, 0);

  // The press waiting on Slack's Allow page, left open after Back, stops too.
  const back = await harness({
    clock: true,
    api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow')] }),
    storage: { 'chickpea.slackApps.pendingMoves': JSON.stringify({ agent_sales: { at: Date.UTC(2026, 10, 23, 15), from: 'user_group' } }) },
  });
  const first = back.requests.length;
  await back.advance(24 * 60 * 60_000);
  const polled = back.requests.filter((request) => request.path === '/admin/api/slack-apps').length;
  assert.ok(polled <= 31, String(polled));
  assert.ok(back.requests.length - first < 40);
});

test('an Agent seen being created by a press elsewhere is watched the same way', async () => {
  const page = await harness({ clock: true, api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'creating')] }) });
  assert.match(page.text(), /Creating Sales Desk(’|&rsquo;)s Slack app/);
  await page.advance(2 * 60_000 + 4_000);
  assert.match(page.text(), /hasn&#39;t finished\. Choose Try again\./);
});

test('the token page holds focus for the paste, and a paste on the page outside any field is sent', async () => {
  const page = await harness({ path: '/admin/destinations/slack/connection/token' });
  assert.ok(page.focused.includes('slack-apps-token'), 'focused when the page opens');
  page.focused.length = 0;
  page.blur();
  await page.focusWindow();
  assert.ok(page.focused.includes('slack-apps-token'), 'and again when the Owner comes back from Slack');
  page.focused.length = 0;
  page.blur();
  page.field.value = 'xoxe-1-half-typ';
  await page.focusWindow();
  assert.deepEqual(page.focused, [], 'a field already holding text is left as it is');
  page.field.value = '';

  assert.equal(await page.paste('xoxe-1-from-the-page', page.body), true);
  await flush();
  assert.deepEqual(page.requests.filter((request) => request.path === '/admin/api/slack-apps/token').map((request) => request.body), [{ refreshToken: 'xoxe-1-from-the-page' }]);

  const stray = await harness({ path: '/admin/destinations/slack/connection/token' });
  for (const text of ['a password copied for something else', 'xoxe.xoxp-1-the-access-token']) {
    assert.equal(await stray.paste(text, stray.body), true);
    await flush();
    assert.match(stray.text(), /Copy the Refresh Token/);
  }
  assert.deepEqual(stray.requests.filter((request) => request.method !== 'GET'), [], 'text that is not a refresh token never leaves the page');
  assert.equal(stray.html().includes('a password copied'), false);

  const other = await harness({ path: '/admin/destinations/slack/connection/token' });
  assert.equal(await other.paste('some text', { tagName: 'TEXTAREA' }), false, 'a paste into another field is that field\'s');
  const elsewhere = await harness();
  assert.equal(await elsewhere.paste('xoxe-1-x', elsewhere.body), false, 'off the token page a paste is nothing to this page');
});

test('after a token is accepted, Continue has focus', async () => {
  const page = await harness({
    path: '/admin/destinations/slack/connection/token',
    handle: (path, method) => path === '/admin/api/slack-apps/token' && method === 'PUT' ? respond({ token: { stored: true } }) : undefined,
  });
  page.focused.length = 0;
  await page.paste('xoxe-1-good');
  await flush();
  assert.deepEqual(page.focused, ['slack-apps-token-continue']);
});

test('a press that needed a token lands on the token page saying why, and the intro never says once to someone doing it again', async () => {
  const page = await harness({ handle: (path) => path.endsWith('/start') ? respond({ error: 'token_needed' }, 409) : undefined });
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.match(page.text(), /Chickpea needs a Slack token before it can create Sales Desk&#39;s Slack app\./);
  assert.match(page.text(), /Slack needs one token from you for Acme\./);
  assert.doesNotMatch(page.text(), /once/);

  const again = await harness({ api: apiState({ setting: { mode: 'shared', changedBy: 'UOWNER', changedAt: 5 }, token: { stored: false } }) });
  await again.click({ 'data-action': 'slack-apps-turn-on' });
  assert.doesNotMatch(again.text(), /once/, 'the setting was on before');
});

test('Back from Slack into a page restored from memory frees the pressed row', async () => {
  const page = await harness({
    handle: (path) => path.endsWith('/start') ? respond({ next: 'authorize', authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=1.2', agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'waiting_for_allow') }) : undefined,
  });
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.match(page.html(), /data-agent="agent_sales"[^>]* disabled>/);
  await page.pageshow(false);
  assert.match(page.html(), /data-agent="agent_sales"[^>]* disabled>/, 'a fresh load is not a restore');
  await page.pageshow(true);
  assert.doesNotMatch(page.html(), /data-agent="agent_sales"[^>]* disabled>/);
});

test("each row button's name says which Agent it is for", async () => {
  const page = await harness({ api: apiState({ agents: [
    row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group'),
    row('agent_help', 'Helpdesk', 'helpdesk', 'waiting_for_allow'),
  ] }) });
  assert.match(page.html(), /aria-label="Move to its own app, Sales Desk"[^>]*>Move to its own app</);
  assert.match(page.html(), /aria-label="Cancel, Helpdesk"[^>]*>Cancel</);
  assert.doesNotMatch(page.html(), /aria-label="Add Helpdesk to Slack/, 'a label that names the Agent already says it');
});

/**
 * Hosted onboarding's optional Slack apps step, against a fake of onboarding's
 * API. `github` adds Connect GitHub after it, for six steps instead of five;
 * `chickpeaModels` is an Owner on Chickpea's models, whose bar has no provider
 * or model step.
 */
async function onboarding(options: {
  github?: boolean; free?: boolean; api?: ApiState; offered?: boolean; chickpeaModels?: boolean;
  /** Answers a request before the fake onboarding API does, such as a failure. */
  fail?: (path: string, method: string) => FakeResponse | undefined;
} = {}) {
  const github = options.github !== false;
  const world = { stage: options.offered === false ? 'connect_github' : 'slack_apps', rev: 1 };
  const view = () => ({
    ...(github ? { githubConnectPath: '/github/connect' } : {}),
    ...(world.stage === 'slack_apps' && options.free ? { slackFreePlan: true } : {}),
    stage: world.stage, revision: `{"revision":${world.rev}}`, agentId: 'agent_chickpea', redirectTo: null,
    workspace: { id: 'TACME', name: 'Acme' }, channel: null, providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-5',
    models: [], slackAppId: 'AACME', tryStartedAt: 1_800_000_000_000, completedAt: null,
  });
  const api = options.api ?? apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, token: { stored: false }, agents: [] });
  const page = await harness({
    ...(options.offered === undefined ? {} : { offered: options.offered }),
    api,
    path: '/admin/onboarding',
    page: {
      selfHosted: false, installationOwner: true, billingOffered: options.chickpeaModels === true,
      onboarding: { initial: view(), githubConnectPath: github ? '/github/connect' : null },
    },
    handle(path, method, body) {
      const failed = options.fail?.(path, method);
      if (failed) return failed;
      if (path === '/admin/api/onboarding' && method === 'GET') return respond(view());
      if (path === '/admin/api/onboarding/slack-apps' && method === 'POST') {
        if ((body as { expectedRevision: string }).expectedRevision !== view().revision) return respond({ error: 'onboarding_changed' }, 409);
        world.rev += 1;
        world.stage = github ? 'connect_github' : 'try';
        return respond(view());
      }
      if (path === '/admin/api/slack-apps/token' && method === 'PUT') {
        api.token = { stored: true, pastedBy: 'UOWNER', pastedAt: 3 };
        return respond({ token: api.token });
      }
      return undefined;
    },
  });
  const writes = () => page.requests.filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path}`);
  return { ...page, world, writes };
}

function stepBar(html: string): string[] {
  const bar = html.slice(html.indexOf('<ol class="onboarding-orientation"'), html.indexOf('</ol>'));
  return [...bar.matchAll(/<li class="([^"]*)"[^>]*><span class="onboarding-step-label">([^<]*)<\/span>(?:<span class="onboarding-step-note">([^<]*)<\/span>)?/g)]
    .map((match) => `${match[2]} (${match[3] ?? ''}${match[1] ? `, ${match[1]}` : ''})`);
}

test('onboarding offers Slack apps after the model and before Connect GitHub, as in its six-step bar, with the words and picture of the step', async () => {
  const page = await onboarding();
  assert.deepEqual(stepBar(page.html()), [
    'Add to Slack (Done, complete)', 'Choose provider (Done, complete)', 'Choose model (Done, complete)',
    'Slack apps (Optional, active)', 'Connect GitHub (Optional)', 'Try Chickpea (Say hi)',
  ]);
  const text = page.text();
  assert.match(page.html(), /<p class="onboarding-eyebrow">Step 4 of 6 &middot; Optional<\/p><h1 class="onboarding-title">Make each Agent its own Slack app<\/h1>/);
  assert.match(text, /Each Agent shows up in Slack like a teammate\. It has its own name and picture, people can message it directly, and you add it to channels the way you add a person\. Setup takes about a minute\./);
  assert.match(page.html(), /<figcaption>Its own Slack app<\/figcaption>[\s\S]*<figcaption>Through the Chickpea app<\/figcaption>/);
  assert.equal((page.html().match(/<div class="slack-apps-mini" aria-hidden="true">/g) ?? []).length, 2, 'the picture is decorative; its captions say what it shows');
  assert.match(page.html(), /data-action="onboarding-slack-apps-set-up">Set it up<\/button><button type="button" class="btn btn-ghost" data-action="onboarding-slack-apps-skip">Skip for now<\/button>/);
  assert.match(text, /If you skip, your Agents answer through the Chickpea app\. You can turn this on later under Destinations &rsaquo; Slack\./);
  assert.doesNotMatch(text, /free plan/, 'no line where the plan is not known');
  assert.doesNotMatch(text, /TACME|AACME|agent_chickpea|revision|slack_apps/, 'no internal identifier on screen');
  assert.deepEqual(page.writes(), [], 'opening the step changes nothing');
});

test('the step bar wraps a label instead of cutting it short from four steps up: the Owner on Chickpea\'s models has four, their own key five or six', async () => {
  const four = await onboarding({ chickpeaModels: true });
  assert.deepEqual(stepBar(four.html()), ['Add to Slack (Done, complete)', 'Slack apps (Optional, active)', 'Connect GitHub (Optional)', 'Try Chickpea (Say hi)']);
  assert.match(four.html(), /Step 2 of 4 &middot; Optional/);
  const five = await onboarding({ github: false });
  assert.deepEqual(stepBar(five.html()).map((step) => step.split(' (')[0]), ['Add to Slack', 'Choose provider', 'Choose model', 'Slack apps', 'Try Chickpea']);
  assert.match(five.html(), /Step 4 of 5 &middot; Optional/);
  const css = readFileSync('assets/admin-ui/admin.css', 'utf8');
  // Three or fewer keep equal columns and one line; from four, each column is sized to its label, which wraps rather than being cut.
  assert.match(css, /\.onboarding-orientation \{ display: grid; gap: 10px; grid-auto-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.onboarding-orientation:has\(> li:nth-child\(4\)\) \{ grid-auto-columns: auto; \}/);
  assert.match(css, /\.onboarding-orientation:has\(> li:nth-child\(4\)\) :is\(\.onboarding-step-label, \.onboarding-step-note\) \{ white-space: normal; \}/);
});

test("the free-plan line shows when onboarding knows the plan, above the buttons, and names no number", async () => {
  const page = await onboarding({ free: true });
  const line = /<p class="slack-apps-plan-note">([^<]*)<\/p>/.exec(page.html())?.[1];
  assert.equal(line, 'Your workspace is on Slack&rsquo;s free plan, where this is the only way to give an Agent an @handle people can mention. Slack&rsquo;s free plan also limits how many apps a workspace can have.');
  assert.doesNotMatch(line!, /\d/);
  assert.ok(page.html().indexOf('slack-apps-plan-note') < page.html().indexOf('onboarding-slack-apps-set-up'));
});

test('Skip for now records the skip and moves on, and nothing else is written', async () => {
  const page = await onboarding();
  await page.click({ 'data-action': 'onboarding-slack-apps-skip' });
  assert.deepEqual(page.writes(), ['POST /admin/api/onboarding/slack-apps']);
  assert.deepEqual(page.requests.find((request) => request.method === 'POST')?.body, { expectedRevision: '{"revision":1}' });
  assert.match(page.html(), /Step 5 of 6 &middot; Optional<\/p><h1 class="onboarding-title">Let Agents work on your code/);
  assert.match(stepBar(page.html())[3]!, /^Slack apps \(Done, complete\)$/);
});

test('Set it up opens the token page inside onboarding; leaving it without a token comes back to the step', async () => {
  const page = await onboarding();
  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  assert.equal(page.location.pathname, '/admin/onboarding', 'still onboarding, not Destinations');
  assert.match(stepBar(page.html())[3]!, /^Slack apps \(Optional, active\)$/, 'the step bar stays');
  assert.match(page.text(), /Let Chickpea create Slack apps for your Agents/);
  assert.match(page.text(), /Slack needs one token from you\. You only do this once for Acme\./);
  assert.match(page.html(), /data-action="slack-apps-token-back">&larr; Back<\/button>/);
  assert.deepEqual(page.writes(), [], 'nothing turns on before a token is accepted');
  await page.click({ 'data-action': 'slack-apps-token-back' });
  assert.equal(page.location.pathname, '/admin/onboarding');
  assert.match(page.html(), /<h1 class="onboarding-title">Make each Agent its own Slack app<\/h1>/);
  assert.doesNotMatch(page.html(), /Connected workspace|destination-tabs/, 'not sent to Destinations');
  assert.deepEqual(page.writes(), []);
});

test('an accepted token turns the setting on, and Continue moves to the next step with Slack apps done', async () => {
  const page = await onboarding();
  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  await page.paste('xoxe-1-onboarding-token-0000');
  await flush();
  assert.equal(page.field.value, '', 'the field never holds the token');
  assert.match(page.text(), /Connected\. From now on, each new Agent gets its own Slack app\./);
  assert.equal(page.api.setting.mode, 'own_app');
  await page.click({ 'data-action': 'slack-apps-token-back' });
  assert.deepEqual(page.writes(), ['PUT /admin/api/slack-apps/token', 'PUT /admin/api/slack-apps/mode', 'POST /admin/api/onboarding/slack-apps']);
  assert.match(page.html(), /Step 5 of 6 &middot; Optional<\/p><h1 class="onboarding-title">Let Agents work on your code/);
  assert.match(stepBar(page.html())[3]!, /^Slack apps \(Done, complete\)$/);
  assert.doesNotMatch(page.text(), /xoxe-1-onboarding/);
});

test('with a token already stored, Set it up turns the setting on and moves on without the token page', async () => {
  const page = await onboarding({ api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, agents: [] }) });
  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  assert.deepEqual(page.writes(), ['PUT /admin/api/slack-apps/mode', 'POST /admin/api/onboarding/slack-apps']);
  assert.equal(page.api.setting.mode, 'own_app');
  assert.doesNotMatch(page.html(), /Let Chickpea create Slack apps/);
  assert.match(page.html(), /Let Agents work on your code/);
});

test('without the offer the step bar has no Slack apps step and the step never shows', async () => {
  const page = await onboarding({ offered: false });
  assert.deepEqual(stepBar(page.html()).map((step) => step.split(' (')[0]), ['Add to Slack', 'Choose provider', 'Choose model', 'Connect GitHub', 'Try Chickpea']);
  assert.doesNotMatch(page.html(), /Make each Agent its own Slack app/);
  assert.equal(page.requests.some((request) => request.path.startsWith('/admin/api/slack-apps')), false);
});

test('coming back to the window during or after the two minutes reads once and never restarts them', async () => {
  const creating = (id: string, name: string, handle: string) => row(id, name, handle, 'creating');
  const page = await harness({
    clock: true,
    api: apiState({ agents: [row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group'), row('agent_help', 'Helpdesk', 'helpdesk', 'user_group')] }),
    handle: (path) => {
      const pressed = /agents\/(agent_\w+)\/start$/.exec(path)?.[1];
      if (!pressed) return undefined;
      const made = pressed === 'agent_sales' ? creating('agent_sales', 'Sales Desk', 'sales-desk') : creating('agent_help', 'Helpdesk', 'helpdesk');
      page.api.agents = page.api.agents.map((agent) => agent.id === pressed ? made : agent);
      return respond({ next: 'creating', agent: made }, 202);
    },
  });
  const reads = () => page.requests.filter((request) => request.path === '/admin/api/slack-apps' && request.method === 'GET').length;
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  await page.advance(100_000);
  for (let index = 0; index < 3; index += 1) await page.focusWindow();
  await page.advance(24_000);
  assert.equal(page.timers.length, 0, 'the window closed two minutes after the press');
  assert.match(page.html(), /aria-label="Try again, Sales Desk"/);

  const after = reads();
  await page.focusWindow();
  assert.equal(reads(), after + 1, 'one read on return');
  await page.advance(60 * 60_000);
  assert.equal(reads(), after + 1);
  assert.equal(page.timers.length, 0);

  // A second Agent pressed later is watched for its own two minutes, and the first is not watched again.
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_help' });
  assert.match(page.html(), /aria-label="Try again, Sales Desk"/);
  assert.match(page.text(), /Creating Helpdesk(’|&rsquo;)s Slack app/);
  const second = reads();
  await page.advance(60 * 60_000);
  assert.ok(reads() - second <= 30, String(reads() - second));
  assert.equal(page.timers.length, 0);
});

const tokenSends = (requests: Array<{ path: string; method: string; body: unknown }>) =>
  requests.filter((request) => JSON.stringify(request.body ?? '').includes('xoxe') || (request.path === '/admin/api/slack-apps/token' && request.method === 'PUT'));

test('a token Slack accepted whose setting did not turn on is never asked for again: Destinations says it is saved, and Turn it on sends only the setting', async () => {
  let modeDown = true;
  let release: () => void = () => {};
  const reloadHeld = new Promise<void>((resolve) => { release = resolve; });
  const api = apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, token: { stored: false } });
  const page = await harness({
    api,
    async handle(path, method) {
      // The section's reload after the failure is still out when the Owner presses Turn it on.
      if (path === '/admin/api/slack-apps' && method === 'GET' && modeDown && api.token.stored) await reloadHeld;
      if (path === '/admin/api/slack-apps/token' && method === 'PUT') {
        api.token = { stored: true, pastedBy: 'UOWNER', pastedAt: 3 };
        return respond({ token: api.token });
      }
      if (path === '/admin/api/slack-apps/mode' && modeDown) return respond({ error: 'internal_error' }, 500);
      return undefined;
    },
  });
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  await page.paste('xoxe-1-accepted-token-0000');
  await flush();
  assert.equal(page.location.pathname, '/admin/destinations/slack/connection', 'back on the section, off the token page');
  assert.doesNotMatch(page.text(), /Let Chickpea create Slack apps|couldn(&#39;|')t save the token/);
  assert.match(page.html(), /role="alert">Chickpea saved your Slack token, but couldn(&#39;|')t turn this on yet\.<\/p>/);
  assert.match(page.html(), /data-action="slack-apps-turn-on">Turn it on<\/button>/);
  assert.equal(tokenSends(page.requests).length, 1);

  modeDown = false;
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  release();
  await flush();
  assert.deepEqual(page.requests.filter((request) => request.path === '/admin/api/slack-apps/mode').map((request) => request.body), [{ mode: 'own_app' }, { mode: 'own_app' }]);
  assert.equal(tokenSends(page.requests).length, 1, 'the retry sends no token');
  assert.doesNotMatch(page.text(), /Let Chickpea create Slack apps|saved your Slack token/);
  assert.match(page.text(), /Each new Agent gets its own Slack app\./);
});

test('in onboarding, a token Slack accepted whose setting did not turn on returns to the step saying it is saved, and Turn it on sends only the setting', async () => {
  let modeDown = true;
  const page = await onboarding({ fail: (path) => (path === '/admin/api/slack-apps/mode' && modeDown ? respond({ error: 'internal_error' }, 500) : undefined) });
  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  await page.paste('xoxe-1-accepted-token-0000');
  await flush();
  assert.equal(page.location.pathname, '/admin/onboarding');
  assert.doesNotMatch(page.text(), /Let Chickpea create Slack apps|couldn(&#39;|')t save the token/);
  assert.match(page.html(), /<h1 class="onboarding-title">Make each Agent its own Slack app<\/h1>/);
  assert.match(page.html(), /role="alert">Chickpea saved your Slack token, but couldn(&#39;|')t turn this on yet\.<\/p>/);
  assert.match(page.html(), /data-action="onboarding-slack-apps-set-up">Turn it on<\/button>/);

  modeDown = false;
  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  assert.deepEqual(page.writes(), ['PUT /admin/api/slack-apps/token', 'PUT /admin/api/slack-apps/mode', 'PUT /admin/api/slack-apps/mode', 'POST /admin/api/onboarding/slack-apps']);
  assert.equal(tokenSends(page.requests).length, 1, 'the retry sends no token');
  assert.equal(page.api.setting.mode, 'own_app');
  assert.doesNotMatch(page.text(), /Let Chickpea create Slack apps/);
  assert.match(page.html(), /Let Agents work on your code/);
});

const UPDATING = /role="alert">Chickpea is finishing an update, so try again in a minute\.<\/p>/;
const updating = () => respond({ error: 'updating' }, 503);

test('while Chickpea finishes an update, turning the setting on says so, and the same button tries again', async () => {
  let held = true;
  const page = await harness({
    api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null } }),
    handle: (path) => (path === '/admin/api/slack-apps/mode' && held ? updating() : undefined),
  });
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  assert.match(page.html(), UPDATING);
  assert.doesNotMatch(page.text(), /couldn(&#39;|')t change this setting/);
  assert.match(page.html(), /data-action="slack-apps-turn-on">Make each Agent its own Slack app<\/button>/);

  held = false;
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  assert.doesNotMatch(page.html(), UPDATING);
  assert.match(page.text(), /Each new Agent gets its own Slack app\./);
});

test('a token Slack accepted while Chickpea finishes an update: Destinations says so, never asks for the token again, and Turn it on sends only the setting', async () => {
  let held = true;
  const api = apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, token: { stored: false } });
  const page = await harness({
    api,
    handle(path, method) {
      if (path === '/admin/api/slack-apps/token' && method === 'PUT') {
        api.token = { stored: true, pastedBy: 'UOWNER', pastedAt: 3 };
        return respond({ token: api.token });
      }
      return path === '/admin/api/slack-apps/mode' && held ? updating() : undefined;
    },
  });
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  await page.paste('xoxe-1-accepted-token-0000');
  await flush();
  assert.equal(page.location.pathname, '/admin/destinations/slack/connection');
  assert.match(page.html(), UPDATING);
  assert.doesNotMatch(page.text(), /Let Chickpea create Slack apps|couldn(&#39;|')t turn this on yet/);
  assert.match(page.html(), /data-action="slack-apps-turn-on">Turn it on<\/button>/);

  held = false;
  await page.click({ 'data-action': 'slack-apps-turn-on' });
  assert.equal(tokenSends(page.requests).length, 1, 'the retry sends no token');
  assert.match(page.text(), /Each new Agent gets its own Slack app\./);
});

test('in onboarding, a token Slack accepted while Chickpea finishes an update returns to the step saying so, and a retry still held says so again', async () => {
  let held = 2;
  const page = await onboarding({ fail: (path) => (path === '/admin/api/slack-apps/mode' && held-- > 0 ? updating() : undefined) });
  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  await page.paste('xoxe-1-accepted-token-0000');
  await flush();
  assert.equal(page.location.pathname, '/admin/onboarding');
  assert.match(page.html(), UPDATING);
  assert.match(page.html(), /data-action="onboarding-slack-apps-set-up">Turn it on<\/button>/);

  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  assert.match(page.html(), UPDATING);
  assert.doesNotMatch(page.text(), /couldn(&#39;|')t start this|Let Chickpea create Slack apps/);

  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  assert.equal(tokenSends(page.requests).length, 1, 'no retry sends the token');
  assert.equal(page.api.setting.mode, 'own_app');
});

test('with the setting on, a step write that fails is tried once more, then the step shows as done with a quiet retry', async () => {
  let stepWrites = 0;
  let stepDown = 2;
  const page = await onboarding({
    fail: (path) => {
      if (path !== '/admin/api/onboarding/slack-apps') return undefined;
      stepWrites += 1;
      if (stepDown <= 0) return undefined;
      stepDown -= 1;
      return respond({ error: 'internal_error' }, 500);
    },
  });
  await page.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  await page.paste('xoxe-1-onboarding-token-0000');
  await flush();
  await page.click({ 'data-action': 'slack-apps-token-back' });
  assert.equal(stepWrites, 2, 'one retry');
  assert.doesNotMatch(page.text(), /Could not load setup|Skip for now|Set it up/);
  assert.match(page.html(), /role="status">Done\. Each new Agent gets its own Slack app\.<\/p>/);
  assert.match(page.html(), /Chickpea couldn&rsquo;t open the next step\. <button type="button" class="link-btn" data-action="onboarding-slack-apps-continue">Try again<\/button>/);

  await page.click({ 'data-action': 'onboarding-slack-apps-continue' });
  assert.equal(stepWrites, 3);
  assert.match(page.html(), /Let Agents work on your code/);
  assert.equal(tokenSends(page.requests).length, 1);

  stepWrites = 0;
  stepDown = 1;
  const once = await onboarding({ api: apiState({ setting: { mode: 'shared', changedBy: null, changedAt: null }, agents: [] }), fail: (path) => {
    if (path !== '/admin/api/onboarding/slack-apps') return undefined;
    stepWrites += 1;
    return stepDown-- > 0 ? respond({ error: 'internal_error' }, 500) : undefined;
  } });
  await once.click({ 'data-action': 'onboarding-slack-apps-set-up' });
  assert.equal(stepWrites, 2);
  assert.match(once.html(), /Let Agents work on your code/, 'one failure is absorbed by the retry');
});

// Defects caught: a paused section that still offers a control that creates or changes an app (turning the setting on,
// Add, Move, Try again, Add a token), says nothing of the pause, or hides what exists and the controls that still work.
test('paused, the section says so, offers nothing that creates or changes an app, and keeps what still works', async () => {
  const agents = [
    row('agent_new', 'Scout', 'scout', 'not_in_slack', { waitsForOwnApp: true }),
    row('agent_off', 'Quiet', 'quiet', 'not_in_slack'),
    row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group', { channels: salesChannels }),
    row('agent_making', 'Standup', 'standup', 'creating'),
    row('agent_made', 'Events', 'events', 'creating', { slack: { state: 'creating', cancellable: true } }),
    row('agent_ready', 'Helpdesk', 'helpdesk', 'waiting_for_allow'),
    row('agent_token', 'Recruiting', 'recruiting', 'needs_attention', { slack: { state: 'needs_attention', reason: 'config_token_needed', cancellable: true } }),
    row('agent_stopped', 'Legal', 'legal', 'needs_attention', { slack: { state: 'needs_attention', reason: 'create_refused', cancellable: true } }),
    row('agent_removed', 'Ops', 'ops', 'needs_attention', { slack: { state: 'needs_attention', reason: 'app_removed' } }),
    row('agent_undo', 'Finance', 'finance', 'cancelling'),
    row('agent_support', 'Support', 'support', 'own_app'),
    row('agent_stale', 'Research', 'research', 'own_app', { slack: { state: 'own_app', attention: 'update_refused' } }),
    row('agent_tokenless', 'Payroll', 'payroll', 'own_app', { slack: { state: 'own_app', attention: 'config_token_needed' } }),
  ];
  const page = await harness({ api: apiState({ paused: true, token: { stored: false }, agents }) });
  const html = page.html();
  const text = page.text();
  assert.match(text, /Adding Slack apps is paused\. Agents that already have their own Slack app keep working\./);
  assert.doesNotMatch(text, /Each new Agent gets its own Slack app\./, 'the section never says new Agents get apps while none can');
  assert.match(html, /data-action="slack-apps-turn-off"[^>]*>Stop creating Slack apps for new Agents</, 'turning the setting off is still offered');
  assert.doesNotMatch(html, /data-action="slack-apps-(turn-on|token-open)"/, 'nothing that would create or change an app is');
  assert.deepEqual([...html.matchAll(/data-action="slack-apps-start" data-agent="([^"]+)"/g)].map((match) => match[1]), ['agent_ready'],
    'Add is offered only where Allow is all that is left');
  assert.doesNotMatch(text, /Chickpea has no Slack token/, 'nor is a token asked for');

  assert.match(text, /Scout Adding Slack apps is paused\. To give Scout an @handle people can mention now, choose Stop creating Slack apps for new Agents\./);
  assert.doesNotMatch(text, /To give Quiet/, 'only an Agent turning the setting off would place is told it would');
  assert.match(text, /Standup @standup Adding Slack apps is paused\. Standup keeps answering as it does now\./);
  assert.doesNotMatch(html, /data-action="slack-apps-cancel" data-agent="agent_making"/, 'a create with no app yet has nothing to cancel');
  assert.match(text, /Events @events Adding Slack apps is paused\. Events keeps answering as it does now\./);
  assert.match(html, /data-action="slack-apps-cancel" data-agent="agent_made"[^>]*>Cancel</, 'an app Slack made, not yet allowed, offers Cancel');
  assert.match(text, /Helpdesk @helpdesk Ready\. Add Helpdesk to Slack to finish\./, 'waiting for Allow is the ordinary row');
  assert.match(html, /data-action="slack-apps-start" data-agent="agent_ready"[^>]*>Add Helpdesk to Slack</);
  assert.match(html, /data-action="slack-apps-cancel" data-agent="agent_ready"[^>]*>Cancel</, 'waiting for Allow offers Cancel');
  assert.match(text, /Recruiting @recruiting Adding Slack apps is paused\. Recruiting keeps answering as it does now\./);
  assert.match(html, /data-action="slack-apps-cancel" data-agent="agent_token"[^>]*>Cancel</, 'stopped after Slack made the app, Cancel removes it');
  assert.match(html, /data-action="slack-apps-cancel" data-agent="agent_stopped"[^>]*>Cancel</, 'stopped before any app, Cancel withdraws it');
  assert.match(text, /Sales Desk @sales-desk #sales #deals/);
  assert.doesNotMatch(text, /Sales Desk @sales-desk #sales #deals [^ ]+ Adding Slack apps is paused/, 'an Agent in a user group just stays as it is');

  assert.match(text, /Ops(&#39;|')s Slack app was removed from this workspace/, 'a removed app reads as always: its Allow still works');
  assert.match(html, /data-action="slack-apps-cancel" data-agent="agent_undo"[^>]*>Finish removing</, 'and so does finishing a Cancel');
  assert.match(text, /Support @support Its own Slack app/, 'an Agent with its own app is unchanged');
  for (const name of ['Research', 'Payroll']) {
    assert.match(text, new RegExp(`${name} @${name.toLowerCase()} Adding Slack apps is paused\\. Chickpea can(&#39;|')t update ${name}(&#39;|')s Slack app now\\. ${name} keeps answering\\.`),
      'a live app that does not match its Agent says it waits, and offers neither Try again nor a token');
  }

  const tokenPage = await harness({ path: '/admin/destinations/slack/connection/token', api: apiState({ paused: true, token: { stored: false } }) });
  assert.match(tokenPage.text(), /Adding Slack apps is paused, so Chickpea isn(&#39;|')t taking a Slack token now\./, 'the token page, as a link in an older message opens it, says so');
  assert.doesNotMatch(tokenPage.html(), /id="slack-apps-token"|slack-apps-token-form/, 'and asks for no token');

  const off = await harness({ api: apiState({ paused: true, setting: { mode: 'shared', changedBy: null, changedAt: null }, agents: [] }) });
  assert.match(off.text(), /Agents answer through the Chickpea app\. People mention them by @handle in channels Chickpea is in\. Adding Slack apps is paused\./);
  assert.doesNotMatch(off.html(), /data-action="slack-apps-turn-on"/, 'off, the setting cannot be turned on');
  assert.match(off.html(), /data-action="slack-apps-token-remove"/, 'and the token can still be removed');
});

// Defect caught: a pause that begins after the page loaded answered with "couldn't reach Slack", or not reflected.
test('a Start or a turn-on the server refuses as paused reloads the section into its paused state', async () => {
  const page = await harness({
    handle: (path, method) => {
      if (path.endsWith('/start')) {
        page.api.paused = true;
        return respond({ error: 'paused', agent: row('agent_sales', 'Sales Desk', 'sales-desk', 'user_group', { channels: salesChannels }) }, 409);
      }
      if (path === '/admin/api/slack-apps/mode' && method === 'PUT') return respond({ error: 'paused' }, 409);
      return undefined;
    },
  }) as Awaited<ReturnType<typeof harness>>;
  await page.click({ 'data-action': 'slack-apps-start', 'data-agent': 'agent_sales' });
  assert.doesNotMatch(page.text(), /couldn(’|&#39;|')t reach Slack/);
  assert.match(page.text(), /Adding Slack apps is paused\. Agents that already have their own Slack app keep working\./);
  assert.doesNotMatch(page.html(), /data-action="slack-apps-start"/);
});

test('paused, onboarding has no Slack apps step', async () => {
  const initial = {
    githubConnectPath: '/github/connect', stage: 'connect_github', revision: '{"revision":1}', agentId: 'agent_chickpea', redirectTo: null,
    workspace: { id: 'TACME', name: 'Acme' }, channel: null, providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-5',
    models: [], slackAppId: 'AACME', tryStartedAt: 1_800_000_000_000, completedAt: null,
  };
  const bar = (paused: boolean) => stepBar(renderAdminPage({
    agentSlackAppsOffered: true, agentSlackAppsPaused: paused, selfHosted: false, installationOwner: true,
    onboarding: { initial, githubConnectPath: '/github/connect' },
  })).map((step) => step.split(' (')[0]);
  assert.ok(bar(false).includes('Slack apps'));
  assert.deepEqual(bar(true), ['Add to Slack', 'Choose provider', 'Choose model', 'Connect GitHub', 'Try Chickpea']);
});

// Defects caught: a row whose app Slack made before Allow offering no Cancel, so it can only be archived; an archive Slack
// refused to finish offering a Try again that cannot work.
test('a row whose app Slack made but nobody allowed offers Cancel, and an unfinished archive says to archive again', async () => {
  const agents = [
    row('agent_made', 'Events', 'events', 'creating', { slack: { state: 'creating', cancellable: true } }),
    row('agent_making', 'Standup', 'standup', 'creating'),
    row('agent_urls', 'Legal', 'legal', 'needs_attention', { slack: { state: 'needs_attention', reason: 'urls_refused', cancellable: true } }),
    row('agent_archive', 'Finance', 'finance', 'needs_attention', { slack: { state: 'needs_attention', reason: 'uninstall_failed' } }),
  ];
  const page = await harness({ clock: true, api: apiState({ agents }) });
  await page.advance(2 * 60_000 + 4_000);
  const html = page.html();
  assert.match(page.text(), /Creating Events(&#39;|')s Slack app hasn(&#39;|')t finished\. Choose Try again\./);
  for (const id of ['agent_made', 'agent_urls']) {
    assert.match(html, new RegExp(`data-action="slack-apps-start" data-agent="${id}"[^>]*>Try again<`), id);
    assert.match(html, new RegExp(`data-action="slack-apps-cancel" data-agent="${id}"[^>]*>Cancel<`), `${id}: and Cancel`);
  }
  assert.doesNotMatch(html, /data-action="slack-apps-cancel" data-agent="agent_making"/, 'a create with no app yet has nothing to cancel');
  assert.match(page.text(), /Chickpea couldn(&#39;|')t remove Finance(&#39;|')s Slack app, so Finance is not archived\. Archive Finance again to finish\./);
  assert.doesNotMatch(html, /data-agent="agent_archive"/, 'with no Try again that cannot work');

  const paused = await harness({ api: apiState({ paused: true, agents }) });
  assert.match(paused.html(), /data-action="slack-apps-cancel" data-agent="agent_urls"[^>]*>Cancel</, 'paused, Cancel is still offered');
  assert.match(paused.text(), /Archive Finance again to finish\./);
});
