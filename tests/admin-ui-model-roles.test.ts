import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';

// The Admin client is a static asset executed here the way the browser runs it:
// the shell's inline script inside a fake document, driven through its own
// document-level listeners. This file owns the image model role surface only;
// the broader page contract lives in tests/admin-page.test.ts.

const FLARE = 'openai/gpt-image-2.5-flare';
const SUNBURST = 'openai/gpt-image-2.5-sunburst';
const CHAT_MODEL = 'local-stub/release';

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type Listener = (event: { target: unknown; key?: string; preventDefault?(): void }) => void;

interface ImageCatalogFixture {
  models: Array<{
    id: string;
    name: string;
    providerId: string;
    acceptsImageInput: boolean;
    fasterAndCheaper: boolean;
  }>;
  providers: Array<{ id: string; configured: boolean }>;
}

interface ImageRoleFixture {
  workspaceId: string;
  role: 'image';
  modelId: string | null;
  revision: number;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function actionTarget(attributes: Record<string, string>): unknown {
  return {
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

/** A click inside the combobox popover: `closest` also matches `.model-combo`. */
function comboTarget(attributes: Record<string, string>): unknown {
  return {
    closest(selector: string) {
      return selector === '[data-action]' || selector === '.model-combo' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function valueTarget(attributes: Record<string, string>, value: string): unknown {
  return {
    value,
    closest() {
      return null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function imageCatalog(configured: boolean): ImageCatalogFixture {
  if (!configured) return { models: [], providers: [{ id: 'openai', configured: false }] };
  return {
    models: [
      {
        id: FLARE,
        name: 'GPT Image 2.5 Flare',
        providerId: 'openai',
        acceptsImageInput: true,
        fasterAndCheaper: true,
      },
      {
        id: SUNBURST,
        name: 'GPT Image 2.5 Sunburst',
        providerId: 'openai',
        acceptsImageInput: true,
        fasterAndCheaper: false,
      },
    ],
    providers: [{ id: 'openai', configured: true }],
  };
}

const releaseAgent = {
  id: 'agent_release',
  kind: 'user',
  revision: 3,
  name: 'Release Profile',
  description: 'Release readiness profile',
  instructions: 'Answer with release context.',
  enabled: true,
  model: CHAT_MODEL,
  imageModel: null as string | null,
  imageModelPolicy: { source: 'workspace_default', effectiveModel: FLARE },
  modelPolicy: { source: 'pinned', effectiveModel: CHAT_MODEL, live: true },
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
  canEdit: true,
  tabs: ['instructions', 'skills', 'connectors', 'repositories', 'memory', 'schedules', 'model'],
};

interface HarnessOptions {
  initialPath?: string;
  imageModels?: ImageCatalogFixture;
  imageRole?: ImageRoleFixture | null;
  imageRolePutError?: { status: number; body: Record<string, unknown> };
  /** Number of leading /admin/api/image-models GETs answered with a failure. */
  imageModelsFailures?: number;
  deferImageRolePut?: boolean;
  agents?: Array<Record<string, unknown>>;
}

function runHarness(options: HarnessOptions = {}) {
  const app = { innerHTML: '' };
  const modalRoot = { innerHTML: '' };
  const region = {
    inert: false,
    setAttribute() {},
    getAttribute() {
      return null;
    },
    hasAttribute() {
      return false;
    },
    removeAttribute() {},
  };
  const listeners: Record<string, Listener> = {};
  const windowListeners: Record<string, Listener> = {};
  const imageRolePuts: Array<{ modelId: string | null; expectedRevision: number }> = [];
  const agentPatchBodies: Array<{ id: string; body: Record<string, unknown> }> = [];
  const fetchCalls: Array<{ path: string; method: string }> = [];
  let imageRolePutResolver: ((response: FakeResponse) => void) | null = null;
  let imageModelCalls = 0;
  let focusedAction: string | null = null;

  const imageModels = options.imageModels ?? imageCatalog(true);
  let imageRole: ImageRoleFixture | null = options.imageRole === undefined
    ? { workspaceId: 'T_DESIGN', role: 'image', modelId: null, revision: 0 }
    : options.imageRole;
  const agents = (options.agents ?? [releaseAgent]).map((agent) => ({ ...agent }));

  const workspaceDefault = {
    workspaceId: 'T_DESIGN',
    modelId: CHAT_MODEL,
    revision: 2,
    provenance: 'admin_selected',
    runtimeContract: 'chickpea-v1',
    live: true,
    inheritingAgentCount: 1,
    health: { status: 'ready', providerId: 'local-stub' },
  };

  const focusElement = (action: string) => ({
    focus() {
      focusedAction = action;
    },
    select() {},
    setSelectionRange() {},
  });

  const imageModelInput = { value: '' };

  const document = {
    visibilityState: 'visible',
    activeElement: null,
    getElementById(id: string) {
      if (id === 'app') return app;
      if (id === 'modal-root') return modalRoot;
      if (id === 'p-image-model' && app.innerHTML.includes('id="p-image-model"')) {
        return imageModelInput;
      }
      if (id.startsWith('ptab-') && app.innerHTML.includes(`id="${id}"`)) return focusElement(id);
      return null;
    },
    querySelector(selector: string) {
      if (selector === '.main-inner') return app;
      if (selector === '.topbar' || selector === '.body' || selector === '.main') return region;
      const modelPolicyAction = selector.match(
        /^\[data-action="(workspace-default-model|workspace-image-model|profile-model|profile-image-model)"\]$/,
      )?.[1];
      if (modelPolicyAction && app.innerHTML.includes(`data-action="${modelPolicyAction}"`)) {
        return focusElement(modelPolicyAction);
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type: string, listener: Listener) {
      listeners[type] = listener;
    },
    createElement() {
      return { style: {}, setAttribute() {}, appendChild() {}, submit() {} };
    },
  };

  const fetch = (path: string, init?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = init?.method ?? 'GET';
    fetchCalls.push({ path, method });
    if (path === '/admin/api/agents' && method === 'GET') {
      return Promise.resolve(jsonResponse({ agents }));
    }
    const agentDetail = path.match(/^\/admin\/api\/agents\/([^/?]+)$/);
    if (agentDetail && method === 'GET') {
      const agent = agents.find((candidate) => candidate.id === agentDetail[1]);
      return Promise.resolve(agent
        ? jsonResponse({ agent })
        : jsonResponse({ error: 'not_found' }, 404));
    }
    if (agentDetail && method === 'PATCH') {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      agentPatchBodies.push({ id: agentDetail[1] as string, body });
      const agent = agents.find((candidate) => candidate.id === agentDetail[1]);
      if (agent) {
        agent.revision = Number(agent.revision) + 1;
        agent.imageModel = (body.imageModel as string | null) ?? null;
        agent.imageModelPolicy = {
          source: body.imageModel ? 'pinned' : 'workspace_default',
          effectiveModel: (body.imageModel as string | null) ?? imageRole?.modelId ?? null,
        };
      }
      return Promise.resolve(jsonResponse({ agent }));
    }
    if (path === '/admin/api/models') {
      return Promise.resolve(jsonResponse({
        providers: [{
          id: 'local-stub',
          configured: true,
          source: 'registered in src/app.ts',
          suggestions: [CHAT_MODEL],
        }],
      }));
    }
    if (path === '/admin/api/image-models') {
      imageModelCalls += 1;
      if (imageModelCalls <= (options.imageModelsFailures ?? 0)) {
        return Promise.resolve(jsonResponse({ error: 'image_catalog_unavailable' }, 503));
      }
      return Promise.resolve(jsonResponse({ ...imageModels }));
    }
    if (path === '/admin/api/channels') {
      return Promise.resolve(jsonResponse({ channels: [] }));
    }
    if (path.startsWith('/admin/api/workspace-model-default')) {
      return Promise.resolve(jsonResponse({ workspaceDefault }));
    }
    if (path.startsWith('/admin/api/workspace-model-roles/image')) {
      if (method === 'PUT') {
        const body = JSON.parse(init?.body ?? '{}') as {
          modelId: string | null;
          expectedRevision: number;
        };
        imageRolePuts.push(body);
        const respond = (): FakeResponse => {
          if (options.imageRolePutError) {
            return jsonResponse(options.imageRolePutError.body, options.imageRolePutError.status);
          }
          imageRole = {
            workspaceId: 'T_DESIGN',
            role: 'image',
            modelId: body.modelId,
            revision: (imageRole?.revision ?? 0) + 1,
          };
          return jsonResponse({ workspaceModelRole: { ...imageRole } });
        };
        if (options.deferImageRolePut) {
          return new Promise<FakeResponse>((resolve) => {
            imageRolePutResolver = () => resolve(respond());
          });
        }
        return Promise.resolve(respond());
      }
      return Promise.resolve(imageRole
        ? jsonResponse({ workspaceModelRole: { ...imageRole } })
        : jsonResponse({ error: 'workspace_installation_required' }, 409));
    }
    if (path === '/admin/api/providers') {
      return Promise.resolve(jsonResponse({
        providers: [{ id: 'openai', status: imageModels.providers[0]?.configured ? 'stored' : 'missing', modelCount: null }],
      }));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  };

  const location = {
    pathname: '/admin',
    search: '',
    hash: '',
    origin: 'https://admin.example',
    href: 'https://admin.example' + (options.initialPath ?? '/admin'),
    assign() {},
  };
  const history = {
    pushState(_state: unknown, _title: string, path: string) {
      applyPath(path);
    },
    replaceState(_state: unknown, _title: string, path: string) {
      applyPath(path);
    },
  };
  function applyPath(path: string) {
    const [pathname, search] = String(path).split('?');
    location.pathname = pathname ?? '/admin';
    location.search = search ? `?${search}` : '';
  }

  applyPath(options.initialPath ?? '/admin');

  const sessionStorage = {
    getItem() {
      return null;
    },
    setItem() {},
    removeItem() {},
  };

  const script = renderAdminPage().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'admin page should include one inline script');

  vm.runInNewContext(
    script,
    {
      document,
      fetch,
      console,
      URL,
      URLSearchParams,
      navigator: {},
      setTimeout,
      clearTimeout,
      window: {
        addEventListener(type: string, listener: Listener) {
          windowListeners[type] = listener;
        },
        scrollTo() {},
        scrollX: 0,
        scrollY: 0,
        pageXOffset: 0,
        pageYOffset: 0,
        open() {
          return null;
        },
        setTimeout,
        location,
        history,
        sessionStorage,
      },
      sessionStorage,
      history,
      location,
    },
    { filename: 'admin-ui-model-roles.js' },
  );

  return {
    app,
    listeners,
    imageRolePuts,
    agentPatchBodies,
    fetchCalls,
    focusedAction: () => focusedAction,
    imageModelInput,
    resolveImageRolePut() {
      assert.ok(imageRolePutResolver, 'expected an image role PUT to be pending');
      const resolve = imageRolePutResolver;
      imageRolePutResolver = null;
      resolve(jsonResponse({}));
    },
  };
}

test('Settings offers the default image model with the consent and cost note', async () => {
  const harness = runHarness({ initialPath: '/admin/settings/providers' });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /id="workspace-image-model-heading">Default image model<\/h2>/);
  assert.match(html, /data-action="workspace-image-model"/);
  assert.match(html, new RegExp(`<option value="${FLARE.replace('/', '\\/')}"`));
  assert.match(html, new RegExp(`<option value="${SUNBURST.replace('/', '\\/')}"`));
  // R16: the disclosure sits with the picker and names the prompt text.
  const note = html.slice(html.indexOf('data-action="workspace-image-model"'));
  assert.match(note, /prompt text/);
  assert.match(note, /images people post/);
  assert.match(note, /faster, cheaper/);
  assert.match(note, /GPT Image 2\.5 Flare/);
  // Nothing changed yet, so Save cannot be pressed.
  assert.match(html, /data-action="workspace-image-model-save" disabled/);
});

test('an Owner can clear the default image model back to Not set', async () => {
  const harness = runHarness({
    initialPath: '/admin/settings/providers',
    imageRole: { workspaceId: 'T_DESIGN', role: 'image', modelId: FLARE, revision: 4 },
  });
  await flushAsync();

  // A set role renders Ready and offers Not set as a real choice.
  assert.match(harness.app.innerHTML, /badge badge-on"><span class="dot"><\/span>Ready/);
  assert.match(harness.app.innerHTML, /<option value="">Not set<\/option>/);

  const change = harness.listeners.change;
  const click = harness.listeners.click;
  assert.ok(change && click);

  change({ target: valueTarget({ 'data-action': 'workspace-image-model' }, '') });
  await flushAsync();
  // Not set differs from the stored model, so Save is live.
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workspace-image-model-save" disabled/);

  click({ target: actionTarget({ 'data-action': 'workspace-image-model-save' }) });
  await flushAsync();
  assert.deepEqual(harness.imageRolePuts, [{ modelId: null, expectedRevision: 4 }]);

  const html = harness.app.innerHTML;
  assert.match(html, /<option value="" selected>Not set<\/option>/);
  assert.match(html, /badge badge-off"><span class="dot"><\/span>Not set/);
  assert.match(html, /Default image model cleared/);
  assert.match(html, /lose the image tool/);
  // Nothing left to change, so Save is disabled again.
  assert.match(html, /data-action="workspace-image-model-save" disabled/);
  assert.equal(harness.focusedAction(), 'workspace-image-model');
});

test('an already unset default image model offers Not set with Save disabled', async () => {
  const harness = runHarness({ initialPath: '/admin/settings/providers' });
  await flushAsync();

  // The role starts unset: Not set is the selected option, the badge reads off,
  // and Save stays disabled because the draft already matches the stored value.
  const html = harness.app.innerHTML;
  assert.match(html, /badge badge-off"><span class="dot"><\/span>Not set/);
  assert.match(html, /<option value="" selected>Not set<\/option>/);
  assert.match(html, /data-action="workspace-image-model-save" disabled/);
  assert.deepEqual(harness.imageRolePuts, []);
});

test('Settings hints at connecting OpenAI instead of rendering an empty image select', async () => {
  const harness = runHarness({
    initialPath: '/admin/settings/providers',
    imageModels: imageCatalog(false),
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /id="workspace-image-model-heading">Default image model<\/h2>/);
  assert.doesNotMatch(html, /data-action="workspace-image-model"/);
  assert.match(html, /Connect OpenAI/);
});

test('saving the default image model sends the current revision and re-renders the readback', async () => {
  const harness = runHarness({
    initialPath: '/admin/settings/providers',
    imageRole: { workspaceId: 'T_DESIGN', role: 'image', modelId: FLARE, revision: 4 },
    deferImageRolePut: true,
  });
  await flushAsync();

  const change = harness.listeners.change;
  const click = harness.listeners.click;
  assert.ok(change && click);

  change({ target: valueTarget({ 'data-action': 'workspace-image-model' }, SUNBURST) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workspace-image-model-save" disabled/);

  click({ target: actionTarget({ 'data-action': 'workspace-image-model-save' }) });
  await flushAsync();
  assert.deepEqual(harness.imageRolePuts, [{ modelId: SUNBURST, expectedRevision: 4 }]);
  // Busy: the select and Save are both disabled until the write settles.
  assert.match(harness.app.innerHTML, /data-action="workspace-image-model-save" disabled/);
  assert.match(harness.app.innerHTML, /Saving/);

  harness.resolveImageRolePut();
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.match(html, new RegExp(`<option value="${SUNBURST.replace('/', '\\/')}" selected>`));
  assert.match(html, /Default image model saved/);
  assert.match(html, /data-action="workspace-image-model-save" disabled/);
  assert.equal(harness.focusedAction(), 'workspace-image-model');
});

test('a stale image role revision surfaces the conflict and reloads the readback', async () => {
  const harness = runHarness({
    initialPath: '/admin/settings/providers',
    imageRole: { workspaceId: 'T_DESIGN', role: 'image', modelId: FLARE, revision: 1 },
    imageRolePutError: {
      status: 409,
      body: {
        error: 'model_role_revision_conflict',
        expectedRevision: 1,
        actualRevision: 2,
        workspaceModelRole: {
          workspaceId: 'T_DESIGN',
          role: 'image',
          modelId: SUNBURST,
          revision: 2,
        },
      },
    },
  });
  await flushAsync();

  const change = harness.listeners.change;
  const click = harness.listeners.click;
  assert.ok(change && click);
  change({ target: valueTarget({ 'data-action': 'workspace-image-model' }, SUNBURST) });
  click({ target: actionTarget({ 'data-action': 'workspace-image-model-save' }) });
  await flushAsync();

  assert.deepEqual(harness.imageRolePuts, [{ modelId: SUNBURST, expectedRevision: 1 }]);
  const html = harness.app.innerHTML;
  assert.match(html, /changed in another session/);
  assert.match(html, new RegExp(`<option value="${SUNBURST.replace('/', '\\/')}" selected>`));

  // The reloaded readback carries the newer revision, so a second save is clean.
  click({ target: actionTarget({ 'data-action': 'workspace-image-model-save' }) });
  await flushAsync();
  assert.deepEqual(harness.imageRolePuts[1], { modelId: SUNBURST, expectedRevision: 2 });
});

test('an image model whose provider credential is gone shows repair required', async () => {
  const harness = runHarness({
    initialPath: '/admin/settings/providers',
    imageModels: imageCatalog(false),
    imageRole: { workspaceId: 'T_DESIGN', role: 'image', modelId: SUNBURST, revision: 3 },
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /Repair required/);
  assert.match(html, /href="\/admin\/settings\/providers">Review openai provider settings<\/a>/);
  assert.match(html, new RegExp(SUNBURST.replace('/', '\\/')));
});

test('the Agent image picker lists image models only', async () => {
  const harness = runHarness({ initialPath: '/admin/agents/agent_release?tab=model' });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  assert.match(harness.app.innerHTML, /id="p-image-model"/);

  click({ target: comboTarget({ 'data-action': 'profile-image-model' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  const picker = html.slice(html.indexOf('id="p-image-model"'));
  assert.match(picker, new RegExp(`data-action="pick-image-model" data-model="${FLARE.replace('/', '\\/')}"`));
  assert.match(picker, new RegExp(`data-action="pick-image-model" data-model="${SUNBURST.replace('/', '\\/')}"`));
  assert.doesNotMatch(picker, new RegExp(`data-action="pick-image-model" data-model="${CHAT_MODEL.replace('/', '\\/')}"`));
});

test('the system Agent has no image model override field', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_chickpea?tab=model',
    agents: [{ ...releaseAgent, id: 'agent_chickpea', kind: 'system', name: 'Chickpea' }],
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.doesNotMatch(html, /id="p-image-model"/);
  assert.doesNotMatch(html, /data-action="profile-image-model"/);
  // The chat model field is still the one the Model tab renders.
  assert.match(html, /id="p-model"/);
});

test('an Agent image override is saved and reads back as Pinned on its card', async () => {
  const harness = runHarness({ initialPath: '/admin/agents/agent_release?tab=model' });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: comboTarget({ 'data-action': 'profile-image-model' }) });
  await flushAsync();
  click({
    target: comboTarget({ 'data-action': 'pick-image-model', 'data-model': SUNBURST }),
  });
  await flushAsync();
  assert.equal(harness.imageModelInput.value, SUNBURST);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.equal(harness.agentPatchBodies[0]?.body.imageModel, SUNBURST);

  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  await flushAsync();
  const card = harness.app.innerHTML;
  assert.match(card, /Image <span class="badge-src">Pinned<\/span>/);
  assert.match(card, new RegExp(SUNBURST.replace('/', '\\/')));
});

/**
 * The image catalog loads once with the page data so the Agent Model tab has it
 * without ever opening Settings; Settings must not re-fetch what is already in
 * state, but it must still retry a catalog whose boot fetch failed.
 */
function imageCatalogCalls(harness: { fetchCalls: Array<{ path: string; method: string }> }): number {
  return harness.fetchCalls.filter((call) => call.path === '/admin/api/image-models').length;
}

function openSettingsProviders(click: Listener): void {
  click({
    target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'providers' }),
  });
}

test('opening Settings reuses the image catalog the page already loaded', async () => {
  const harness = runHarness();
  await flushAsync();
  assert.equal(imageCatalogCalls(harness), 1, 'the page data load owns the only catalog fetch');

  const click = harness.listeners.click;
  assert.ok(click);
  openSettingsProviders(click);
  await flushAsync();

  assert.equal(imageCatalogCalls(harness), 1, 'Settings renders the catalog already in state');
  assert.match(harness.app.innerHTML, /data-action="workspace-image-model"/);
});

test('opening Settings retries the image catalog when the page load failed', async () => {
  const harness = runHarness({ imageModelsFailures: 1 });
  await flushAsync();
  assert.equal(imageCatalogCalls(harness), 1);
  // The failed load left the empty state, not the select.
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workspace-image-model"/);

  const click = harness.listeners.click;
  assert.ok(click);
  openSettingsProviders(click);
  await flushAsync();

  assert.equal(imageCatalogCalls(harness), 2, 'a failed catalog is refetched on Settings open');
  assert.match(harness.app.innerHTML, /data-action="workspace-image-model"/);
  assert.match(harness.app.innerHTML, new RegExp(`<option value="${FLARE.replace('/', '\\/')}"`));
});
