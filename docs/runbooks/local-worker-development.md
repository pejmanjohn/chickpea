# Local Cloudflare Worker development

Use this lane for fast Chickpea iteration that needs a real Slack workspace,
Cloudflare's Worker runtime, persistent local state, and the deployed reference
model. It does not replace deployed Amber/Cobalt acceptance.

## What the lane is

One lane owns one Developer sandbox, one customer-owned Slack app, one named
HTTPS tunnel, one local state directory, and one worktree. Its transport is
normal Slack HTTP Events and interactivity. The Socket Mode bridge is not part
of this workflow and remains unsuitable for full product verification.

The default model is `cloudflare/@cf/openai/gpt-oss-120b`, matching the deployed
reference used when this workflow was established. Workers AI remains a remote
binding; application code, Durable Objects, D1, queues, workflows, assets, and
other supported Cloudflare bindings run through the Cloudflare Vite plugin and
workerd. Confirm the deployed reference model before a comparison if that
setting has changed.

Keep every sandbox, app, state directory, and endpoint exclusive. Never point a
local lane at the shared app/gateway or an Amber/Cobalt app. A Slack workspace
name or hostname is not enough: bind and inspect immutable workspace and app
IDs.

Before provisioning, check the signed-in account's current Developer Program
eligibility and [Developer sandbox inventory](https://docs.slack.dev/tools/developer-sandboxes/).
Slack documented at most two active sandboxes when this lane was established;
an existing sandbox consumes a slot. Do not delete or repurpose one to make
room without explicit operator approval. In the new sandbox, enable **Members:
Create and edit user groups** under **Admin > Account types** before testing
Agent handles. Ordinary Free workspaces are not substitutes because they lack
the required user groups.

## One-time initialization

Use the repository's pinned Node version and an existing remotely managed named
Cloudflare Tunnel. Its public hostname must route to the local Vite port.

```sh
nvm use
npm ci
npm run dev:cf -- init \
  --lane local-a \
  --public-url https://local-a.example.com \
  --tunnel chickpea-local-a \
  --port 8787
```

`init` creates ignored, mode-0600 material below
`.chickpea-local-worker/<lane>/`, including durable local state, credentials, a
24-hour setup capability, and a lane manifest. This root is deliberately
outside Wrangler's disposable `.wrangler-state` tree. It links the worktree's
ignored `.dev.vars` to that lane. It refuses to replace an existing `.dev.vars`
or to change initialized coordinates.

Start the Worker:

```sh
npm run dev:cf -- start --lane local-a
```

The start command applies local D1 migrations, claims the public endpoint for
this worktree, starts Vite/workerd, restores the named tunnel, and preserves the
same state across restarts and code reloads. Leave this terminal running.

Open the private setup link without copying it into a run record:

```sh
npm run dev:cf -- setup-link --lane local-a
```

In setup, choose **Use your own Slack app instead**. Generate a short-lived App
Configuration token for the lane's exact Developer sandbox and let Chickpea
create the app from the canonical manifest. Do not retain the configuration
token, refresh token, Slack credentials, OAuth code/state, or setup capability.
Finish Slack installation, Owner verification, provider selection, and model
selection in the browser. Use the lane's stable HTTPS origin for Events,
interactivity, and OAuth redirects.

The tunnel session currently starts with a one-hour lease. Extend it from the
owning terminal before long OAuth work. If it expires, restart the same lane;
state and credentials remain, but an in-flight OAuth initiation may need to be
started again. Revoke the short-lived Slack App Configuration token after the
app has been created.

After Slack returns the immutable IDs, bind them to the lane:

```sh
npm run dev:cf -- bind-slack \
  --lane local-a \
  --workspace-id T... \
  --workspace-label "Chickpea Local A" \
  --app-id A... \
  --app-label "Chickpea Local A"
```

If private setup expires before completion, rotate only its capability and
restart the Worker:

```sh
npm run dev:cf -- renew-setup --lane local-a
```

If an unbound pilot hostname fails before Slack app creation, repair the named
tunnel/DNS first, then rotate the endpoint and setup capability without
replacing durable credentials:

```sh
npm run dev:cf -- relocate-unbound \
  --lane local-a \
  --public-url https://replacement.example.com
```

The command refuses a Slack-bound lane. Once an app exists, preserve the exact
endpoint/app contract or establish a new lane explicitly.

## Daily loop

Before sending a Slack action, inspect the lane:

```sh
npm run dev:cf -- status --lane local-a
```

The output must name:

- runtime `cloudflare-vite/workerd`;
- transport `slack-http-events`;
- public origin and tunnel;
- immutable Slack workspace/app pair;
- provider/model reference;
- persistent state path and owning worktree;
- live owning PID and source SHA.

Edit normally and wait for the Vite reload in the owning terminal. Retest the
same run-marked DM or channel journey. Do not run two worktrees against one
endpoint, state directory, sandbox, or app; the endpoint lock rejects a second
live owner.

For an Agent created from Slack, inspect its Admin **Model** tab before comparing
responses. During the pilot, a newly created Agent retained an explicit legacy
model instead of inheriting the workspace default. Select **Workspace default**
when parity is required and verify the effective model in Admin, the Slack
footer, and the owning terminal.

Personal connector accounts may be used only from the owning user's DM. A
shared-channel Agent needs an explicitly Team-owned connection. Count a
connector check only when the provider actually executes and the run-marked
source value is visibly read back; a policy refusal or existing connection is
not a pass.

Exercise scheduler dispatch locally with:

```sh
npm run dev:cf -- schedule --lane local-a
```

This invokes the local scheduled handler and records a simulated dispatch. It
is useful for schedule logic, but is never evidence of deployed due-time
delivery.

## Telemetry and timing

For local behavior, use the owning terminal, the Local Explorer at
`/cdn-cgi/local/explorer`, and the persistent state below the lane directory.
The Worker also exposes the Cloudflare Vite local observability query endpoint
below `/cdn-cgi/local/explorer/api`. Keep message content, credentials, and
private coordinates out of committed output.

The ignored lane `metrics.jsonl` records cold-start, Vite/workerd reload,
session, and simulated-schedule timings without message content. Startup keeps
both wall time and Vite's reported ready time; reload spans the emitted
change-detected and server-restarted lines.

Cloudflare dashboard logs, Wrangler tail, deployment/version traffic, and the
Cloudflare telemetry API describe deployed Workers only. Follow
[runtime observability](runtime-observability.md) when the target is Amber or
Cobalt. Missing local data in the dashboard is expected.

Measure edit-and-retest cycles with the same run-marked journey and record these
separately in private evidence:

| Phase | Start | Stop |
| --- | --- | --- |
| Startup | command invocation | Vite/workerd and tunnel ready |
| Build/reload | saved edit | reload-complete terminal line |
| Deployment | guarded deploy start | intended version serving (deployed only; zero locally) |
| Model | admitted Slack event | terminal Agent completion |
| Slack delivery | Agent completion | visible terminal Slack reply |
| Browser/OAuth | first navigation | visible callback/readback complete |

Compare medians over several equivalent cycles. Report excluded or unavailable
segments rather than assigning them zero. OAuth is a setup cost, not an ordinary
edit-loop cost. A local pass can demonstrate application behavior and speed; it
cannot demonstrate a deployed build, Cloudflare traffic allocation, shared
gateway routing, production credentials, deployed observability, or real cron
due-time delivery.

## Pilot evaluation (2026-09-04)

The Local A pilot used a dedicated Developer sandbox, customer-owned Slack app,
named HTTPS tunnel, isolated local state, normal HTTP Events/interactivity, and
the same `cloudflare/@cf/openai/gpt-oss-120b` reference as the deployed lanes.
It passed run-marked DM and channel isolation, Agent handle creation, full
instruction preview/approval/saved-value readback, a real Personal Google Sheets
read through Composio, persistence across two full restarts and code reloads,
and simulated scheduled dispatch. Static and dynamic Agent assets both returned
success after the local asset router was made explicit. A final regression round
ran the repository's full Cloudflare smoke, confirmed all 39 lane-state files
remained, restarted the same installation, and received an exact run-marked DM
reply with the retained model.

Measured on the pilot machine:

| Segment | Result |
| --- | --- |
| Cold start, three successful runs | 10.10-11.78 s; median 11.40 s |
| Vite/workerd ready portion | 9.28-9.68 s; median 9.35 s |
| Warm restart after the full Cloudflare smoke | 9.47 s total; Vite ready in 8.73 s |
| First boot after rebasing a changed dependency graph | 36.30 s total; Vite ready in 35.45 s |
| Production Cloudflare build | 2.25 s |
| Ordinary source hot reload, three edits | 50-176 ms; median 101 ms |
| Configuration/server restart, three edits | 4.70-4.89 s; median 4.82 s |
| Browser/Admin retest reload, three observations | 1.1-3.9 s; median 2.6 s |
| Representative DM model turn | 6.56 s |
| Post-smoke retained-state DM turn | 11.40 s |
| Representative connector Slack turn | 12.72 s total; 1.52 s provider execution |
| Simulated scheduler dispatch | 32 ms total; 9 ms schedule scan |

No deployed Worker was changed for the comparison, so the deployment segment
was unavailable rather than zero. The local lane reliably removes that segment
from each implementation loop; measured hot-edit preparation is about 0.10 s,
then model and Slack time still dominate. Prior deployed connector observations
were slower, but were not controlled enough to attribute the difference to the
runtime, so they are not used as the savings claim. OAuth/browser setup remains
a material one-time cost. The 35.45-second first boot after the dependency graph
changed is also a cold-cache cost; the following restart returned to 8.73 seconds.

The first evaluation uncovered a destructive test-harness collision: the
Cloudflare smoke cleaned the whole `.wrangler-state` directory, where the pilot
had initially kept its credentials and databases. The lane now stores durable
material under `.chickpea-local-worker`, while the smoke owns only
`.wrangler-state/cf-smoke`. Regression coverage and the post-smoke Slack proof
verify that separation.

The pilot also exposed limits: initial Agent model inheritance needed manual
correction; Slack warned that the app does not subscribe to
`agent_session_stopped`; Personal connector writes were blocked by Chickpea's
approval policy, so the representative connector proof is a real read; and a
simulated trigger is not due-time delivery. These do not invalidate the useful
edit loop, but they remain different from deployed acceptance.

Keep one local lane for now. Current inventory used both documented active
sandbox slots (one pre-existing sandbox plus Local A), and policy prohibited
deleting or repurposing the existing sandbox. A second lane was therefore not
provisioned or claimed isolated. Reconsider two lanes only when a slot is
available; then give the second lane its own sandbox, app, tunnel, state path,
port, provider project, endpoint claim, and worktree, and prove simultaneous
cross-DM/channel isolation before relying on it.

## When to use which lane

Start locally for implementation, repeated Slack interaction, Agent/instruction
iteration, connector development, stateful restart checks, and simulated
schedule logic. Diagnose directly on a deployed Worker when the failure may
depend on the shared gateway, deployed bindings or credentials, serving
version, traffic, Cloudflare-only telemetry, network policy, or real cron
delivery.

Finish with the requested regression or release inventory from the
[live verification skill](../../qa/live/operator/SKILL.md). Use one deployed
candidate lane by default; run both colors when requested or when isolation is
under test. Report local and deployed results separately.
