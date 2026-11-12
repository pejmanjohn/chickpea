# chickpea-cli

The official command line for a self-hosted [Chickpea](https://chickpea.co) deployment. It checks a deployment's public surface, prints MCP client configuration, signs you in with the same OAuth 2.1 flow every MCP client uses, and gives scripts access to every workspace management tool without building an MCP integration by hand.

```sh
npx chickpea-cli doctor https://chickpea.example.com
```

Requires Node 24.x, minimum 24.22.1 (`>=24.22.1 <25`). Development and publishing use the repository's `.nvmrc` baseline, 24.22.1. The binary is `chickpea`; install it globally with `npm install -g chickpea-cli` or run it through `npx chickpea-cli`.

You do not need the CLI to connect a coding agent. Admin **Settings → MCP** on your deployment (`/admin/settings/agents-clients`) shows the same client snippets with a Copy button each and one-click install for Cursor and VS Code, and `https://<your Chickpea>/connect` holds a one-line prompt the agent follows to connect itself. The CLI is for shells and scripts.

## Commands

| Command | Sign-in | What it does |
| --- | --- | --- |
| `chickpea doctor <url>` | no | Fetches the OAuth discovery documents, the signing keys, and the unauthenticated MCP challenge. One line per check, exit 1 on any failure. |
| `chickpea mcp config <url> [--client claude-code\|codex\|cursor\|vscode\|windsurf\|gemini-cli\|json]` | no | Prints the MCP client configuration for `<url>/mcp`, the same snippets the deployment serves at `/connect.md` and in Admin Settings. Default: every client. |
| `chickpea login <url>` | browser | Registers a public PKCE client, opens the browser for Slack sign-in and consent, and saves the tokens. |
| `chickpea chatgpt connect <url>` | browser | Opens owner approval in Chickpea, completes ChatGPT sign-in through a local callback, and waits for account confirmation. OpenAI tokens stay on the deployment. |
| `chickpea logout <url>` | saved | Revokes the refresh token at the deployment and deletes the saved session. The last access token keeps working until it expires, up to 15 minutes. |
| `chickpea workspace inspect <url> [--include-archived] [--json]` | saved | Calls `get_workspace` and every page of `list_agents` to summarize the workspace, your role, Agent handles, status, edit access, and attention needed. Archived Agents are left out unless you pass `--include-archived`. |
| `chickpea tools list <url>` | saved | Lists every management tool with its annotations. |
| `chickpea call <url> <tool> [--args '<json>' \| --args-file <file>]` | saved | Calls any tool and normalizes its result to `{ ok, result \| error }` JSON. Exit 1 on a refusal or input-validation error. |
| `chickpea recipe export <url> [--agents id,id]` | saved | Calls `export_agents` and writes its secret-free portable recipe to stdout. |
| `chickpea recipe preview` | no | Removed. Prints a one-line message to use a coding agent with `create_agent` and `update_agent`, then exits 1. |
| `chickpea skills upload <url> <agent-id> <file...> [--replace]` | saved | Installs skills on an Agent from `SKILL.md` and other markdown files and `.zip` or `.skill` archives, keeping its other skills. A same-name skill with different content is left as it is unless you pass `--replace`. |

Global flags: `--json` for machine output on stdout (`skills upload` prints one envelope per call, as an array), `--quiet` to silence progress notes on stderr, `--help`, `--version`.

`<url>` is the deployment origin, for example `https://chickpea.example.com`. A pasted MCP URL ending in `/mcp` is accepted. Plain HTTP is allowed only for loopback development.

## Example session

```sh
$ npx chickpea-cli doctor https://chickpea.example.com
PASS  protected resource metadata: https://chickpea.example.com/mcp is protected by https://chickpea.example.com/api/auth
PASS  authorization server metadata: PKCE S256, dynamic registration, token and revocation endpoints published
PASS  signing keys (JWKS): 1 key published
PASS  MCP challenge without a token: HTTP 401 with resource_metadata=https://chickpea.example.com/.well-known/oauth-protected-resource/mcp
Doctor: ready. Connect MCP clients to https://chickpea.example.com/mcp (see: chickpea mcp config https://chickpea.example.com).

$ npx chickpea-cli login https://chickpea.example.com
Opening your browser to sign in to https://chickpea.example.com.
Signed in to https://chickpea.example.com. Session saved to /home/you/.config/chickpea/credentials.json (mode 0600).

$ npx chickpea-cli workspace inspect https://chickpea.example.com
Workspace Example
You: Alex  owner

Agents (2 shown; archived Agents are left out, --include-archived lists them)
  Support  @support  id=agent_support  on  can edit
  Revops  @revops  id=agent_revops  on  can edit

Can create Agents: yes
Workspace in Admin: https://chickpea.example.com/admin

$ npx chickpea-cli call https://chickpea.example.com get_agent --args '{"agentId":"agent_support"}'
{
  "ok": true,
  "result": {
    "agentId": "agent_support",
    "name": "Support",
    "...": "remaining Agent fields"
  }
}

$ npx chickpea-cli recipe export https://chickpea.example.com --agents agent_support > recipe.json
```

`skills upload` reads each file from disk and sends it to the 5.0 `upload_skill_files` tool: markdown as text and archives as base64, so the file content never passes through a model. It splits the files across calls so each call stays under the deployment's 1 MB request cap, and refuses a single file larger than that; upload that file in Admin (the Agent's Skills tab, Upload) instead. Find the Agent id with `chickpea workspace inspect <url>`.

Skill upload prints each call's `summary`, the names of the skills it added, replaced, found already installed, or left as they are, any `Left out <file>: <why>` lines, conflict guidance on stderr, and the Agent's Admin link when returned. `--json` keeps the array of normalized envelopes and preserves the 5.0 fields, including `added`, `replaced`, `unchanged`, `conflicts`, and `leftOut`.

`recipe preview` was removed. A coding agent applies the exported recipe through `create_agent` and `update_agent`.

## Compatibility and result format

Version 0.3.0 uses the 5.0 tools. `workspace inspect`, `recipe export`, and `skills upload` refuse an older Core that lacks their required tools, with `UPDATE_REQUIRED` and an "Update your Chickpea Core" message. Update the self-hosted deployment before you use these commands.

`workspace inspect --json` now returns `{ workspace, agents, canCreate }`, plus `archivedLeftOut: true` when the deployment left archived Agents out. The human summary replaces the old configuration dump with workspace identity, your role, Agent status, edit access, and attention needed. Use `call` with `get_agent`, `list_slack_channels`, `list_models`, `list_services`, or `list_members` for configuration details, subject to your role.

`workspace inspect` reads every page of `list_agents`: it sends each `nextCursor` back as `cursor` until a page has none, for at most 50 pages. If more pages remain after 50, it exits with `TOO_MANY_PAGES` and prints nothing, so it never prints only part of the list. A Core that pages `list_agents` leaves archived Agents out. On such a Core, the summary line says so, and `--include-archived` sends `includeArchived: true` to list them. An older Core lists archived Agents on one page and does not accept `includeArchived`. On that Core, the CLI does not send it, and the output is the same as before. The CLI does not read Agent links from `list_agents`. Use `call` with `get_agent` for an Agent's links.

`call` keeps the CLI's `{ ok, result | error }` JSON format. It reads 5.0 structured content on success and preserves every field of a structured refusal's `error`, including `code`, `message`, `retryable`, `fix`, and `nextStep`. A 5.0 tool reports invalid input as a refusal with code `invalid_input`; an error that arrives as plain text, as a 4.x tool's input-validation error does, becomes code `tool_error`. It also reads 4.x structured or text envelopes, so explicit calls to tools on older self-hosted Core versions still work. The CLI does not declare card support.

A write can succeed with `result.status` equal to `needs_confirmation`. Read `result.confirmation.preview`, then call `confirm_change` with its `confirmToken` only after the person agrees. The CLI never confirms a change automatically; it prints the exact `confirm_change` command on stderr. When a result carries a setup link, stderr says so and names `cancel_setup_link`. Setup links and confirmation tokens in JSON are capabilities. Treat the output as private.

## How sign-in works

`chickpea login` is an ordinary OAuth 2.1 public client, the same thing Claude Code, Codex, or Cursor do when they connect to `<url>/mcp`:

1. It reads `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/api/auth`.
2. It registers itself at `/api/auth/oauth2/register` with `token_endpoint_auth_method: none`, `application_type: native`, a loopback redirect URI, and the single scope `chickpea:workspace`.
3. It opens the browser. The deployment sends you through Slack sign-in and a one-permission consent page.
4. The code comes back to a listener on `127.0.0.1` and is exchanged with PKCE (S256).
5. The tokens are saved to `$XDG_CONFIG_HOME/chickpea/credentials.json` (or `~/.config/chickpea/credentials.json`), keyed by deployment origin, file mode 0600.

Access tokens last 15 minutes. Commands refresh them silently when they expire. `chickpea logout <url>` revokes the refresh token at `/api/auth/oauth2/revoke` and deletes the entry, so the session can no longer be refreshed. The deployment accepts an access token by its signature and expiry, not by looking up the session, so an access token issued before logout keeps working against `/mcp` until it expires, up to 15 minutes later. Suspending or removing a member in Chickpea blocks their CLI session immediately, without waiting for logout or for the access token to expire. Do that if the credentials file may have been copied.

The protocol pieces come from the official `@modelcontextprotocol/client` SDK. The CLI does not implement OAuth or MCP itself.

## Security notes

- **The CLI never accepts a token.** There is no `--token` flag and no environment variable for a bearer token, provider key, or Slack credential. The deployment issues tokens during `login`; the CLI holds only what that flow returned. Flags that look like credentials are refused.
- **Destructive changes are never auto-confirmed.** Everything your Chickpea role allows applies when you call it, as in Admin. A destructive change, such as deleting an Agent or routine, removing a member or a model provider key, or removing an Agent's connection, returns `confirmation_required` instead. The CLI prints its proposal id and the exact `confirm_workspace_change` command. You run it. The same client must confirm, so use the same machine and session.
- **Setup links are credentials.** When a result carries a setup link, the CLI prints it with a warning: anyone who holds it can complete its exact action without signing in, and it expires in 24 hours. Revoke a leaked link with the `revoke_setup_link` tool.
- **Errors never print secrets.** Error output is one line on stderr with a stable code and a hint. Authorization codes, tokens, and setup capabilities are redacted from any message that passes through.
- **No telemetry.** The CLI sends nothing anywhere except to the deployment you name. `DO_NOT_TRACK` is respected in the sense that there is nothing to turn off.
- **Origins are strict.** Only HTTPS origins and loopback HTTP are accepted, and `login` refuses a URL that is not the deployment's canonical origin.

## Error codes

Every error is `chickpea: <CODE>: <message>. <hint>.` on stderr with exit code 1. With `--json` the same record is emitted as `{"ok":false,"error":{code,message,hint}}`.

| Code | Meaning |
| --- | --- |
| `INVALID_URL` | The URL is not an HTTPS (or loopback HTTP) origin. |
| `SETUP_INCOMPLETE` | The auth surface answered 404. Finish the deployment's Slack setup first. |
| `WRONG_ORIGIN` | The deployment's metadata names a different canonical origin. |
| `NOT_LOGGED_IN` | No saved session for that origin. Run `chickpea login`. |
| `SESSION_EXPIRED` | The refresh token was revoked or the membership ended. Run `chickpea login`. |
| `AUTHORIZATION_DENIED`, `LOGIN_TIMEOUT`, `STATE_MISMATCH` | The browser step did not complete. Retry `chickpea login`. |
| `TOOL_<code>` | A tool refused the request or rejected its input; the normalized envelope is still printed with `--json`. |
| `UPDATE_REQUIRED` | The Core lacks a required 5.0 tool. Update your Chickpea Core. |
| `FILE_TOO_LARGE` | `skills upload` was given a file larger than one call can carry. Upload it in Admin. |
| `UNSUPPORTED_FLAG` | A credential-shaped flag was passed. |

## Development

The package lives at `packages/cli` in the [Chickpea repository](https://github.com/pejmanjohn/chickpea). Package tests run against an in-process MCP server with fake OAuth and tool data. The root test `tests/cli-management-mcp-v5.test.ts` also runs the commands against Core's real management server over loopback HTTP, with isolated in-memory stores:

```sh
npm --workspace packages/cli test
npm --workspace packages/cli run build
```

Licensed under Apache 2.0.
