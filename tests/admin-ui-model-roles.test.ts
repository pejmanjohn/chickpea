import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

import { renderAdminPageWithInlineAssets as renderAdminPage } from './helpers/admin-ui.ts';

// The Admin client is a static asset executed here the way the browser runs it:
// the shell's inline script inside a fake document, driven through its own
// document-level listeners. This file owns the model role and effort surfaces;
// the broader page contract lives in tests/admin-page.test.ts.

const FLARE = 'openai/gpt-image-2.5-flare';
const SUNBURST = 'openai/gpt-image-2.5-sunburst';
const CHATGPT_IMAGE = 'openai/chatgpt-image';
const CHAT_MODEL = 'local-stub/release';
const OPUS = 'anthropic/claude-opus-5-5';
const SONNET = 'anthropic/claude-sonnet-5';
const HAIKU = 'anthropic/claude-haiku-4-5';
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const HAIKU_EFFORTS = ['low', 'medium', 'high'];

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
    authMethod: 'api_key' | 'subscription';
    maxOutputs: number;
    supportsOutputControls: boolean;
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
        authMethod: 'api_key',
        maxOutputs: 10,
        supportsOutputControls: true,
      },
      {
        id: SUNBURST,
        name: 'GPT Image 2.5 Sunburst',
        providerId: 'openai',
        acceptsImageInput: true,
        fasterAndCheaper: false,
        authMethod: 'api_key',
        maxOutputs: 10,
        supportsOutputControls: true,
      },
      {
        id: CHATGPT_IMAGE,
        name: 'ChatGPT Image',
        providerId: 'openai',
        acceptsImageInput: false,
        fasterAndCheaper: false,
        authMethod: 'subscription',
        maxOutputs: 1,
        supportsOutputControls: false,
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

/** The levels each model accepts, as /admin/api/model-efforts answers them. */
const MODEL_EFFORTS: Record<string, string[]> = {
  [OPUS]: ALL_EFFORTS,
  [SONNET]: ALL_EFFORTS,
  [HAIKU]: HAIKU_EFFORTS,
  [CHAT_MODEL]: [],
};

function standardEffort(efforts: string[]): string | null {
  return ['medium', 'high', 'xhigh', 'max', 'low'].find((level) => efforts.includes(level)) ?? null;
}

function effortProjection(model: string | null, effort: string | null) {
  const efforts = model ? MODEL_EFFORTS[model] ?? [] : [];
  return { effort, efforts, standardEffort: standardEffort(efforts) };
}

interface WorkspaceDefaultFixture {
  modelId: string;
  effort: string | null;
  revision: number;
}

interface HarnessOptions {
  initialPath?: string;
  workspaceDefault?: WorkspaceDefaultFixture;
  agentPatchError?: { status: number; body: Record<string, unknown> };
  imageModels?: ImageCatalogFixture;
  imageRole?: ImageRoleFixture | null;
  imageRolePutError?: { status: number; body: Record<string, unknown> };
  /** Number of leading /admin/api/image-models GETs answered with a failure. */
  imageModelsFailures?: number;
  deferImageRolePut?: boolean;
  agents?: Array<Record<string, unknown>>;
  codingRole?: CodingRoleFixture;
}

interface CodingRoleFixture {
  workspaceId: string;
  role: 'coding';
  modelId: string | null;
  effort?: string | null;
  revision: number;
  ready: boolean | null;
}

function runHarness(options: HarnessOptions = {}) {
  // The chat model input reads back the value each render writes, the way the
  // browser's does; a pick then overwrites it before the draft collects it.
  const modelInput = { value: '' };
  let appHtml = '';
  const app = {
    get innerHTML() {
      return appHtml;
    },
    set innerHTML(html: string) {
      appHtml = html;
      modelInput.value = html.match(/id="p-model"[^>]* value="([^"]*)"/)?.[1] ?? '';
    },
  };
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
  const codingRolePuts: Array<{ modelId: string | null; effort?: string | null; expectedRevision: number }> = [];
  const workspaceDefaultPuts: Array<{ modelId: string; effort?: string | null; expectedRevision: number }> = [];
  let codingRole: CodingRoleFixture = options.codingRole ??
    { workspaceId: 'T_DESIGN', role: 'coding', modelId: null, revision: 0, ready: null };
  const agentPatchBodies: Array<{ id: string; body: Record<string, unknown> }> = [];
  const fetchCalls: Array<{ path: string; method: string }> = [];
  let imageRolePutResolver: ((response: FakeResponse) => void) | null = null;
  let imageModelCalls = 0;
  let focusedAction: string | null = null;

  const imageModels = options.imageModels ?? imageCatalog(true);
  let imageRole: ImageRoleFixture | null = options.imageRole === undefined
    ? { workspaceId: 'T_DESIGN', role: 'image', modelId: null, revision: 0 }
    : options.imageRole;
  const agents: Array<Record<string, unknown>> = (options.agents ?? [releaseAgent]).map((agent) => ({ ...agent }));

  const workspaceDefaultValue = (value: WorkspaceDefaultFixture) => ({
    workspaceId: 'T_DESIGN',
    modelId: value.modelId,
    ...effortProjection(value.modelId, value.effort),
    revision: value.revision,
    provenance: 'admin_selected',
    runtimeContract: 'chickpea-v1',
    live: true,
    inheritingAgentCount: 1,
    health: { status: 'ready', providerId: value.modelId.split('/')[0] },
  });
  let workspaceDefault = workspaceDefaultValue(
    options.workspaceDefault ?? { modelId: CHAT_MODEL, effort: null, revision: 2 },
  );

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
      if (id === 'p-model' && app.innerHTML.includes('id="p-model"')) return modelInput;
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
        /^\[data-action="(workspace-default-model|workspace-image-model|workspace-coding-model|profile-model|profile-image-model)"\]$/,
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
      if (options.agentPatchError) {
        return Promise.resolve(jsonResponse(options.agentPatchError.body, options.agentPatchError.status));
      }
      const agent = agents.find((candidate) => candidate.id === agentDetail[1]);
      if (agent) {
        agent.revision = Number(agent.revision) + 1;
        if (body.model !== undefined) {
          const model = (body.model as string | null) ?? null;
          const modelEffort = (body.modelEffort as string | null | undefined) ?? null;
          agent.model = model;
          agent.modelEffort = modelEffort;
          agent.modelPolicy = model
            ? { source: 'pinned', effectiveModel: model, ...effortProjection(model, modelEffort), live: true }
            : {
                source: 'workspace_default',
                effectiveModel: workspaceDefault.modelId,
                ...effortProjection(workspaceDefault.modelId, workspaceDefault.effort),
                live: true,
              };
        }
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
        }, {
          id: 'anthropic',
          configured: true,
          source: 'via ANTHROPIC_API_KEY',
          suggestions: [OPUS, SONNET, HAIKU],
        }],
      }));
    }
    if (path.startsWith('/admin/api/model-efforts?')) {
      const model = new URLSearchParams(path.slice(path.indexOf('?'))).get('model') ?? '';
      const efforts = MODEL_EFFORTS[model] ?? [];
      return Promise.resolve(jsonResponse({ model, efforts, standard: standardEffort(efforts) }));
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
      if (method === 'PUT') {
        const body = JSON.parse(init?.body ?? '{}') as { modelId: string; effort?: string | null; expectedRevision: number };
        workspaceDefaultPuts.push(body);
        workspaceDefault = workspaceDefaultValue({
          modelId: body.modelId,
          effort: body.effort ?? null,
          revision: workspaceDefault.revision + 1,
        });
      }
      return Promise.resolve(jsonResponse({ workspaceDefault }));
    }
    if (path.startsWith('/admin/api/workspace-model-roles/coding')) {
      if (method === 'PUT') {
        const body = JSON.parse(init?.body ?? '{}') as {
          modelId: string | null;
          effort?: string | null;
          expectedRevision: number;
        };
        codingRolePuts.push(body);
        codingRole = {
          ...codingRole,
          modelId: body.modelId,
          effort: body.effort ?? null,
          revision: codingRole.revision + 1,
          ready: body.modelId ? true : null,
        };
      }
      return Promise.resolve(jsonResponse({
        workspaceModelRole: { ...codingRole, ...effortProjection(codingRole.modelId, codingRole.effort ?? null) },
      }));
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
    codingRolePuts,
    workspaceDefaultPuts,
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
  assert.match(html, /Connect an OpenAI API key or ChatGPT subscription/);
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
  assert.match(picker, new RegExp(`data-action="pick-image-model" data-model="${CHATGPT_IMAGE.replace('/', '\\/')}"`));
  assert.match(picker, /openai\/chatgpt-image · ChatGPT subscription · generation only/);
  assert.doesNotMatch(picker, new RegExp(`data-action="pick-image-model" data-model="${CHAT_MODEL.replace('/', '\\/')}"`));
});

test('Settings explains the bounded ChatGPT Image capability beside the image picker', async () => {
  const harness = runHarness({
    initialPath: '/admin/settings/providers',
    imageRole: { workspaceId: 'T_DESIGN', role: 'image', modelId: CHATGPT_IMAGE, revision: 1 },
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /ChatGPT Image · openai\/chatgpt-image · ChatGPT subscription · generation only/);
  assert.match(html, /uses the connected ChatGPT subscription and generates one image per call/);
  assert.match(html, /It is generation only, and exact output settings are unavailable/);
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

test('Settings offers the default coding model from the chat models, unset by default', async () => {
  const harness = runHarness({ initialPath: '/admin/settings/providers' });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /id="workspace-coding-model-heading">Default coding model<\/h2>/);
  const section = html.slice(html.indexOf('workspace-coding-model-heading'));
  assert.match(section, /Used by coding workspaces\. Agents without one use their own model\./);
  assert.match(section, /<span class="dot"><\/span>Not set/);
  assert.match(section, /<option value="" selected>Not set<\/option>/);
  // The picker lists chat models, never the image catalog.
  assert.match(section, new RegExp(`<option value="${CHAT_MODEL.replace('/', '\\/')}"`));
  assert.doesNotMatch(section.slice(0, section.indexOf('</section>')), /gpt-image/);
  assert.match(html, /data-action="workspace-coding-model-save" disabled/);
  // The section sits beside the image model, after it.
  assert.ok(html.indexOf('workspace-image-model-heading') < html.indexOf('workspace-coding-model-heading'));
});

test('saving the default coding model sends the revision and re-renders the readback', async () => {
  const harness = runHarness({ initialPath: '/admin/settings/providers' });
  await flushAsync();
  const change = harness.listeners.change;
  const click = harness.listeners.click;
  assert.ok(change && click);

  change({ target: valueTarget({ 'data-action': 'workspace-coding-model' }, CHAT_MODEL) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workspace-coding-model-save" disabled/);
  click({ target: actionTarget({ 'data-action': 'workspace-coding-model-save' }) });
  await flushAsync();

  assert.deepEqual(harness.codingRolePuts, [{ modelId: CHAT_MODEL, expectedRevision: 0 }]);
  const html = harness.app.innerHTML;
  const section = html.slice(html.indexOf('workspace-coding-model-heading'));
  assert.match(section, new RegExp(`<option value="${CHAT_MODEL.replace('/', '\\/')}" selected>`));
  assert.match(section, /Default coding model saved/);
  assert.match(section, /<span class="dot"><\/span>Ready/);
  assert.equal(harness.focusedAction(), 'workspace-coding-model');

  // Clearing sends an explicit null.
  change({ target: valueTarget({ 'data-action': 'workspace-coding-model' }, '') });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'workspace-coding-model-save' }) });
  await flushAsync();
  assert.deepEqual(harness.codingRolePuts[1], { modelId: null, expectedRevision: 1 });
  assert.match(harness.app.innerHTML, /Default coding model cleared/);
});

test('a coding model whose provider is not ready shows repair required', async () => {
  const harness = runHarness({
    initialPath: '/admin/settings/providers',
    codingRole: { workspaceId: 'T_DESIGN', role: 'coding', modelId: 'openai/gpt-5.6-sol', revision: 3, ready: false },
  });
  await flushAsync();
  const html = harness.app.innerHTML;
  const section = html.slice(html.indexOf('workspace-coding-model-heading'));
  assert.match(section, /Repair required/);
  assert.match(section, /Review openai provider settings/);
  assert.match(section, /use each Agent&#39;s own model|use each Agent's own model/);
  // A stored choice the picker no longer lists stays selectable as itself.
  assert.match(section, /<option value="openai\/gpt-5\.6-sol" selected>/);
});

/** An Agent pinned to `model` at `effort`, projected the way the server does. */
function pinnedAgent(model: string, effort: string | null, fields: Record<string, unknown> = {}) {
  return {
    ...releaseAgent,
    model,
    modelEffort: effort,
    modelPolicy: { source: 'pinned', effectiveModel: model, ...effortProjection(model, effort), live: true },
    ...fields,
  };
}

/** The Effort radios in `html`, as `[level, checked, disabled]`. */
function effortRadios(html: string, action: string): Array<[string, boolean, boolean]> {
  return [...html.matchAll(/<button type="button" role="radio"[^>]*>/g)]
    .map((match) => match[0])
    .filter((button) => button.includes(`data-action="${action}"`))
    .map((button) => [
      button.match(/data-effort="([^"]+)"/)?.[1] ?? '',
      button.includes('aria-checked="true"'),
      / disabled[ >]/.test(button),
    ]);
}

function effortCount(harness: { fetchCalls: Array<{ path: string }> }): number {
  return harness.fetchCalls.filter((call) => call.path.startsWith('/admin/api/model-efforts')).length;
}

function chooseEffortTarget(action: string, level: string): unknown {
  return actionTarget({ 'data-action': action, 'data-effort': level, 'aria-checked': 'false' });
}

test('the Agent Effort row offers only the levels its model accepts, at the standard level when unset', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_release?tab=model',
    agents: [pinnedAgent(HAIKU, null)],
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.deepEqual(effortRadios(html, 'profile-effort'), [
    ['low', false, false],
    ['medium', true, false],
    ['high', false, false],
  ]);
  assert.match(html, /role="radiogroup" aria-labelledby="p-effort-label"/);
  assert.match(html, />Low<\/button>.*>Medium<\/button>.*>High<\/button>/);
  assert.match(html, /Higher effort thinks longer before answering\. It is slower and uses more tokens\. Standard is Medium\./);
  // The standard level is no choice, so the summary names the model alone.
  assert.match(html, new RegExp(`<span class="mono hint">${HAIKU.replace('/', '\\/')}</span>`));
  assert.equal(effortCount(harness), 0, 'the projection carries the levels for the first paint');
});

test('choosing an Agent effort marks it dirty and saves modelEffort with the model', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_release?tab=model',
    agents: [pinnedAgent(OPUS, null)],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  assert.match(harness.app.innerHTML, /save-bar-sticky is-clean/);

  click({ target: chooseEffortTarget('profile-effort', 'xhigh') });
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.doesNotMatch(html, /save-bar-sticky is-clean/);
  assert.deepEqual(effortRadios(html, 'profile-effort').find(([, checked]) => checked), ['xhigh', true, false]);
  assert.match(html, new RegExp(`<span class="mono hint">${OPUS.replace('/', '\\/')} · Extra high</span>`));

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  assert.equal(harness.agentPatchBodies[0]?.body.model, OPUS);
  assert.equal(harness.agentPatchBodies[0]?.body.modelEffort, 'xhigh');

  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, new RegExp(`<span class="mono">${OPUS.replace('/', '\\/')}</span> &middot; Extra high &middot; used in`));
});

test('an Agent keeps its effort on a model that accepts it and drops it on one that does not', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_release?tab=model',
    agents: [pinnedAgent(OPUS, 'max')],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: comboTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  click({ target: comboTarget({ 'data-action': 'pick-model', 'data-model': SONNET }) });
  await flushAsync();
  assert.equal(effortCount(harness), 1, 'a new model asks the server for its levels');
  assert.deepEqual(effortRadios(harness.app.innerHTML, 'profile-effort').find(([, checked]) => checked), ['max', true, false]);

  click({ target: comboTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  click({ target: comboTarget({ 'data-action': 'pick-model', 'data-model': HAIKU }) });
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.deepEqual(effortRadios(html, 'profile-effort').map(([level]) => level), HAIKU_EFFORTS);
  assert.deepEqual(effortRadios(html, 'profile-effort').find(([, checked]) => checked), ['medium', true, false]);
  assert.match(html, new RegExp(`<span class="mono hint">${HAIKU.replace('/', '\\/')}</span>`));

  // Back on a model with Max, the dropped effort stays dropped.
  click({ target: comboTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  click({ target: comboTarget({ 'data-action': 'pick-model', 'data-model': SONNET }) });
  await flushAsync();
  assert.equal(effortCount(harness), 2, 'levels are cached per model');
  assert.deepEqual(effortRadios(harness.app.innerHTML, 'profile-effort').find(([, checked]) => checked), ['medium', true, false]);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies[0]?.body.model, SONNET);
  assert.equal(harness.agentPatchBodies[0]?.body.modelEffort, null);
});

test('a model without effort levels says so instead of offering a row', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_release?tab=model',
    agents: [pinnedAgent(OPUS, 'high')],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: comboTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  click({ target: comboTarget({ 'data-action': 'pick-model', 'data-model': CHAT_MODEL }) });
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.match(html, /<span class="field-label" id="p-effort-label">Effort<\/span><p class="hint">This model has no effort setting\.<\/p>/);
  assert.deepEqual(effortRadios(html, 'profile-effort'), []);
  assert.doesNotMatch(html, /Standard is/);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies[0]?.body.modelEffort, null);
});

test('an Agent following the Workspace default shows its effort, disabled, until a model is pinned', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_release?tab=model',
    workspaceDefault: { modelId: OPUS, effort: 'high', revision: 4 },
    agents: [pinnedAgent(SONNET, 'xhigh')],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  // "Use the Workspace default" clears the pin and its effort together.
  click({ target: actionTarget({ 'data-action': 'profile-model-reset' }) });
  await flushAsync();
  let html = harness.app.innerHTML;
  assert.deepEqual(effortRadios(html, 'profile-effort'), [
    ['low', false, true],
    ['medium', false, true],
    ['high', true, true],
    ['xhigh', false, true],
    ['max', false, true],
  ]);
  assert.match(html, /Follows the Workspace default\. Pin a model to choose a different effort\./);
  assert.doesNotMatch(html, /Standard is/);
  assert.match(html, new RegExp(`<span class="mono hint">${OPUS.replace('/', '\\/')} · High</span>`));

  // Pinning again starts from the model's standard level, not the cleared effort.
  click({ target: comboTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  click({ target: comboTarget({ 'data-action': 'pick-model', 'data-model': SONNET }) });
  await flushAsync();
  assert.deepEqual(effortRadios(harness.app.innerHTML, 'profile-effort').find(([, checked]) => checked), ['medium', true, false]);
  click({ target: actionTarget({ 'data-action': 'profile-model-reset' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies[0]?.body.model, null);
  assert.equal(harness.agentPatchBodies[0]?.body.modelEffort, null);

  // The saved readback still follows the default's effort.
  html = harness.app.innerHTML;
  assert.deepEqual(effortRadios(html, 'profile-effort').find(([, checked]) => checked), ['high', true, true]);
});

test('a read-only Agent shows its effort as text', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_release?tab=model',
    agents: [pinnedAgent(OPUS, 'xhigh', { canEdit: false })],
  });
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.match(html, /<div class="input" aria-label="Agent effort">Extra high<\/div>/);
  assert.deepEqual(effortRadios(html, 'profile-effort'), []);
});

test('an effort the server refuses shows its message with the other save errors', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents/agent_release?tab=model',
    agents: [pinnedAgent(OPUS, null)],
    agentPatchError: {
      status: 422,
      body: { error: 'effort_not_supported', message: `${OPUS} does not support max effort.` },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: chooseEffortTarget('profile-effort', 'max') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /<div class="field-error" role="alert" aria-live="polite">anthropic\/claude-opus-5-5 does not support max effort\./);
});

test('the Agents list names an effort after the model only when one applies', async () => {
  const harness = runHarness({
    initialPath: '/admin/agents',
    agents: [
      pinnedAgent(OPUS, 'xhigh', { id: 'agent_pinned', name: 'Pinned Effort' }),
      pinnedAgent(HAIKU, null, { id: 'agent_standard', name: 'Standard Effort' }),
    ],
  });
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.match(html, new RegExp(`<span class="mono">${OPUS.replace('/', '\\/')}</span> &middot; Extra high &middot; Image`));
  assert.match(html, new RegExp(`<span class="mono">${HAIKU.replace('/', '\\/')}</span> &middot; Image`));
});
