# Operating and upgrading Chickpea

This guide covers a single-host Node deployment and the existing Cloudflare
deployment wrapper. For a first-time production Mac installation, use
[Install Chickpea on a Mac with Node](../../INSTALL_CHICKPEA_NODE.md). For
first-time Slack setup, use [SETUP_AGENT.md](../../SETUP_AGENT.md).

## Production Node

Use Node 24.x, minimum 24.22.1, and one running Chickpea process per state directory.
Use the 24.22.1 baseline in `.nvmrc` for reproducible installs and verification.
Later Node 24 updates are supported; other majors are outside the support policy.

Node supports scheduled execution while the Chickpea process is running, but not
the coding sandbox. The shared Slack app delivers over an outbound socket. Node
saves each delivery to the installation's SQLite inbox before acknowledging it,
then processes it asynchronously and resumes pending work at startup. The public
HTTPS address serves setup, sign-in, connector callbacks, and Admin links. A
customer-owned Slack app instead sends events to that public address. See
[gateway data handling](../shared-gateway-data-handling.md).

### Build a release

For a new Mac installation, the [Node installer](../../INSTALL_CHICKPEA_NODE.md)
automates the runtime, release build, private settings, and setup launch. Its
`chickpea-node` command is separate from the `chickpea` remote-management CLI.
The manual instructions below remain useful for existing installations and
Linux hosts.

Check out the release tag you intend to run, then install its exact lockfile and
build the production entry point:

```sh
npm ci --strict-allow-scripts
npm run flue:build
```

Run production through `npm run start:node -- --env-file <path>`, not the Vite
development server. The wrapper validates Node, loads only the explicitly named
environment file, and imports Flue's non-listening `dist/app.mjs` artifact so it
can bind to `HOST` (default `127.0.0.1`) and `PORT` (default `3000`). Existing
process environment values take precedence over values in the file. Keep the
release checkout, its `node_modules`, `migrations/`, and `assets/` available at
runtime.

The production wrapper starts the scheduler after Flue finishes assembling its
runtime. It checks for due work immediately and every minute, using the same
missed-slot policy as Cloudflare. A stopped or sleeping computer is not woken;
the startup check recovers eligible missed work when Chickpea runs again. The
wrapper also retries durable Slack schedule actions, performs Work and image
retention maintenance, and every ten minutes renews OAuth connection
credentials that have gone eight hours without renewal, so an idle connection
does not outlive its provider's refresh token. Starting a second production
launcher against the same state database is refused before the app runtime
starts. The development server
and raw `dist/server.mjs` entry do not participate in this guard; never run them
against a production installation's state.

### Persist state and secrets

Create a dedicated OS account, a private state directory such as
`/var/lib/chickpea`, and a protected runtime environment file such as
`/etc/chickpea/runtime.env`. Make the state directory writable only by that
account; use mode 0700 for the directory and 0600 for the environment file.
Do not put state inside a checkout that will be replaced during upgrades.

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
TAG_DB_PATH=/var/lib/chickpea/transcripts.sqlite
SLACK_STATE_DB_PATH=/var/lib/chickpea/state.sqlite
CHICKPEA_AUTH_DB_PATH=/var/lib/chickpea/auth.sqlite
CHICKPEA_CREDENTIAL_KEYRING_PATH=/var/lib/chickpea/credential-keyring.json
CHICKPEA_AUTH_SECRET=REPLACE_WITH_A_STABLE_RANDOM_SECRET
SLACK_TAG_PUBLIC_URL=https://chickpea.example.com
```

Generate the auth secret **once** with `openssl rand -base64 32 | tr '+/' '-_' |
tr -d '='` and save it in the protected file. Never regenerate it on each start.
The credential keyring is created on first use at mode 0600; preserve it along
with every database. Losing encryption keys makes stored credentials unusable.
For the initial setup, run `npm run setup:link -- https://chickpea.example.com`
and add its digest and issued-at variables to the environment file. Keep the
private setup link out of logs and source control.

The explicit paths above avoid these development defaults:

| Data | Default path |
| --- | --- |
| Conversation transcripts | `./tmp/flue.db` |
| App state, identity, claims, configuration | `<TAG_DB_PATH>.state` |
| Better Auth sessions and accounts | `<SLACK_STATE_DB_PATH>.auth` |
| Slack credential encryption keys | `<SLACK_STATE_DB_PATH>.credential-keyring.json` |

Those derived defaults use the resolved state path when no override is set.
Never use `:memory:` for a production database.

### Run under a supervisor

For systemd, adapt these paths to your host. `/usr/bin/node` must be the supported
Node binary, and `/opt/chickpea/current` must point to the intended release.

```ini
[Unit]
Description=Chickpea Slack agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chickpea
Group=chickpea
WorkingDirectory=/opt/chickpea/current
EnvironmentFile=/etc/chickpea/runtime.env
ExecStart=/usr/bin/node scripts/start-node.mjs --env-file /etc/chickpea/runtime.env
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=75
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/chickpea

[Install]
WantedBy=multi-user.target
```

The production entry point handles SIGTERM, stops and drains the scheduler before
Flue, and waits for shutdown with a 60-second internal deadline. Production
launchers enforce one process per state database. Do not use a network filesystem
as a substitute for shared-state support.

Terminate HTTPS at a reverse proxy and forward to port 3000. Keep the default
loopback binding when the proxy runs on the same host. If the proxy requires a
different interface, set `HOST` deliberately and use firewall/container network
rules to make the Node port unreachable from the public internet.
Preserve the public host and HTTPS scheme through the proxy, avoid request-body
logging, and configure streaming rather than buffering Slack-related responses.
Complete Slack setup using the exact HTTPS origin. Verify sign-in, a real Slack
reply, and state surviving a service restart before routing normal traffic.

### Operate an installer-managed Mac

The [Mac installer](../../INSTALL_CHICKPEA_NODE.md) creates a separate home at
`~/.chickpea-node`. It keeps a private Node runtime and complete release source
under `tools/` and `releases/`, with persistent databases and the credential
keyring under `state/`. `runtime.env` holds the stable authentication secret.
The `current` link identifies the installed code. It does not adopt a manual
installation from `~/Library/Application Support/Chickpea/node`.

```sh
"$HOME/.chickpea-node/bin/chickpea-node" start
"$HOME/.chickpea-node/bin/chickpea-node" status
"$HOME/.chickpea-node/bin/chickpea-node" stop
```

`start` runs in the foreground. It manages the application and an optional
Cloudflare Tunnel connector as one lifetime and drains them on shutdown.
Use another Terminal for status and stop. An external proxy remains separately
operated. Logs and setup material are private files inside the installation.

`service install` opts into a per-installation macOS LaunchAgent; `service
uninstall` removes it. Stop foreground operation before enabling it. The agent
starts at login and restarts on failure. It cannot run while the Mac is asleep
or before login. Its absolute private-Node path avoids dependence on nvm and
shell startup settings.

The installer sanitizes the application child environment so shell variables
cannot override its private runtime file. This differs from a direct invocation
of `start:node`, which intentionally lets ambient variables take precedence.
To change managed runtime settings, stop the installation and edit its private
file deliberately. Do not change its state paths, origin, or port independently
of its installation configuration and HTTPS route.

Reruns reuse the same release and settings. The installer refuses a different
release for existing state; it is not an updater. Use the release's migration
instructions and the stopped-backup procedure below. Installing a preview into
a separate home proves neither a safe upgrade nor live Slack acceptance.

### Run an existing manual installation on macOS

Keep the original release checkout and private environment file. To start an
installation created with the earlier manual guide, run its built release:

```sh
npm run start:node -- \
  --env-file "$HOME/Library/Application Support/Chickpea/node/runtime.env"
```

This direct launcher does not install a LaunchAgent or start at login. Keep the Mac awake,
and keep both this launcher and the HTTPS tunnel running. Stop the launcher with
Control-C and wait for its graceful shutdown before closing the Terminal. Reuse
the same environment file and authentication secret for every restart.

### Recover a stale Node process owner

After an unclean exit, the launcher automatically replaces an owner whose PID
no longer exists. If the operating system reused that PID, or the service account
cannot inspect it, startup refuses to take over. It does not assume another
process is safe to displace.

Inspect `owner_pid`, `owner_token`, and `acquired_at` in the state database's
`chickpea_node_runtime_owner` table. Use `ps` to identify that PID and `lsof` to
check which processes have the configured SQLite files open. If Chickpea is
running, stop it through its owning supervisor. If process access is denied,
resolve the service account permissions before proceeding.

Only after verifying that no Chickpea process is using this installation, back
up the stopped state directory and remove the exact stale row. Substitute the
observed PID and token; do not delete the database or clear an unverified owner:

```sql
DELETE FROM chickpea_node_runtime_owner
WHERE singleton = 1 AND owner_pid = <observed_pid>
  AND owner_token = '<observed_token>';
```

Restart using the production launcher and the same environment file.

### Back up and restore Node

1. Schedule an interruption, pause work where supported, and stop new ingress.
   Let active work finish, then stop the Chickpea service.
2. Snapshot the **whole state directory** while stopped, including any SQLite
   `-wal`/`-shm` files and the credential keyring. Back up the runtime environment
   file and record the exact release/commit separately. Copying only the main
   SQLite files while the service is running is not a consistent backup.
3. Encrypt backups, restrict access, and set a retention policy appropriate for
   the Slack content and credentials they contain. Do not attach them to issues.
4. Test restoration on an isolated host with outbound traffic disabled. Restore
   all databases and keys from the same snapshot, with the same secret and code
   version. Confirm SQLite integrity before allowing any Slack/provider traffic.

For a production restore, stop ingress and the service before replacing state.
Do not allow the old and restored copies to answer Slack simultaneously. A
restore rolls state back in time and may lose recent work or replay events;
reconcile that interval before reopening ingress. A backup is not proven until
its restore has been tested.

## Cloudflare operations

Use `npm run deploy` for core or `npm run deploy:sandbox` for the optional coding
sandbox. These wrappers check the generated artifact, preserve the deployed
`AUTH_DB` identity and credential roots, apply reviewed migrations, and check
readiness. Do not bypass them with bare `wrangler deploy`.

On a machine that operates claimed QA lanes (one with a registry under
`~/.chickpea/environments`), the wrapper refuses a deploy that names no target.
Set `CHICKPEA_DEPLOY_TARGET=amber` or `cobalt` for a claimed lane, or
`CHICKPEA_DEPLOY_TARGET=production` to deploy the ordinary `wrangler.jsonc`
Worker on purpose. Self-hosters, Workers Builds, and `--dry-run` are unaffected.

The same deployment includes the public images in `assets/` using Cloudflare
Static Assets. No separate Worker or bucket is needed. Keep the generated
`ASSETS` binding and asset directory in the deployment configuration. These
files are public product images, not user uploads or document-processing code.

Record the account, Worker name, deployed version, traffic allocation, bindings,
and source commit. For a customer update, verify the serving version and
signed-in Admin. Send Slack test messages only when the user requests them.
Development and release QA follow their separately authorized live checks.

Cloudflare stores app/runtime state in Durable Objects as well as auth data in
D1. Backing up or restoring `AUTH_DB` alone does **not** back up or restore the
whole application. Chickpea does not currently provide a complete cross-store
snapshot/restore tool. Keep credential secrets recoverable and follow the
specific release's migration/recovery procedure; stop if it requires a recovery
capability you have not established. Read the [AUTH_DB contract](auth-db-deployment.md).

### Hold a conversation's objects in memory

An idle Durable Object leaves memory about 10 seconds after its last
activity. The next message in that conversation then waits while the object
starts again, up to about 2.4 s for the state store's first read. The
deployment variable `CHICKPEA_RESIDENCY_HOLD_MS` keeps a conversation's
objects in memory for a window after each turn:

- the state store, after a person's turn is admitted and after it ends
- the thread's runner, after a person's turn ends there
- the thread's Agent object, after the last request of any turn it serves

The value is the window in milliseconds, a whole number up to `900000`
(15 minutes). Unset, empty or `0` holds nothing. That is the default, and
Chickpea then behaves as it did before the setting existed. To turn the hold
on, deploy with the variable:

```sh
npm run deploy -- --var CHICKPEA_RESIDENCY_HOLD_MS:600000
```

The state store can hold longer than a thread's objects. An installation has
one store, and each message waits for its first read, while every thread has
its own runner and Agent object. The deployment variable
`CHICKPEA_STORE_RESIDENCY_HOLD_MS` sets the store's own window, a whole number
of milliseconds up to `3600000` (an hour). Unset or empty, the store takes the
`CHICKPEA_RESIDENCY_HOLD_MS` window. `0` turns the store's hold off and leaves
the thread's objects held. To hold the store for an hour and a thread's
objects for 10 minutes:

```sh
npm run deploy -- --var CHICKPEA_RESIDENCY_HOLD_MS:600000 --var CHICKPEA_STORE_RESIDENCY_HOLD_MS:3600000
```

The deploy refuses any other value for either variable. A Worker that reads
one anyway, for example after an edit in the Cloudflare dashboard, holds
nothing for a refused `CHICKPEA_RESIDENCY_HOLD_MS`, and gives the store the
`CHICKPEA_RESIDENCY_HOLD_MS` window for a refused
`CHICKPEA_STORE_RESIDENCY_HOLD_MS`. Upgrades keep both variables.

Before you turn it on, check these five points:

- **The thread's objects, and a store window over 10 minutes, need a
  compatibility date of 2026-10-01 or later.**
  The hold is a pending timer. A pending timer always stops an object from
  hibernating. It stops Cloudflare from evicting the object only from
  compatibility date `2026-10-01`, or with the
  `durable_object_io_tasks_prevent_eviction` compatibility flag
  ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/)).
  One timer stops eviction for at most 15 minutes from when it was set, so
  the hold sets a new timer at least every 14 minutes until the window ends.
  `wrangler.jsonc` has neither. Without them, the state store stays in memory
  only while its 20-second keep-warm alarm runs, because each firing counts
  as activity. The alarm runs for 10 minutes after a person's turn is
  admitted, whatever the window. It does not start again when the turn ends,
  so the rest of a window after a long turn, or a window over 10 minutes, is
  not covered. The runner and the Agent object are evicted 70 to 140 seconds
  after a turn.
- **A held object is billed.** Cloudflare bills duration at 128 MB for as
  long as an object cannot hibernate
  ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
  A 10-minute window is 76.8 GB-s per object. On Workers Paid that is about
  $0.00096 at $12.50 per million GB-s, after the 400,000 GB-s included each
  month. An installation whose people talk to it at least every 10 minutes
  keeps its state store in memory all day, about 11,000 GB-s. An hour's store
  window costs about $0.0058 for each hour the store waits for the next
  message, and it never costs more than a store held all day.
- **Workers Free can run out.** Workers Free allows 13,000 GB-s of duration a
  day. Past it, the installation's Durable Objects fail until 00:00 UTC. With
  a 10-minute window, the state store uses about 461 GB-s per hour of
  conversation. Each thread conversation adds about 154 GB-s for its runner
  and Agent object once eviction is blocked. Eight active hours and about 60
  thread conversations reach the limit. An hour's store window adds every
  pause under an hour, and the hour after the day's last message, at about
  461 GB-s an hour. Turn the hold on only on Workers Paid.
- **After a deploy, recently active conversations run the previous code for
  up to 5 minutes.** Cloudflare defers a code update for an object in memory
  for up to 300 seconds, and an object that has left memory starts on the new
  code at its next request
  ([code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)).
  With the hold on, every object active in the last window is in memory at
  the deploy. So a check right after a deploy, in a workspace that was active
  in the last window, can exercise the previous release's state store, runner
  and Agent object. Wait 5 minutes before such a check, or run it in a
  workspace that has been quiet for longer than the window.
- **A held object's last records reach Workers Logs late.** Cloudflare
  writes an invocation's logs when it ends. The hold's timer keeps the
  object's latest request open until the hold ends or the object receives
  another request.
  - Nothing calls a runner or an Agent object after its turn. On staging,
    their end-of-turn records arrived about 10 minutes after the turn. Read
    them at least the `CHICKPEA_RESIDENCY_HOLD_MS` window plus a minute after
    the last turn.
  - The state store receives another request soon: its 20-second alarm for
    10 minutes after a turn, and the scheduled tick's maintenance call every
    minute. On staging, with a 10-minute hold, no store request stayed open
    for more than 42 seconds in two days. Only a store that nothing calls
    keeps its last request open for its whole window, up to an hour.

### Admit Slack messages in the state store

On Cloudflare, the Worker admits a direct installation's Slack message itself.
It verifies the request, then makes 20 or more calls to the installation's
state store before the turn is admitted, each one a round trip. That is about
a second before the first status shows. With the deployment variable
`CHICKPEA_SLACK_ADMISSION` set to `store`, the Worker sends a verified
`message` or `app_mention` to the state store in one call. The store admits it
on its own stores, as it admits the shared gateway's deliveries, and shows the
first status from there.

```sh
npm run deploy -- --var CHICKPEA_SLACK_ADMISSION:store
```

Unset, or any other value, keeps the Worker's own admission. That is the
default. Every other Slack event (reactions, joins, App Home, the Stop button,
installation events) takes the Worker's path either way. To turn it off,
deploy with `--var CHICKPEA_SLACK_ADMISSION:worker`. Upgrades keep the
variable.

Before you turn it on, know these four points:

- **The store reads Slack.** Admission reads the sender, and for a Channel the
  conversation, with the installation's bot token from the state store
  instead of the Worker. The reads count against the same read budget.
- **A thread's new messages keep their order.** The store admits one
  thread's messages in the order they reached it, and different threads side
  by side. A message checks the recovery gate and the installation, and
  reads the bot's credentials, when its turn in the thread comes. A Slack
  call that hangs holds that thread's later messages for up to 10 seconds,
  the Slack client's timeout. A Slack rate limit does not hold them: the
  store does not wait out Slack's `Retry-After`, and the rate-limited
  message fails as it does on the Worker's path once that wait ends.
  `slack_store_admission` counts it in `rateLimited`. Edits and deletes are
  not ordered with their message's thread, as on the Worker's path.
- **A store on the previous code falls back.** After a deploy that brings the
  store's new method, a store still in memory runs the previous code for up
  to 5 minutes, and the Worker's call to it fails. The Worker then admits that
  message itself, once, and logs `state_rpc_fallback`. With the residency
  hold on, every conversation active in the last window meets this. A deploy
  that only turns the variable on, on a release that already has the method,
  has no such window.
- **A failure after Slack's acknowledgement is not retried,** as before.
  Slack is acknowledged before the message is admitted.

To check it, read the `state_rpc_summary` records of scope `slack_delivery`:
`path` says who admitted each delivery (`store`, `worker`, `fallback`), and
`calls` is 1 on the store's path. A `fallback` with `reason: store_failed`
is a delivery the store's admission failed on. The Worker does not admit it
again, so it is lost unless the store committed a turn before it failed:
`turns` on its `slack_store_admission` record (`outcome: failed`) says. The
store logs `slack_store_admission` for each delivery it admits, with
`rpcCalls` 0. See [runtime observability](runtime-observability.md).

### Stream answers by host release

An Agent's answer streams into Slack today only when the model calls
`stream_answer` before it, and models rarely do. With the deployment variable
`CHICKPEA_SLACK_ANSWER_RELEASE` set to `host`, the host streams a model step's
text itself once the step holds `CHICKPEA_SLACK_ANSWER_RELEASE_CHARS` settled
characters (400 when unset) and has made no tool call. A shorter answer posts
whole, as before.

```sh
npm run deploy -- --var CHICKPEA_SLACK_ANSWER_RELEASE:host
```

Unset, or any other value, keeps the model's declaration as the only way an
answer streams. That is the default. A hold that is not a whole number from
100 to 4000 also turns host release off; the deploy does not refuse it. Each
isolate that reads such a hold logs one warning, `answer_release_hold_refused`
with `component: "slack"` and `reason` (`not_whole_number` or
`out_of_range`), and never the value. After you set a hold, check that
`answer_release` shows it in `holdChars`.
`SLACK_TAG_PROGRESSIVE_STREAMING=false` turns all streaming off either way.
Upgrades keep both variables.

Before you turn it on, know these points:

- **Text can appear and then disappear.** A model may write past the hold and
  then call a tool. The host then stops and deletes the streamed message, the
  tool runs, and the final answer posts fresh, with no correction marker. This
  happens in DMs and Channel threads alike. A stream that carries the native
  task card keeps its text instead, and the final corrects it, so the card
  stays.
- **Some replies still post whole.** A reply that changes workspace settings,
  hands off to another Agent, creates an Agent, uploads files, asks a question,
  or shows cards or the Add key card stays terminal-only.
- **A message sent during the answer waits.** Once the final step passes the
  hold, a message the person sends meanwhile gets its own turn instead of
  joining this reply.
- **The hold is a measured choice.** A lower hold streams sooner and deletes
  more often. Read `answer_release` before you change it: `hostRelease` says
  what the release did, and `preToolTextN` how often a model writes N
  characters before a tool call. See
  [runtime observability](runtime-observability.md).
- **`stream_answer` stays mounted.** A model that declares still locks its
  later tools, as before; the host release does not wait for the declaration.

### Clear old tool results on Anthropic

Most of a long thread's prompt is old tool results. Each model request sends
them again, and the prompt cache must hold them. With the deployment variable
`CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING` set to `on`, an Agent's requests to
the Anthropic API ask Anthropic to clear old tool results on its side
([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing),
`clear_tool_uses_20250919`). When a prompt passes 250,000 input tokens,
Anthropic replaces the oldest results with a placeholder. It keeps the
results of the 8 most recent tool uses, every tool call with its input, and
all message text. It clears only when it can remove at least 60,000 tokens.

```sh
npm run deploy -- --var CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING:on
```

Unset, or any other value, sends requests as before. That is the default. On
Node, set the variable in the process environment. Upgrades keep it and its
settings.

Three more variables change the settings. Each takes a whole number. A value
that is not one, or is out of range, is ignored and the default applies; the
deploy does not refuse it.

| Variable | Default | Range | What it sets |
| --- | --- | --- | --- |
| `CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING_TRIGGER_TOKENS` | 250000 | 1 to 1000000 | The prompt's size, before clearing, above which Anthropic clears |
| `CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING_KEEP_TOOL_USES` | 8 | 1 to 100 | How many of the most recent tool uses keep their results |
| `CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING_CLEAR_AT_LEAST_TOKENS` | 60000 | 1 to 1000000 | The least a clearing must remove, or Anthropic skips it |

Before you turn it on, know these points:

- **Only an Agent's requests to the Anthropic API change.** Own-key and
  credits requests both do. Requests to OpenAI, OpenRouter, Gemini or a
  ChatGPT plan do not, and neither do compaction summaries or one-off
  requests such as an attachment read.
- **An Agent forgets old tool data.** In a thread past the trigger, the Agent
  no longer sees the bodies of tool results older than its last 8 tool uses.
  It still sees each call it made and what it wrote about the result, and it
  can make the call again. Nothing tells the person.
- **Some results are never cleared**, because the Agent cannot fetch them
  again. `activate_skill`, `read_skill_resource`, `inspect_memory`,
  `update_agent_memory` and `request_chickpea_handoff` return instructions.
  `present_cards`, `prepare_connector_setup`, `apply_workspace_changes` and
  `manage_agent_skill` return a short receipt with a handle that a later
  call needs: a card set's ref, a setup link's operation ID, or the
  operation ID an undo takes. A connection's or an MCP server's tools are
  not on the list, whatever they return.
- **Each clearing rewrites the cache once.** The prompt changes from the
  first newly cleared result to its end, and Anthropic charges a cache write
  for that part. Between clearings the cleared prompt does not change, so
  later requests read the cache. The defaults make clearings rare and large.
- **Thinking should stay valid.** Anthropic clears on its side, so no earlier
  thinking block should fail its check that the conversation is unchanged.
  One probe request confirmed it. No `model_step` field counts a dropped
  thinking block yet, so the log cannot show a case where it fails.
- **Each request is as large as before.** Chickpea's stored conversation
  keeps every result, and each request still sends the whole history. Only
  the prompt the model reads gets smaller.
- **Compaction sees the cleared size.** Flue compacts when the prompt size
  the provider reports nears the model's window. Anthropic reports the size
  after clearing, so a thread with clearing on stays far below that line and
  seldom compacts. If the history outgrows Anthropic's request size limit,
  Anthropic refuses the request and Flue compacts then, as it does today.
- **Nothing else bounds a thread's size.** Without clearing, compaction
  keeps a request to a few megabytes. With it, the stored conversation and
  each request grow until that limit, which is 32 MB. Each step builds,
  serializes and uploads a request of that size, and no test has measured
  the Worker's memory at it. Watch `requestBytes` on `model_step`, and keep
  clearing off where a thread could reach tens of megabytes.

To check it, read `model_step`: `clearedToolUses` and `clearedInputTokens`
are what Anthropic cleared from each request's prompt, and a rise between two
steps of one thread is a new clearing. See
[runtime observability](runtime-observability.md).

## Upgrade and compatibility policy

For routine Cloudflare updates, follow the
[coding-agent update guide](../../UPDATE_CHICKPEA_CLOUDFLARE.md). Preserve the
installation's live settings in the release checkout and run `npm run deploy`.
The `supportedOrigins` list and recovery requirements belong to the optional
[receipt-based updater](upgrading.md); they do not block ordinary updates.
Review required migrations and preserve existing data. Rollback support is not
a prerequisite for a forward update.

Before the first tagged release, older experimental schemas may be incompatible.
That is not permission to delete a production database. A disposable pre-release
installation may be recreated only when its operator explicitly accepts losing
its data.

The first release establishes the versioned baseline. During 0.x, releases may
change APIs, configuration, or schemas. Release notes must state supported
starting versions, required operator actions, and migrations.
There is no implied upgrade path from an unlisted experimental schema.

A saved custom API connection that names `uploads.github.com` no longer reaches
it: that host is now reserved for the GitHub App integration, like
`api.github.com` and `github.com`, so Admin refuses it and each turn drops it
from the connection's allowed hosts without notice, keeping a pasted credential
away from GitHub outside the App's repository scoping and write budget.

For Node upgrades:

1. Read the destination release notes and confirm the starting version is
   supported. Record the current source/version and deployment configuration.
2. Establish a tested recovery point using the stopped backup procedure above.
3. Rehearse on an isolated copy or approved disposable environment. Preserve
   state paths, the auth secret, encryption keys, and existing resource IDs.
4. Stop/drain traffic as required. Install/build the new checkout and restart
   the supervised service against the same state paths.
5. Verify sign-in and the serving version. Send Slack messages or run other
   product checks only when the user requests them.

Do not edit already-applied migration SQL: its digest is part of the auth
database contract. Add a forward migration and test both fresh creation and
upgrade from the preceding supported release. Reverting code does not undo a
schema migration or recover deleted data. Downgrade only when the release notes
declare it safe; otherwise use the tested full recovery procedure or a forward
fix. Never silently reset an incompatible database to make an upgrade pass.

### Recover a stalled rollback

A release can write records an older release cannot read. A rollback from
v0.1.30 to v0.1.27, v0.1.28 or v0.1.29 has two such records, and the older
release stalls on them instead of skipping them:

- On a shared-gateway installation, a Slack button click or form submission
  still queued at the rollback. The older release retries that entry first on
  every pass and processes no Slack event until the entry ages out after 7 days.
- A turn still running on an OpenRouter model newer than the built-in model
  list, from a reply, routine run or coding task. The older release cannot read
  the pending turn, and no thread starts a new turn.

Before rolling back from v0.1.30, make sure no reply, routine or coding task on
such a model is running.

A stalled rollback shows as Slack going quiet in every thread. On Cloudflare,
every state-store alarm fails, so each `relay_alarm` log line reports
`"outcome":"threw"` (see
[runtime observability](runtime-observability.md#turn-latency-and-relay-alarm-logs)).
The Worker also logs `Stored gateway delivery is invalid.` for the gateway
entry, or `Runtime plan runtimeModelRoute has unknown field reasoning.` for the
OpenRouter turn. A Node installation stalls the same way and repeats the
failure in its service log.

Recover by deploying v0.1.30 forward with the ordinary `npm run deploy` (or
`npm run deploy:sandbox`), or on Node by restarting the service on the v0.1.30
checkout. It reads and processes the stuck record. Roll back again only after
that work has finished. Do not edit or delete state records to unblock the
older release.

One smaller effect remains after any rollback from v0.1.30. A person who used
such an OpenRouter model with an Agent in a thread gets failed replies from that
Agent there, even after the Agent moves to another model, because the older
release cannot read the thread's earlier turn. Other threads are unaffected,
and updating again clears it.

A rollback from v0.1.31 or later to v0.1.30 or earlier stalls the same way on any of
three kinds of turn that has not finished: a turn that starts a conversation
(a new thread, the first turn in an older thread after the update, or a routine
run), a question one Agent asks another, and a turn whose saved thread context
includes a post from an app. The Worker logs
`Flue dispatch target does not match its RuntimePlanV2.`,
`Runtime plan conversation has unknown field guest.` or
`Runtime plan handoff context role is invalid.` respectively. Before rolling
back, make sure no reply, routine run, coding task or Agent-to-Agent question
is running. Recover by deploying the release you rolled back from forward as
above. A person whose latest turn with an Agent in a thread carried an app's
post gets failed replies from that Agent there until you update again.

Later releases set an unreadable record aside instead of stalling. The gateway
queue marks such an entry for recovery, scrubs its body, and logs
`gateway_delivery_unreadable` with only its kind. A turn becomes
recovery-required with reason `stored_turn_unreadable`. List those turns with
`GET /admin/api/runtime/recovery-turns` and close one with
`POST /admin/api/runtime/recovery-turns/:id/resolve`. A thread's unreadable
earlier turn no longer fails its replies. No Agent answers a click or message
set aside this way, so ask the person to send it again.

## Build-time Node and Cloudflare runtimes

Cloudflare Workers Builds reads `.nvmrc`; an explicit `NODE_VERSION` build
variable should match its 24.22.1 pin. Inspect existing build overrides before
building a candidate. These are build settings, not Worker runtime variables.
See [Cloudflare's build image documentation](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

A Worker runs in workerd with its own `compatibility_date` and flags. Changing
Node does not change that runtime or remove artifact, workerd, or Slack acceptance.
See [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

The optional coding sandbox uses Cloudflare's `sandbox:0.12.14` container, whose
embedded Node 22.23.4 runs sandbox tooling, not the Chickpea host or build. Its
image tag must match `@cloudflare/sandbox`; leave this vendor-owned runtime alone
when updating Chickpea's Node pin. Validate SDK/image updates separately. The
`Dockerfile` pins that tag by digest: an SDK update changes the version, tag and
digest together, and `npm run verify:hygiene` refuses a mismatch or an unpinned
`FROM`.

### Schedule account requirements during edits

A saved schedule revision cannot run until its account requirements have been
bound to that revision. Pause and resume retain the saved binding. An unbound
revision may mean an edit is still running or that binding failed; waiting alone
does not repair a failed edit. Retry the original durable action, or submit a
fresh edit declaring the exact required accounts (`requiredConnectionAccountIds`,
including `[]` for connection-free work). Use the intended accounts, not extra
accounts to bypass the check. This repairs the binding but preserves an existing
pause; resume only after the underlying failure is resolved.

A due run can encounter the short save-to-bind window and pause the schedule for
missing authority. A later successful bind intentionally does not clear a
`needs_attention` reference: the same state can represent other authority
failures. After binding has completed and the actor, Agent, destination and
connections are available, repair Channel schedule authority through the existing
authenticated Admin route
`POST /admin/api/agents/:id/schedules/:scheduleId/reassign`. The Runs as member
must be signed in as an Agent editor; supply their own `runsAsMembershipId` and
the current `expectedAuthorityRevision`. Omit account IDs to retain the existing
exact set, or explicitly supply its intended replacement. The route revalidates
authority and resumes only recognized authority-related pauses. It does not
repair an unbound saved revision, so complete the binding repair first.
Over the management MCP, the same repair is the `take_over_routine` operation:
the signed-in editor becomes the Runs as member, with the same account and
resume rules.

For a private DM schedule, the owner can ask Chickpea to reassign its owning
Agent through the existing `reassign_routine_agent` operation, retaining the same
Agent if appropriate, then resume the schedule. Private schedules are excluded
from the Channel Admin repair route. Do not clear a pause or edit state records
directly to skip these checks.

Existing schedules retain their saved account requirements. Cloning requires
the source schedule's saved requirements; a legacy source without an authority
reference must be repaired before cloning. Unexpired pre-upgrade create/edit
confirmation receipts cannot supply the current account requirements. Request
a fresh create or edit instead; rejecting the old receipt does not change the
schedule. Deletion confirmations continue to work.
