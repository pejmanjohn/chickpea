# chickpea-cli

The official command line for a self-hosted [Chickpea](https://chickpea.co) deployment. It checks a deployment's public surface, prints MCP client configuration, signs you in with the same OAuth 2.1 flow every MCP client uses, and gives scripts access to every workspace management tool without building an MCP integration by hand.

```sh
npx chickpea-cli doctor https://chickpea.example.com
```

Requires Node 24.x, minimum 24.20.0 (`>=24.20.0 <25`). Development and publishing use the repository's `.nvmrc` baseline, 24.20.0. The binary is `chickpea`; install it globally with `npm install -g chickpea-cli` or run it through `npx chickpea-cli`.

## Commands

| Command | Sign-in | What it does |
| --- | --- | --- |
| `chickpea doctor <url>` | no | Fetches the OAuth discovery documents, the signing keys, and the unauthenticated MCP challenge. One line per check, exit 1 on any failure. |
| `chickpea mcp config <url> [--client claude-code\|codex\|cursor\|json]` | no | Prints the MCP client configuration for `<url>/mcp`. Default: every client. |
| `chickpea login <url>` | browser | Registers a public PKCE client, opens the browser for Slack sign-in and consent, and saves the tokens. |
| `chickpea logout <url>` | saved | Revokes the refresh token at the deployment and deletes the saved session. |
| `chickpea workspace inspect <url> [--json]` | saved | Calls `inspect_workspace` and prints Agents, skills, connections, repositories, channels, provider availability, and team. |
| `chickpea tools list <url>` | saved | Lists every management tool with its annotations. |
| `chickpea call <url> <tool> [--args '<json>' \| --args-file <file>]` | saved | Calls any tool and prints its `{ ok, result \| error }` envelope as JSON. Exit 1 when `ok` is false. |
| `chickpea recipe export <url> [--agents id,id]` | saved | Writes a secret-free portable recipe to stdout. |
| `chickpea recipe preview <url> <recipe.json>` | saved | Compares a recipe with the live workspace and prints the operations to apply. |

Global flags: `--json` for machine output on stdout, `--quiet` to silence progress notes on stderr, `--help`, `--version`.

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
Workspace org_7f3a (revision 41)

Agents (2)
  Support  @support  id=agent_support  rev=12  active  presence=healthy
    model: openai/gpt-5.6-terra
    skills: refunds
    connections: ops@example.com (team, ready)
  Revops  @revops  id=agent_revops  rev=3  active  presence=healthy

Channels (1)
  #support C0123ABC  active  grants: agent_support:active

Providers (3)
  openai: configured (env, read-only), 2 inheriting Agents
  anthropic: not configured
  openrouter: not configured

$ npx chickpea-cli call https://chickpea.example.com apply_workspace_changes --args-file archive.json
{
  "ok": true,
  "result": {
    "operationId": "op_9c2",
    "status": "confirmation_required",
    "outcomes": [
      { "itemId": "archive", "operationKind": "archive_agent", "disposition": "confirmation_required", "proposalId": "prop_5e1" }
    ]
  }
}
Proposal prop_5e1 is waiting for confirmation. Nothing has been applied.
Review the preview in the result, then confirm it from this same CLI session with:
  chickpea call https://chickpea.example.com confirm_workspace_change --args '{"proposalId":"prop_5e1"}'

$ npx chickpea-cli recipe export https://chickpea.example.com --agents agent_support > recipe.json
$ npx chickpea-cli recipe preview https://chickpea.example.com recipe.json
```

A recipe preview returns typed operations. Apply them with `chickpea call <url> apply_workspace_changes --args-file ops.json`, where the file wraps them as `{ "idempotencyKey": "...", "operations": [...] }`. The [workspace management runbook](https://github.com/pejmanjohn/chickpea/blob/main/docs/runbooks/workspace-management-mcp.md) describes every tool, the proposal model, and what the setup links do.

## How sign-in works

`chickpea login` is an ordinary OAuth 2.1 public client, the same thing Claude Code, Codex, or Cursor do when they connect to `<url>/mcp`:

1. It reads `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/api/auth`.
2. It registers itself at `/api/auth/oauth2/register` with `token_endpoint_auth_method: none`, `application_type: native`, a loopback redirect URI, and the single scope `chickpea:workspace`.
3. It opens the browser. The deployment sends you through Slack sign-in and a one-permission consent page.
4. The code comes back to a listener on `127.0.0.1` and is exchanged with PKCE (S256).
5. The tokens are saved to `$XDG_CONFIG_HOME/chickpea/credentials.json` (or `~/.config/chickpea/credentials.json`), keyed by deployment origin, file mode 0600.

Access tokens are short-lived. Commands refresh them silently when they expire. `chickpea logout <url>` revokes the refresh token at `/api/auth/oauth2/revoke` and deletes the entry. Suspending or removing a member in Chickpea blocks their CLI session immediately, without waiting for logout.

The protocol pieces come from the official `@modelcontextprotocol/client` SDK. The CLI does not implement OAuth or MCP itself.

## Security notes

- **The CLI never accepts a token.** There is no `--token` flag and no environment variable for a bearer token, provider key, or Slack credential. The deployment issues tokens during `login`; the CLI holds only what that flow returned. Flags that look like credentials are refused.
- **Proposals are never auto-confirmed.** When a result carries `confirmation_required` or a proposal, the CLI prints the proposal id and the exact `confirm_workspace_change` command. You run it. The same client that proposed must confirm, so use the same machine and session.
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
| `TOOL_<code>` | A tool answered `ok: false`; the envelope is still printed with `--json`. |
| `UNSUPPORTED_FLAG` | A credential-shaped flag was passed. |

## Development

The package lives at `packages/cli` in the [Chickpea repository](https://github.com/pejmanjohn/chickpea). Tests run against an in-process fake deployment that mirrors the server's OAuth and MCP contract:

```sh
npm --workspace packages/cli test
npm --workspace packages/cli run build
```

Licensed under Apache 2.0.
