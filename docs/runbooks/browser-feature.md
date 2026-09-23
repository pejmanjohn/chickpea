# Browser feature

Operator notes for the hosted browser that Agents use to open websites. The
person-facing guide is on the docs site; this page covers the settings,
state, deploy path, and first checks when a browser tool fails.

## Provider and key

- One provider per install: Browserbase. The browser runs in the customer's
  own Browserbase project. One browser per session, destroyed afterwards;
  Browserbase keeps session recordings for 30 days.
- Admin **Settings → Browser** (`/admin/settings/browser`, Owner or Admin)
  verifies a pasted key against Browserbase before storing it.
- Settings rows: `browser.browserbase.apiKey` and, optionally,
  `browser.browserbase.projectId`. **Disconnect** deletes both.
- Environment overrides: `BROWSERBASE_API_KEY` and optional
  `BROWSERBASE_PROJECT_ID`. An environment key wins over the stored row, and
  the Admin card becomes read-only and names the variable. Works the same on
  Cloudflare (Worker secret) and Node (process environment).
- Plans: the Browserbase free plan includes one browser hour a month. Sign-in
  hand-offs keep a session alive, which needs a paid Browserbase plan.

## Usage

- Monthly counters: `browser.monthlyUsage.YYYY-MM` (UTC month) with session
  count and browser seconds. The Settings card reads the current month.
- Budget: ten minutes of browser time per reply. When it is spent the Agent is
  told to answer with what it found.
- Recordings attach through the normal Slack file path, so the transport cap
  applies: 700 KiB on shared-gateway installs, 8 MiB on direct-transport
  installs. A recording over the cap is not attached and the Agent says so.

## Website logins

- Metadata row: `browser.logins.v1` (host, label, method, owner, which Agents
  hold it, last used; at most 100 logins). No secret is in this row.
- Secrets: encrypted revisions keyed `website_login.<id>`, envelope purpose
  `website_login`, sealed with the install's credential keyring. Passwords and
  one-time code secrets are typed by Chickpea and never enter model context.
- Keyring rotation gap: website-login secrets are not re-encrypted when the
  current credential key changes. Keep every retired key slot
  (`CHICKPEA_CREDENTIAL_KEY_<ID>` on Cloudflare, the keyring file on Node)
  until each login has been saved again under the new key.
- Saved sign-in: each login's signed-in session lives in the Browserbase
  project. Removing a login from an Agent deletes the saved sign-in only when
  no other Agent still holds that login.
- Hand-off: a kept-alive Browserbase session of up to 10 minutes. The private
  live-view link goes only to the requester; it never enters model context.

## Actions and approval

- Public sites and check-only logins are read-only.
- On a login set to take actions, a data-changing step (submit, buy, post,
  delete, sign up) waits for an exact `approve` or `stop` reply in the thread.
- Pending action records: `browseraction_<id>`, 15-minute TTL, valid for that
  exact step only. An expired or mismatched record is refused, and the Agent
  asks again.

## Deploys

- Lane deploys carry `BROWSERBASE_API_KEY` through the guarded wrapper with
  `CHICKPEA_DEPLOY_SECRETS_FILE`; see
  [environments](../../qa/live/operator/environments.md). Never upload it with
  a bare Wrangler secret command.
- Worker size: browser modules (CDP client, page driver, provider) load lazily
  on the first browser tool call, so they add little to cold start. The build's
  size gate still applies.

## When a browser tool fails

1. **Settings → Browser**: is the card **Ready**, is the key the expected one
   (last four characters), and is monthly usage plausible? The card does not
   re-check a stored key; a key revoked at Browserbase still reads **Ready**,
   so compare the key ending with the Browserbase dashboard.
2. Browserbase dashboard, **Sessions**: find the session by time. Check its
   status, duration, and recording. A session that never started points at the
   key, project, or plan; one that ended early points at the per-reply budget or
   a Browserbase timeout.
3. `npm run diagnose -- --help` for a bounded request-to-trace lookup of the
   turn. Preserve the first failure's evidence before retrying, per
   [runtime observability](runtime-observability.md).
4. Recording not attached: compare its size with the transport cap above
   before treating it as a failure.
