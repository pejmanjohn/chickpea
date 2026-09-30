/** Public instructions for a local coding agent; never includes connection secrets. */
export function chatgptConnectMarkdown(origin: string): string {
  return `# Connect ChatGPT to Chickpea

Connect the user's ChatGPT account to this existing Chickpea installation:
${origin}

This is a one-time connection for the installation's Agents. Chat uses the
connected account's eligible models and plan limits. Image generation requires
an explicitly configured OpenAI API key, billed separately.

## Run setup on the user's computer

Use a local coding agent such as Codex, Claude Code, or Cursor with terminal
access on the same computer as the user's browser. A remote MCP server can
provide these instructions, but cannot receive the browser's localhost callback.
If you only have a remote terminal, ask the user to continue in a local coding
agent. Do not start the callback receiver on the Cloudflare Worker or a remote VM.

1. Confirm the target above is the installation the user wants to connect.
   Preserve its API key, Slack setup, and other settings. Do not redeploy or
   update software merely to connect an account.
2. Use Node.js 24.20.0 or a newer Node 24 patch. If it is missing, handle installing
   that runtime using the local agent's normal permission flow.
3. If you have this installation's source checkout, run its bundled connector:

   \`node assets/chickpea-chatgpt-connect.mjs '${origin}'\`

   Otherwise, download \`${origin}/chickpea-chatgpt-connect.mjs\` yourself to
   a private temporary directory, then run that saved file with Node 24 and
   \`${origin}\` as its sole argument. Require HTTPS, a successful response,
   and the same origin without redirects. Do not pipe a download into a shell.
   Do not ask the user to download a helper, paste credentials, or run commands.
   Do not assume an older globally installed CLI supports this connection flow.
4. Keep the process running while the user signs in. It opens
   ${origin}/admin/settings/providers in their browser. If automatic opening
   fails, open the setup URL printed by the process using the local browser.
   The user must be signed in as this installation's owner. Ask for any human
   sign-in or account selection needed; never read passwords or session tokens.
5. In the Connect ChatGPT dialog, continue to OpenAI. The connector then opens
   OpenAI in the local browser. Let the user sign in and approve access. Return
   to the Chickpea Admin tab to confirm the displayed account with **Use this
   account**. Verify that it matches the account the user requested; if they
   have not chosen an account, ask before accepting it.
6. Wait for Admin to show the connected account and for the local process to
   report completion. Choose a model from the account's current model list.
   Honor a model the user named; otherwise ask them to choose or delegate the
   choice. Connecting selects the ChatGPT plan for OpenAI chat, so complete
   model selection before claiming setup is finished. During onboarding,
   return to setup and complete its model selection step.
7. Remove any temporary connector file after the process exits. There is no
   background service to keep running. Leave an existing API key available for
   images. Do not send Slack test messages unless the user also requested them.

## Recovery and privacy

The original Admin tab watches for setup and account confirmation. If it stops
checking, use **Check status**. If sign-in expires or the local process exits,
cancel the pending sign-in in Admin and start the connector again. Closing the
dialog does not disconnect an existing account.

Keep OAuth codes, tokens, browser cookies, and local credential files out of
chat, MCP tool arguments, logs, and source control. The connector handles the
credential transfer directly; never copy tokens from another application's
login or ask the user to paste a callback URL. Report only the connected account,
selected model, and any actionable failure.
`;
}
