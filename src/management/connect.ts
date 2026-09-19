/**
 * Deployment-served connect surface for coding agents.
 *
 * `GET /connect.md` is a guide written for the coding agent itself, with this
 * deployment's real URLs substituted in, so a person can hand their agent one
 * line: "Connect my coding agent to my Chickpea using <origin>/connect.md".
 * `GET /connect` is the human-facing page that shows that line with a copy
 * button. Both are public and unauthenticated, so everything rendered here must
 * stay free of secrets, tokens, and internal identifiers. The MCP endpoint
 * itself still answers 404 until Slack setup is finished; the guide says so.
 *
 * The client table is the one place the supported clients are listed. The
 * Settings page (C1) and the CLI render from the same facts.
 */

import { escapeHtml } from '../security/html-escape.ts';

export const CONNECT_MARKDOWN_PATH = '/connect.md';
export const CONNECT_PAGE_PATH = '/connect';
export const MCP_RESOURCE_PATH = '/mcp';
export const ADMIN_PATH = '/admin';
export const ADMIN_SETTINGS_PATH = '/admin/settings';
/** Settings → MCP (page heading "Coding agents"): every client's snippet plus the one-click installs. */
export const ADMIN_CODING_AGENTS_PATH = '/admin/settings/agents-clients';
export const MCP_SERVER_NAME = 'chickpea';
export const AGENT_AUTHORING_GUIDE_URI = 'chickpea://guide/agent-authoring/v1';

export interface ConnectClient {
  id: string;
  /** Display name, also what the markdown table shows. */
  title: string;
  /** Where the configuration lives, for the markdown table. */
  where: string;
  /** Exact text the agent writes or runs. Multi-line snippets are fenced. */
  snippet: (url: string) => string;
  /** Language hint for the fenced block. */
  language: 'bash' | 'json';
  /** How to start sign-in once the server is configured. */
  login: string;
  /** Whether the client usually needs a restart or reload to see a new server. */
  restart: string;
}

const CONFIG_JSON = (url: string, extra: Record<string, string> = {}) =>
  JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { ...extra, url } } }, null, 2);

export const CONNECT_CLIENTS: readonly ConnectClient[] = Object.freeze([
  {
    id: 'claude-code',
    title: 'Claude Code',
    where: 'terminal',
    language: 'bash',
    snippet: (url) => `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
    login: `Run \`/mcp\` inside Claude Code, choose \`${MCP_SERVER_NAME}\`, and follow the browser sign-in.`,
    restart: 'Servers added from the terminal appear in the next Claude Code session. Add `--scope user` to make it available in every project.',
  },
  {
    id: 'codex',
    title: 'Codex',
    where: 'terminal',
    language: 'bash',
    snippet: (url) => `codex mcp add ${MCP_SERVER_NAME} --url ${url}`,
    login: `Use the browser tab Codex opens and wait for the command to finish. Run codex mcp login ${MCP_SERVER_NAME} only if sign-in is still needed afterward.`,
    restart: 'A running Codex session loads the server on its next start.',
  },
  {
    id: 'cursor',
    title: 'Cursor',
    where: '`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project',
    language: 'json',
    snippet: (url) => CONFIG_JSON(url),
    login: 'Cursor shows the server under Settings → MCP with a sign-in prompt; the person completes it in the browser.',
    restart: 'Cursor picks up the file when it is saved; if the server does not appear, reload the window.',
  },
  {
    id: 'vscode',
    title: 'VS Code',
    where: 'terminal, or `.vscode/mcp.json`',
    language: 'bash',
    snippet: (url) => `code --add-mcp '${JSON.stringify({ name: MCP_SERVER_NAME, type: 'http', url })}'`,
    login: 'VS Code asks to trust and start the server, then opens the browser sign-in.',
    restart: 'No restart; start the server from the MCP view if it is not running.',
  },
  {
    id: 'windsurf',
    title: 'Windsurf',
    where: '`~/.codeium/windsurf/mcp_config.json`',
    language: 'json',
    snippet: (url) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { serverUrl: url } } }, null, 2),
    login: 'Windsurf prompts for sign-in when the server first connects.',
    restart: 'Refresh the MCP server list in Windsurf, or reload the window.',
  },
  {
    id: 'gemini-cli',
    title: 'Gemini CLI',
    where: 'terminal',
    language: 'bash',
    snippet: (url) => `gemini mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
    login: 'Gemini CLI opens the browser sign-in the first time the server is used.',
    restart: 'The server is available in the next Gemini CLI session.',
  },
  {
    id: 'json',
    title: 'Any other MCP client',
    where: 'the client\'s MCP server configuration',
    language: 'json',
    snippet: (url) => CONFIG_JSON(url, { type: 'http' }),
    login: 'Use the client\'s remote or custom server sign-in; it discovers OAuth from the server. claude.ai and Claude Desktop: Customize → Connectors → Add custom connector, paste the URL. ChatGPT: Developer mode, custom connector by URL.',
    restart: 'Follow the client\'s own instructions for loading a new server.',
  },
]);

/**
 * Accept only an absolute http(s) origin with no credentials, path, query, or
 * fragment. Everything rendered below interpolates this string into Markdown,
 * shell commands, and HTML, so it must be a bare origin and nothing else.
 */
export function connectOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return undefined;
  if (/[\s'"`<>\\]/.test(parsed.origin)) return undefined;
  return parsed.origin;
}

export function connectMcpUrl(origin: string): string {
  return `${origin}${MCP_RESOURCE_PATH}`;
}

export function connectGuideUrl(origin: string): string {
  return `${origin}${CONNECT_MARKDOWN_PATH}`;
}

/** The one line a person pastes into their coding agent. */
export function connectPrompt(origin: string): string {
  return `Connect my coding agent to my Chickpea using ${connectGuideUrl(origin)}`;
}

function fence(language: string, body: string): string {
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

/**
 * The guide the coding agent reads. Written to the agent in the same voice as
 * the install guides: detect the client, write its config, sign in, restart if
 * the client needs it, prove the connection with one read-only call, then ask
 * about the first teammate.
 */
export function connectMarkdown(origin: string): string {
  const url = connectMcpUrl(origin);
  const admin = `${origin}${ADMIN_PATH}`;
  const settings = `${origin}${ADMIN_SETTINGS_PATH}`;

  const table = [
    '| Client | Where | What to write or run |',
    '| --- | --- | --- |',
    ...CONNECT_CLIENTS.map((client) => {
      const how = client.language === 'bash'
        ? client.snippet(url).split('\n').map((line) => `\`${line}\``).join(' then ')
        : 'the JSON block below';
      return `| ${client.title} | ${client.where} | ${how} |`;
    }),
  ].join('\n');

  const blocks = CONNECT_CLIENTS.map((client) => [
    `### ${client.title}`,
    '',
    fence(client.language, client.snippet(url)),
    '',
    `Sign in: ${client.login}`,
    '',
    `Loading: ${client.restart}`,
  ].join('\n')).join('\n\n');

  return [
    '# Connect this coding agent to Chickpea',
    '',
    'You are the connecting agent. The person wants the coding agent they are talking to right now, you, to manage their Chickpea workspace over MCP. Carry out the steps below yourself with the tools you have, ask the person only for what needs their presence, and report what you actually verified.',
    '',
    'Chickpea gives a Slack workspace AI teammates called Agents. Its MCP server lets you create and change those Agents as the signed-in person. This deployment:',
    '',
    `- MCP server: \`${url}\``,
    `- Admin: ${admin}`,
    `- This guide: ${connectGuideUrl(origin)}`,
    '',
    'Never create, ask for, or paste a bearer token, API key, or Slack credential. The client discovers OAuth from the server, registers itself, and opens the browser for Slack sign-in. If a step asks you for a secret, stop and tell the person.',
    '',
    '## 1. Detect which client you are running in',
    '',
    'You are one of: Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, or another MCP client. Use what you know about your own harness. If you genuinely cannot tell, ask the person once, then continue.',
    '',
    '## 2. Add the server',
    '',
    `Use the server name \`${MCP_SERVER_NAME}\` unless it is already taken, and keep every other server the person has configured. Write the configuration for your client:`,
    '',
    table,
    '',
    blocks,
    '',
    '## 3. Sign in',
    '',
    'Adding the server may already start sign-in. Keep that command running and use the browser tab it opens. Do not open a second copy of the authorization URL or start another login while the first is pending. Open the printed URL once only if no tab opened. If the command already reports successful login, continue to step 4.',
    '',
    'If sign-in is still needed after adding the server, start your client\'s sign-in once. The browser shows Slack sign-in for the workspace where Chickpea is installed, then Chickpea\'s consent screen with one permission: manage this Chickpea workspace. Ask the person to complete Slack sign-in and click Allow in that tab, then wait for the client to report the result.',
    '',
    'If an old or duplicate tab shows connection refused at localhost or 127.0.0.1 after consent, check the client\'s result first. A successful login can close the client\'s temporary callback listener. Close the leftover tab and continue to the read-only check in step 5 if the client reports success. If login failed or timed out, preserve the first error and retry once with a fresh login URL. Do not reuse the old authorization or callback URL, or remove working credentials to retry.',
    '',
    `If the server answers 404 at \`${MCP_RESOURCE_PATH}\` or your client cannot find its OAuth metadata, Chickpea\'s Slack setup is not finished yet. Send the person to ${admin} to finish it, leave the configuration in place, and stop here.`,
    '',
    '## 4. Restart if your client needs it',
    '',
    'Most clients load MCP servers at startup. If the server is not listed after you added it, tell the person the one remaining action (restart the session or reload the window) and wait. Do not restart their session yourself, and do not report the connection as working until step 5 succeeds.',
    '',
    '## 5. Prove the connection',
    '',
    'Call `inspect_workspace` with no changes. Then report three separate lines:',
    '',
    '1. Configured: which client and where the configuration was written.',
    '2. Signed in: whether the browser sign-in and consent completed.',
    '3. Tested: the workspace name and the signed-in person from `inspect_workspace`.',
    '',
    'A saved configuration is not a tested connection. If a step remains blocked after following the guidance above, say which one, keep the first error, and stop.',
    '',
    '## 6. Offer the first teammate',
    '',
    `Read the resource \`${AGENT_AUTHORING_GUIDE_URI}\`. If your client shows Chickpea\'s prompts as slash commands, suggest \`/mcp__${MCP_SERVER_NAME}__new-agent\`. Otherwise ask: "What should your first teammate do for your team?" Offer the starters the guide names; never invent one. The person chooses, and nothing is created until they do.`,
    '',
    '## Good to know',
    '',
    `- Model provider keys, GitHub setup, the coding sandbox, and outbound access are managed in Admin at ${settings}. Send the person there with the link rather than asking for the values.`,
    '- After creating or changing an Agent, tell the person to mention it in Slack by its handle to try it.',
    '- The person can disconnect at any time from their client; a removed Chickpea member loses MCP access immediately.',
    '',
  ].join('\n');
}

const BRAND_STYLE = `
:root{--canvas:#f4ebd8;--card:#fffdf6;--well:#f8f1df;--line:rgba(59,50,32,.12);--text:#3b3220;--text-2:#6b5c42;--gold:#dda033;--gold-deep:#8a6410;--gold-press:#b27e1f;--ok:#4e7a3e}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--text);font:16px/1.55 Quicksand,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:6vh auto 10vh;padding:0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 28px 24px;box-shadow:0 2px 0 rgba(59,50,32,.08)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.brand img{width:40px;height:40px;border-radius:10px}
.brand span{font-weight:700;letter-spacing:.02em}
h1{font-size:30px;line-height:1.15;margin:0 0 10px}
h2{font-size:17px;margin:30px 0 8px}
p{margin:0 0 12px;color:var(--text-2)}
.snippet{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:start;background:var(--well);border:1px solid var(--line);border-radius:12px;padding:12px 12px 12px 14px;margin:8px 0 14px}
.snippet pre{margin:0;white-space:pre-wrap;word-break:break-word;font:14px/1.5 "JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;color:var(--text)}
button.copy{font:inherit;font-weight:700;font-size:14px;padding:8px 14px;border:0;border-radius:9px;background:var(--gold);color:#3b3220;cursor:pointer;box-shadow:0 2px 0 var(--gold-press)}
button.copy:active{transform:translateY(1px);box-shadow:0 1px 0 var(--gold-press)}
button.copy[data-done]{background:var(--ok);color:#fff;box-shadow:none}
.meta{font-size:14px}
a{color:var(--gold-deep)}
@media (max-width:520px){.snippet{grid-template-columns:1fr}button.copy{justify-self:start}}
`.trim();

const COPY_SCRIPT = `
document.querySelectorAll('button.copy').forEach(function(button){
  button.addEventListener('click',function(){
    var target=document.getElementById(button.getAttribute('data-copy'));
    if(!target)return;
    var text=target.textContent||'';
    var done=function(){button.setAttribute('data-done','');button.textContent='Copied';setTimeout(function(){button.removeAttribute('data-done');button.textContent='Copy';},1600);};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){selectText(target);});}
    else{selectText(target);}
  });
});
function selectText(node){var range=document.createRange();range.selectNodeContents(node);var selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}
`.trim();

function snippetHtml(id: string, text: string): string {
  return `<div class="snippet"><pre id="${id}">${escapeHtml(text)}</pre><button type="button" class="copy" data-copy="${id}">Copy</button></div>`;
}

/**
 * The human-facing page. Shows the one-line prompt with a copy button, the
 * direct commands for Claude Code and Codex, and a link to Admin Settings.
 * No diagnostics: nothing here depends on workspace state.
 */
export function connectPageHtml(origin: string, nonce: string): string {
  const url = connectMcpUrl(origin);
  const claude = CONNECT_CLIENTS.find((client) => client.id === 'claude-code')!;
  const codex = CONNECT_CLIENTS.find((client) => client.id === 'codex')!;
  const guideUrl = connectGuideUrl(origin);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your coding agent to Chickpea</title>
<link rel="icon" href="/chickpea-favicon-32.png">
<style>${BRAND_STYLE}</style>
</head>
<body>
<main>
<div class="card">
<div class="brand"><img src="/chickpea-mark-128.png" alt=""><span>Chickpea</span></div>
<h1>Connect your coding agent</h1>
<p>Paste this into Claude Code, Codex, Cursor, or any coding agent that supports MCP. It reads the guide at that address and connects itself.</p>
${snippetHtml('prompt', connectPrompt(origin))}
<h2>Or add it yourself</h2>
<p class="meta">Claude Code</p>
${snippetHtml('claude-code', claude.snippet(url))}
<p class="meta">Codex</p>
${snippetHtml('codex', codex.snippet(url))}
<p class="meta">${escapeHtml(codex.login)}</p>
<p class="meta">Any MCP client: add a remote server at <code>${escapeHtml(url)}</code>. Sign-in uses your Slack account; there is no API key or token to paste. Full instructions for Cursor, VS Code, Windsurf, and Gemini CLI are in <a href="${escapeHtml(guideUrl)}">the guide</a>.</p>
<h2>Then</h2>
<p>Ask your coding agent what Agents it can manage, or tell it what your first teammate should do. Signed in to Admin? <a href="${ADMIN_CODING_AGENTS_PATH}">Settings → MCP</a> has every client's snippet and one-click install for Cursor and VS Code. Model providers, GitHub, and other workspace settings stay in <a href="${ADMIN_SETTINGS_PATH}">Admin Settings</a>.</p>
</div>
</main>
<script nonce="${nonce}">${COPY_SCRIPT}</script>
</body>
</html>
`;
}
