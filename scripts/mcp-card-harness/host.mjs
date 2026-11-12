import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

import { chatGptError, GATEWAY_TIMEOUT, RESOURCE_NOT_FOUND } from '../../tests/helpers/chatgpt-delivery.ts';

/**
 * A stand-in for ChatGPT: ext-apps' own host bridge, ChatGPT's style
 * variables, its app label and bordered frame. The card runs on another
 * origin, as in ChatGPT's sandbox, and its tool calls go to Core's MCP server.
 * With host=claude it is the plain bridge a host like claude.ai offers: no
 * ChatGPT styles, cursor, composer drafts or widget state.
 */
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
const width = Number(params.get('width'));
const chatgpt = params.get('host') !== 'claude';
const styles = chatgpt ? window.HARNESS_STYLES[theme] : undefined;
const record = {
  calls: [], args: [], messages: [], links: [], sizes: [], contexts: [], holdCreate: false, release: undefined,
  /**
   * Tools whose calls wait for `answerHeld`, which sends them on, fails them as a host that gave up
   * would ('fail'), or answers with an error result of the host's own ('failResult').
   */
  holding: [], held: [],
  /** Tools ChatGPT has not listed since the app connected: it answers them itself, without asking Chickpea. */
  unlisted: params.get('unlisted')?.split(',') ?? [],
  /** Tools whose calls run on Chickpea but reach the card as ChatGPT's 504 page, as at 300 s (probe 13). */
  timedOut: [],
  answerHeld(how = 'send') {
    for (const settle of record.held.splice(0)) settle(how);
  },
  /**
   * What ChatGPT keeps of the card, oldest first: each window.openai.setWidgetState, and each
   * ui/update-model-context, which ChatGPT keeps in the same place, so either replaces the other
   * (live check 2 bug 3, dry run M4). A reload mounts the card with the newest.
   */
  widgetStates: [],
  /**
   * How a result with isError reaches the card: as the result, as ext-apps'
   * own host and claude.ai hand it over, or as ChatGPT does (probe 12): a
   * JSON-RPC error that keeps only its text.
   */
  errors: chatgpt ? 'chatgpt' : 'result',
};
window.harness = record;

document.documentElement.dataset.theme = theme ?? 'none';
document.getElementById('frame').style.width = `${width}px`;

const scene = await (await fetch(`/scene?name=${encodeURIComponent(params.get('scene'))}`)).json();
record.scene = scene;

window.addEventListener('message', ({ data }) => {
  if (!data || typeof data !== 'object' || !('harnessWidgetState' in data)) return;
  record.widgetStates.push(data.harnessWidgetState);
  // ChatGPT's model reads a widget state's modelContent.
  const told = data.harnessWidgetState?.modelContent;
  if (typeof told === 'string') record.contexts.push(told);
});

/** The card in a new frame, drawn with the scene's result: a chat that opens, or reopens with what ChatGPT kept. */
async function mount(widgetState) {
  document.getElementById('frame').replaceChildren();
  const iframe = document.createElement('iframe');
  iframe.title = 'Chickpea card';
  document.getElementById('frame').append(iframe);

  const bridge = new AppBridge(
    null,
    { name: 'chickpea-harness', version: '1' },
    {
      openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} },
      ...chatgpt ? { experimental: { 'openai/message': { draft: {} } } } : {},
    },
    {
      hostContext: {
        ...(styles ? { theme, styles: { variables: styles } } : theme === 'light' || theme === 'dark' ? { theme } : {}),
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        platform: width < 500 ? 'mobile' : 'web',
        locale: 'en-US',
        containerDimensions: { maxWidth: width },
        ...chatgpt ? { 'openai/interactionCursor': 'pointer' } : {},
      },
    },
  );
  bridge.oncalltool = async (request) => {
    record.calls.push(request.name);
    record.args.push(request.arguments);
    // Lets the harness see the card while create_agent runs, as ChatGPT's 12 s did.
    if (request.name === 'create_agent' && record.holdCreate) await new Promise((resolve) => { record.release = resolve; });
    if (record.holding.includes(request.name)) {
      const how = await new Promise((resolve) => { record.held.push(resolve); });
      if (how === 'fail') throw new Error('The host gave up on the call.');
      if (how === 'failResult') return { isError: true, content: [{ type: 'text', text: 'Request timed out' }] };
    }
    const hostError = ({ code, message }) => Object.assign(new Error(message), { code });
    if (record.unlisted.includes(request.name)) throw hostError(RESOURCE_NOT_FOUND);
    const response = await fetch('/call', { method: 'POST', body: JSON.stringify(request) });
    const result = await response.json();
    if (record.timedOut.includes(request.name)) throw hostError(GATEWAY_TIMEOUT);
    if (result.isError && record.errors === 'chatgpt') throw hostError(chatGptError(result));
    return result;
  };
  bridge.onmessage = async (message) => {
    record.messages.push(message);
    return {};
  };
  bridge.onupdatemodelcontext = async ({ content }) => {
    const text = content?.map(({ text }) => text).join('\n');
    record.contexts.push(text);
    if (chatgpt) record.widgetStates.push({ modelContent: text });
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    record.links.push(url);
    return {};
  };
  bridge.onsizechange = ({ height }) => {
    record.sizes.push(height);
    if (height) iframe.style.height = `${height}px`;
  };
  bridge.oninitialized = () => {
    void bridge.sendToolResult(scene.result);
  };
  /** A theme change that carries no style variables, which ChatGPT may send. */
  record.flipTheme = (next) => bridge.sendHostContextChange({ theme: next });
  // Listening before the card loads, so its ui/initialize, sent as its script runs, is never missed.
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  const globals = new URLSearchParams({ uri: scene.uri });
  if (scene.openaiMeta) globals.set('openaiMeta', JSON.stringify(scene.openaiMeta));
  if (chatgpt) globals.set('chatgpt', '1');
  if (chatgpt && widgetState !== undefined) globals.set('widgetState', JSON.stringify(widgetState));
  iframe.src = `${params.get('card')}/card.html?${globals}`;
}

/** The chat reopens: the same result, and on ChatGPT the widget state the card saved last. */
record.reload = () => mount(record.widgetStates.at(-1));
await mount(undefined);
