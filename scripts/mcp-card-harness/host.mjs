import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

/**
 * A stand-in for ChatGPT: ext-apps' own host bridge, ChatGPT's style
 * variables, its app label and bordered frame. The card runs on another
 * origin, as in ChatGPT's sandbox, and its tool calls go to Core's MCP server.
 * With host=claude it is the plain bridge a host like claude.ai offers: no
 * ChatGPT styles, cursor or composer drafts.
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
};
window.harness = record;

document.documentElement.dataset.theme = theme ?? 'none';
document.getElementById('frame').style.width = `${width}px`;

const scene = await (await fetch(`/scene?name=${encodeURIComponent(params.get('scene'))}`)).json();
const iframe = document.createElement('iframe');
iframe.title = 'Chickpea card';
iframe.src = `${params.get('card')}/card.html?uri=${encodeURIComponent(scene.uri)}` +
  (scene.openaiMeta ? `&openaiMeta=${encodeURIComponent(JSON.stringify(scene.openaiMeta))}` : '');
document.getElementById('frame').append(iframe);
await new Promise((resolve) => { iframe.onload = resolve; });

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
  return await response.json();
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
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
