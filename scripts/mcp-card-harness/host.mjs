import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

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
  /** Tools whose calls wait for `answerHeld`, which sends them on or fails them as a host that gave up would. */
  holding: [], held: [],
  answerHeld(how = 'send') {
    for (const settle of record.held.splice(0)) settle(how);
  },
  /** What the card saved with window.openai.setWidgetState, oldest first. */
  widgetStates: [],
  /**
   * How a result with isError reaches the card: as the result (ext-apps'
   * own host), or as a JSON-RPC error carrying ChatGPT's copy of the result
   * in its data ('data') or carrying only its words ('bare').
   */
  errors: 'result',
};
window.harness = record;

document.documentElement.dataset.theme = theme ?? 'none';
document.getElementById('frame').style.width = `${width}px`;

const scene = await (await fetch(`/scene?name=${encodeURIComponent(params.get('scene'))}`)).json();
record.scene = scene;

window.addEventListener('message', ({ data }) => {
  if (data && typeof data === 'object' && 'harnessWidgetState' in data) record.widgetStates.push(data.harnessWidgetState);
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
    }
    const response = await fetch('/call', { method: 'POST', body: JSON.stringify(request) });
    const result = await response.json();
    if (result.isError && record.errors !== 'result') {
      throw Object.assign(new Error(result.content?.[0]?.text ?? 'Tool call failed'), {
        code: -32603,
        ...record.errors === 'data' ? { data: { status: 'error', mcp_tool_result: result } } : {},
      });
    }
    return result;
  };
  bridge.onmessage = async (message) => {
    record.messages.push(message);
    return {};
  };
  bridge.onupdatemodelcontext = async ({ content }) => {
    record.contexts.push(content?.map(({ text }) => text).join('\n'));
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
