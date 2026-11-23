import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  slack: { state: string; reason?: string };
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
  handle?: (path: string, method: string, body: unknown) => FakeResponse | Promise<FakeResponse | undefined> | undefined;
  navigator?: Record<string, unknown>;
} = {}) {
  const api = options.api ?? apiState();
  let html = '';
  const app = { className: '', get innerHTML() { return html; }, set innerHTML(value: string) { html = value; }, removeAttribute() {} };
  const field = { id: 'slack-apps-token', value: '', disabled: false, focus() {} };
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
    querySelector(selector: string) { return selector === '.main-inner' ? { set innerHTML(value: string) { throw new Error(`Admin failed to load: ${value}`); } } : null; },
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
      return respond({ token: api.token, slackMayStillAccept: false });
    }
    return respond({ error: 'not_found' }, 404);
  };
  const script = renderAdminPage({ agentSlackAppsOffered: options.offered !== false }).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    console, Date, document, fetch, JSON, location, URL, URLSearchParams,
    history: {
      pushState(_state: unknown, _title: string, path: string) { location.pathname = new URL(path, 'https://chickpea.example').pathname; },
      replaceState(_state: unknown, _title: string, path: string) { location.pathname = new URL(path, 'https://chickpea.example').pathname; },
    },
    navigator: options.navigator ?? {},
    window: {
      addEventListener(type: string, listener: Listener) { if (!windowListeners[type]) windowListeners[type] = listener; },
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
  const paste = async (text: string) => {
    let prevented = false;
    listeners.paste!({ target: field, clipboardData: { getData: () => text }, preventDefault() { prevented = true; } });
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
  return { html: () => html, text: () => visibleText(html), api, field, requests, assigned, storage, location, click, paste, submit, focusWindow, listeners };
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
  assert.match(text, /Copy the Refresh Token and paste it here\./);
  assert.match(page.html(), /class="slack-token-row highlighted"><span class="slack-token-label">Refresh Token</);
  assert.match(page.html(), /<input id="slack-apps-token" class="input mono" type="password"/);
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
  ['a token for another workspace', 400, 'other_workspace', 'xoxe-1-other', 'That token is for a different Slack workspace. Generate one for Acme.'],
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
    /agent_[a-z]+/, /\bC0[A-Z]+\b/, /\bG0PIPE\b/, /UOWNER/, /user_group|not_in_slack|waiting_for_allow|needs_attention|own_app|config_token_needed|slack_busy/,
  ]) {
    assert.doesNotMatch(text, internal);
  }
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
  assert.match(back.text(), /Sales Desk is now its own Slack app\. People keep using @sales-desk\. It joined #sales and #deals\. In pipeline-private it keeps answering through Chickpea until someone there adds it\./);
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
  assert.match(page.text(), /Chickpea deleted its copy of your configuration token, and the token no longer works\./);
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

test('the browser follows only an https Allow URL', async () => {
  for (const authorizeUrl of ['http://slack.com/oauth', 'javascript:alert(1)', '']) {
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

test('back from Slack, a refresh token the browser already lets the page read fills the field, and nothing is sent or asked', async () => {
  const clipboard = (permission: string) => {
    const reads: string[] = [];
    return {
      reads,
      navigator: {
        permissions: { query: async () => ({ state: permission }) },
        clipboard: { readText: async () => { reads.push('read'); return 'xoxe-1-from-the-clipboard'; } },
      },
    };
  };
  const granted = clipboard('granted');
  const page = await harness({ path: '/admin/destinations/slack/connection/token', navigator: granted.navigator });
  await page.focusWindow();
  assert.equal(page.field.value, '', 'nothing before the Owner opened Slack');
  await page.click({ 'data-action': 'slack-apps-open-settings' });
  await page.focusWindow();
  assert.equal(page.field.value, 'xoxe-1-from-the-clipboard');
  assert.equal(page.requests.some((request) => request.path === '/admin/api/slack-apps/token'), false, 'never sent until the Owner sends it');
  assert.equal(page.html().includes('xoxe-1-from'), false);

  const prompt = clipboard('prompt');
  const asking = await harness({ path: '/admin/destinations/slack/connection/token', navigator: prompt.navigator });
  await asking.click({ 'data-action': 'slack-apps-open-settings' });
  await asking.focusWindow();
  assert.deepEqual(prompt.reads, [], 'the clipboard is never read when reading it would ask');
  assert.equal(asking.field.value, '');
});
