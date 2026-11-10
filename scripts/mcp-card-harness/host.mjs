import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

/**
 * A stand-in for ChatGPT: ext-apps' own host bridge, ChatGPT's style
 * variables, its app label and bordered frame. The card runs on another
 * origin, as in ChatGPT's sandbox, and its tool calls go to Core's MCP server.
 */
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
const width = Number(params.get('width'));
const styles = window.HARNESS_STYLES[theme];
const record = { calls: [], messages: [], links: [], sizes: [] };
window.harness = record;

document.documentElement.dataset.theme = theme ?? 'none';
document.getElementById('frame').style.width = `${width}px`;

const scene = await (await fetch(`/scene?name=${encodeURIComponent(params.get('scene'))}`)).json();
const iframe = document.createElement('iframe');
iframe.title = 'Chickpea Agent card';
iframe.src = `${params.get('card')}/card.html`;
document.getElementById('frame').append(iframe);
await new Promise((resolve) => { iframe.onload = resolve; });

const bridge = new AppBridge(
  null,
  { name: 'chickpea-harness', version: '1' },
  { openLinks: {}, serverTools: {}, message: { text: {} }, experimental: { 'openai/message': { draft: {} } } },
  {
    hostContext: {
      ...(styles ? { theme, styles: { variables: styles } } : {}),
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      platform: width < 500 ? 'mobile' : 'web',
      locale: 'en-US',
      containerDimensions: { maxWidth: width },
      'openai/interactionCursor': 'pointer',
    },
  },
);
bridge.oncalltool = async (request) => {
  record.calls.push(request.name);
  const response = await fetch('/call', { method: 'POST', body: JSON.stringify(request) });
  return await response.json();
};
bridge.onmessage = async (message) => {
  record.messages.push(message);
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
