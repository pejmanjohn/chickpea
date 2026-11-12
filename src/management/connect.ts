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

import { CONNECT_FONTS, fontFaceCss } from '../assets/fonts.ts';
import { escapeHtml } from '../security/html-escape.ts';
import { adminSettingsSectionShown } from './admin-links.ts';

export const CONNECT_MARKDOWN_PATH = '/connect.md';
export const CONNECT_PAGE_PATH = '/connect';
/** Where a managed provider returns the sign-in tab Admin opened. */
export const MANAGED_SIGN_IN_RETURN_PATH = '/managed-connections/return';
export const MCP_RESOURCE_PATH = '/mcp';
export const ADMIN_PATH = '/admin';
export const ADMIN_SETTINGS_PATH = '/admin/settings';
/** Settings → MCP (page heading "Coding agents"): every client's snippet plus the one-click installs. */
export const ADMIN_CODING_AGENTS_PATH = '/admin/settings/agents-clients';
/** Settings → Connected apps: the apps the signed-in person connected, each with Disconnect. */
export const ADMIN_CONNECTED_APPS_PATH = '/admin/settings/connected-apps';
export const MCP_SERVER_NAME = 'chickpea';
export const DISCOVERY_GUIDE_URI = 'chickpea://guide/discovery/v1';

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
  /** How the client loads a new server: a new session or thread, a reload, or nothing. */
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
    snippet: (url) => `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} ${url}`,
    login: `Run \`claude mcp login ${MCP_SERVER_NAME}\` in a terminal and finish the browser sign-in. It prints \`Authenticated with "${MCP_SERVER_NAME}".\` when it is done. A Claude Code session that lists \`${MCP_SERVER_NAME}\` can sign in from \`/mcp\` instead.`,
    restart: 'A server added from the terminal loads when a new Claude Code session starts, not in the session already running. In a terminal, exit and run `claude` again. `claude --continue` in the same directory resumes this conversation with Chickpea loaded. User scope makes it available outside the installation checkout. Use project scope only when explicitly requested.',
  },
  {
    id: 'codex',
    title: 'Codex',
    where: 'terminal',
    language: 'bash',
    snippet: (url) => `codex mcp add ${MCP_SERVER_NAME} --url ${url}`,
    login: `Codex opens the browser sign-in itself. Wait for the command to print "Successfully logged in". If it prints "Browser launch failed", the person opens the URL it printed. Run codex mcp login ${MCP_SERVER_NAME} only if sign-in is still needed afterward.`,
    restart: 'A new Codex thread loads the server; the thread already running does not.',
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
    restart: 'A server added from the terminal loads when a new Gemini CLI session starts. In a terminal, exit and run `gemini` again. `gemini --resume latest` in the same directory resumes this conversation. `/mcp reload` reconnects the servers the session already has and does not load a new one.',
  },
  {
    id: 'json',
    title: 'Any other MCP client',
    where: 'the client\'s MCP server configuration',
    language: 'json',
    snippet: (url) => CONFIG_JSON(url, { type: 'http' }),
    login: 'Use the client\'s remote or custom server sign-in; it discovers OAuth from the server. ChatGPT: Developer mode, custom connector by URL.',
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

const CLAUDE_CONNECTOR_PAGES = {
  personal: 'https://claude.ai/customize/connectors',
  // Only a Claude Team or Enterprise Owner can open this one.
  organization: 'https://claude.ai/admin-settings/connectors',
} as const;

/**
 * Claude's published install link: it opens the Add custom connector dialog
 * with the name and URL filled in, and the person confirms. A connector added
 * there reaches every Claude surface on that account, Claude Code included.
 */
export function claudeConnectorLink(url: string, page: keyof typeof CLAUDE_CONNECTOR_PAGES = 'personal'): string {
  return `${CLAUDE_CONNECTOR_PAGES[page]}?modal=add-custom-connector&connectorName=Chickpea&connectorUrl=${encodeURIComponent(url)}`;
}

/** The one line a person pastes into their coding agent. */
export function connectPrompt(origin: string): string {
  return `Connect my coding agent to my Chickpea using ${connectGuideUrl(origin)}`;
}

/** The same line, asking the coding agent to go on and create the first Agent. Admin's first visit copies it. */
export function firstAgentPrompt(origin: string): string {
  return `${connectPrompt(origin)}, then help me create my first Chickpea Agent.`;
}

/**
 * What the person pastes where Chickpea is loaded, and what the agent reports
 * before it stops. Shared by the Claude app path and step 4, because the old
 * conversation never sees step 5.
 */
const HAND_OFF_PASTE = 'paste `Call Chickpea\'s get_account and tell me the workspace name and who I am signed in as.` That call is the step 5 proof. If they asked for their first Agent and no install guide owns the first teammate, they also add `Then help me create my first Chickpea Agent.`';
const HAND_OFF_REPORT = 'Report the three step 5 lines now, with Tested as pending';

function fence(language: string, body: string): string {
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

/**
 * The guide the coding agent reads. Written to the agent in the same voice as
 * the install guides: detect the client, write its config, sign in, hand off
 * to a new session or thread if the client needs it, prove the connection
 * with one read-only call, then find the first teammate.
 */
export function connectMarkdown(origin: string, env?: Record<string, unknown>): string {
  const url = connectMcpUrl(origin);
  const admin = `${origin}${ADMIN_PATH}`;
  const settings = `${origin}${ADMIN_SETTINGS_PATH}`;
  // Hosted Admin has no Coding sandbox page to send anyone to.
  const adminManaged = adminSettingsSectionShown('sandbox', env)
    ? 'Model provider keys, GitHub setup, and the coding sandbox are'
    : 'Model provider keys and GitHub setup are';

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
    'You are one of: the Claude app (claude.ai, Claude Desktop, Cowork, or the Desktop Code tab), Claude Code in a terminal, Codex, Cursor, VS Code, Windsurf, Gemini CLI, or another MCP client. Use what you know about your own harness. If you genuinely cannot tell, ask the person once, then continue.',
    '',
    '## 2. Add the server',
    '',
    '### Claude app',
    '',
    'Inside the Claude app, the person adds Chickpea as a Claude connector. Do not write a configuration file or run `claude mcp add`.',
    '',
    `- Give them this link. It opens Claude's Add custom connector dialog with Chickpea filled in: ${claudeConnectorLink(url)}`,
    `- On a Claude Team or Enterprise plan, only an Owner can add connectors. An Owner uses this link instead to add Chickpea for the whole organization: ${claudeConnectorLink(url, 'organization')} A member asks an Owner to do that, then finds Chickpea under Customize → Connectors.`,
    '- Ask them to click Add, then Connect, sign in with Slack, and click Allow.',
    `- Ask them to start a new conversation, which loads the connector, and ${HAND_OFF_PASTE}`,
    `- ${HAND_OFF_REPORT} until the new conversation runs the check, then stop. Steps 3 and 4 do not apply here.`,
    '',
    '### Every other client',
    '',
    'If you are Claude Code and `/mcp` already lists `claude.ai Chickpea`, the person added Chickpea in the Claude app and your session has it. Skip to step 5. Do not run `claude mcp add`, because a server at the same URL replaces the connector and needs its own sign-in.',
    '',
    `Use the server name \`${MCP_SERVER_NAME}\` unless it is already taken, and keep every other server the person has configured. Write the configuration for your client:`,
    '',
    table,
    '',
    blocks,
    '',
    '## 3. Sign in',
    '',
    'Adding the server may start sign-in. If the command prints an authorization URL, that URL is single-use and the client already opened it in the browser. Do not show the URL to the person unless the command reports that it could not open the browser. Do not open the URL again, and do not start a second login while the first one is pending. Wait for the command to finish before you report anything. If it reports a successful login, continue to step 4.',
    '',
    `If sign-in is still needed after adding the server, start your client's sign-in once. In Claude Code, ask the person to run \`claude mcp login ${MCP_SERVER_NAME}\` themselves: it needs an interactive terminal, and your shell tool has none. The browser shows Slack sign-in for the workspace where Chickpea is installed, then Chickpea\'s consent screen with one permission: manage this Chickpea workspace. Ask the person to complete Slack sign-in and click Allow in that tab, then wait for the client to report the result.`,
    '',
    'If a leftover tab shows connection refused at localhost or 127.0.0.1, go by the client\'s own result and retry once with a fresh login only if that result is a failure.',
    '',
    `If the server answers 404 at \`${MCP_RESOURCE_PATH}\` or your client cannot find its OAuth metadata, Chickpea\'s Slack setup is not finished yet. Send the person to ${admin} to finish it, leave the configuration in place, and stop here.`,
    '',
    '## 4. Open a new session or thread if your client needs it',
    '',
    'Most clients load MCP servers only when a session or thread starts, so the one you are in may not see Chickpea yet. If you cannot call Chickpea\'s tools after sign-in, do these steps in order:',
    '',
    '1. If your client is Cursor, VS Code, or Windsurf, ask the person to do what its Loading line above says, then go to step 5 in this conversation.',
    `2. ${HAND_OFF_REPORT} until the new session or thread runs the check.`,
    '3. Tell the person how to load Chickpea:',
    '   - Claude Code or Gemini CLI in a terminal: exit, then run `claude --continue` or `gemini --resume latest` in the same directory. That resumes this conversation with Chickpea loaded.',
    '   - Codex: start a new thread. Restarting the app and reopening this thread also works and keeps the conversation.',
    '   - Any other client: start a new session or thread.',
    `4. Ask them to ${HAND_OFF_PASTE}`,
    '5. Stop. Do not open the new session or thread yourself. If an install guide sent you here, go back to it and report the same lines there.',
    '',
    '## 5. Prove the connection',
    '',
    'Call `get_account`, which changes nothing. The first Chickpea call may show an approval prompt in your client. If it does, ask the person to approve it. Then report three separate lines:',
    '',
    '1. Configured: which client and where the configuration was written.',
    '2. Signed in: whether the browser sign-in and consent completed.',
    '3. Tested: the signed-in person and the workspace from `get_account`: its `name`, and its `nickname`, which names the Slack workspace and the person\'s role.',
    '',
    'A saved configuration is not a tested connection. If a step remains blocked after following the guidance above, say which one, keep the first error, and stop.',
    '',
    '## 6. Find the first teammate',
    '',
    `Read the resource \`${DISCOVERY_GUIDE_URI}\` and follow it: research the person's recent work on this machine before you propose an Agent. Nothing is created until the person says yes to a proposal.`,
    '',
    'No separate local skills are required.',
    '',
    '## Good to know',
    '',
    `- ${adminManaged} managed in Admin at ${settings}. Send the person there with the link rather than asking for the values.`,
    '- After you create an Agent, it messages the person in Slack, and `links.slack` opens that conversation.',
    '- The person can disconnect at any time from their client; a removed Chickpea member loses MCP access immediately.',
    '',
  ].join('\n');
}

const BRAND_STYLE = `${fontFaceCss(CONNECT_FONTS)}
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
button.copy,a.install{font:inherit;font-weight:700;font-size:14px;padding:8px 14px;border:0;border-radius:9px;background:var(--gold);color:#3b3220;cursor:pointer;box-shadow:0 2px 0 var(--gold-press)}
button.copy:active,a.install:active{transform:translateY(1px);box-shadow:0 1px 0 var(--gold-press)}
a.install{display:inline-block;text-decoration:none;margin:4px 0 12px}
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
 * Add to Claude link, the direct commands for Claude Code and Codex, and a
 * link to Admin Settings.
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
<p class="meta">Claude app (web, Desktop, Cowork)</p>
<a class="install" href="${escapeHtml(claudeConnectorLink(url))}" target="_blank" rel="noopener noreferrer">Add to Claude</a>
<p class="meta">Claude opens its Add custom connector dialog with Chickpea filled in. Click Add, then Connect, and sign in with Slack. On a Claude Team or Enterprise plan, an Owner <a href="${escapeHtml(claudeConnectorLink(url, 'organization'))}" target="_blank" rel="noopener noreferrer">adds it for the whole organization</a>, and each member clicks Connect.</p>
<p class="meta">Claude Code</p>
${snippetHtml('claude-code', claude.snippet(url))}
<p class="meta">Already added Chickpea in Claude? Claude Code signed in with the same claude.ai account gets it in its next session, so skip this command.</p>
<p class="meta">Codex</p>
${snippetHtml('codex', codex.snippet(url))}
<p class="meta">${escapeHtml(codex.login)}</p>
<p class="meta">Any MCP client: add a remote server at <code>${escapeHtml(url)}</code>. Sign-in uses your Slack account; there is no API key or token to paste. Full instructions for Cursor, VS Code, Windsurf, and Gemini CLI are in <a href="${escapeHtml(guideUrl)}">the guide</a>.</p>
<h2>Then</h2>
<p>Ask your coding agent what Agents it can manage, or tell it what your first teammate should do. Signed in to Admin? <a href="${ADMIN_CODING_AGENTS_PATH}">Settings → MCP</a> has every client's snippet and one-click install for Claude, Cursor, and VS Code. Model providers, GitHub, and other workspace settings stay in <a href="${ADMIN_SETTINGS_PATH}">Admin Settings</a>.</p>
</div>
</main>
<script nonce="${nonce}">${COPY_SCRIPT}</script>
</body>
</html>
`;
}
