# Repositories and coding workspaces

Docs: `/agents/repositories/`, `/agents/coding-sandbox/`, `/reference/limits/`. Record areas: `sandbox` (add `usage` for worker usage rows, `providers` for the coding model). Legacy contracts: none.

## What it covers

- Repository grants through the Chickpea GitHub App, created in Admin or supplied as `GITHUB_APP_ID` plus `GITHUB_APP_PRIVATE_KEY`. There is no personal access token path.
- Each turn gets a short-lived installation token that GitHub scopes to the granted repositories, injected at egress. DELETE, workflow dispatch and deployment approvals are refused.
- Without the sandbox, a granted Agent reads code, pull requests, issues and Actions runs over the REST API, on core and Node alike.
- The coding sandbox (Cloudflare, Workers Paid) moves through Not installed, Redeploy required, Installed but off and On in Settings → Coding sandbox.
- Workspace tools (`workspace_open`, `workspace_list`, `workspace_close`, `workspace_exec`, `workspace_read`, `workspace_write`, `workspace_list_files`). Named workspaces default to `main`; at most 2 are open per Agent per thread.
- `workspace_task` delegates to a coding worker: one running task per workspace, two per response, 60 minutes each.
- Commits are authored as the App's `<slug>[bot]` account, or `Chickpea <chickpea@noreply.invalid>` while the bot lookup fails.
- While a task runs, the thread's working indicator shows the stage and rotates fixed phrases: the step of 3, what is done, what comes next. There is no checklist card.
- Stop (the button or a typed stop) stops the worker and posts one note listing branches pushed and pull requests opened. An unconfirmed worker stop adds "Coding work may still be winding down."
- A follow-up in the same thread reuses the checkout. The container sleeps 30 minutes after the last turn, and its checkpoint (without dependency folders) restores for 3 days. Each turn's checkpoint deletes the one it replaced, so R2 holds one `backups/<id>/` pair per thread workspace; a discard (`workspace_close` with `discard: true`) deletes the pair at once.
- A grant change or a different Agent in the thread retires the workspace. A scheduled run always starts a fresh one.
- The monthly session cap (Advanced, counts workspace starts) refuses with "The coding workspace monthly session limit has been reached."
- On a deployment serving many installations the host's policy decides instead (`configureHostedSandboxPolicy`): Settings → Coding sandbox cannot be changed (`PUT`/`PATCH` status are not found), and the host also caps running containers, monthly container-hours and GitHub writes. The write budget is shared by container egress and the Agent's Worker-side bash, which both answer 429 with `Retry-After` past it, and both stop writing while GitHub's secondary limit holds the installation. Hosted cap refusals keep only the first sentence.
- Hosted checkpoints live under `i1/<installation>/backups/` in one shared bucket; each installation's sweep, erasure and census read only its prefix. Operator jobs stop, erase and count coding workspaces through Core's host functions (`state/installation-objects.ts`); exports leave out workspace files, checkpoints and Sandbox records and carry the note "Unpushed work in a coding workspace is not exported."

## How a person reaches it

- Admin: Settings → GitHub, Settings → Coding sandbox, Settings → Model providers → Default coding model, and the Agent's Repositories tab. All need Owner or Admin.
- Slack: ask a granted Agent for repository work in a new thread. Asking `@Chickpea` for repository access returns a setup link, never a grant in the channel.
- MCP: `inspect_workspace` lists repositories, and a repository patch is confirmation-gated. GitHub App setup and the sandbox have no MCP handoff.

## How to drive it on a lane

- Choose with `npm run verify:live:kickoff` or `npm run env -- capabilities all`: the profile must read `sandbox`. GitHub App grants and runtime state are read in Admin.
- Deploy a sandbox lane with `npm run deploy:sandbox` through `verify:host`; a core deploy over it is refused.
- The standing runtime is Installed but off. Register it with `record resource --ownership restore --expected-file <exact before-state>` plus the case, provider, kind, ID and evidence flags, enable it with the readiness checkbox, and restore Off at cleanup.
- Create a run-owned Agent granted the lane's test repository, publish it to the QA channel, and register it with `--kind agent --ownership owned --cleanup-preset archived-agent`.
- Case shape: `case-add --area sandbox --proof slack --proof provider --proof admin --max-wait-ms 2700000` for a delegated task, and the 3600000 maximum for an idle-window case such as checkpoint restore after 30 idle minutes.
- Request in a new thread: "<run marker> clone the repo, change one line of the README, run the tests, push a branch and open a draft pull request."
- Variants: an ungranted repository is refused; a third open workspace fails with the open limit; a follow-up reuses the checkout; Stop mid-task; an Agent edit mid-thread keeps the open workspaces in `workspace_list`.
- Cleanup: archive the Agents, restore the runtime and any cap or coding model by value, and close the run's pull requests and branches, or register them as `retain` with their exact state.

## Proof and gotchas

- Slack shows the reply and the pull request link. GitHub (`provider`) shows the author login `<slug>[bot]`. An App without an uploaded logo shows its owner's avatar, so check the login, not the picture.
- Start every sandbox case in a new thread: the sandbox choice is made when a conversation begins. A granted Agent on a core lane has no workspace tools, which is correct.
- With the sandbox off, a granted Agent's bash `curl` reaches only its repositories on GitHub. Without a `User-Agent` header GitHub itself answers 403 "Request forbidden by administrative rules"; send `-H "User-Agent: …"` before reading that as an egress block. Other hosts fail with `URL not in allow-list`.
- The lane test repository is large. A one-file fix with install and tests took about 20 minutes, so keep tasks small and never plan 40-minute ones.
- Never redeploy during an idle window: any Durable Object reset restarts the 30-minute idle clock. The docs coding sandbox page still lists a 5-minute idle sleep; the runbook and product use 30.
- Read the working indicator from a fresh load of the Slack web client in the lane browser.
- `wrangler containers instances <application id> --json` lists each container by its Sandbox name. On a standalone lane that is the bare thread key (`T…:C…:<thread ts>`); an inactive lowercase twin is the normalized-ID bridge probing, not a second container. A hosted name reads `i1~<installation>~w<21 characters>`.
- `wrangler tail` drops some Sandbox events (one of three `endTurn` RPCs and the restore RPC in one run). Read checkpoints from R2 instead: the REST objects listing for the backup bucket (token from `wrangler auth token`, never printed) gives keys and upload times, and `wrangler r2 object get <bucket>/<key> --remote` checks one key; a deleted key prints "The specified key does not exist."
- R2 stamps an object's upload time itself, so an expired checkpoint cannot be seeded. Prove the hourly sweep on objects the lane already holds that pass 72 hours during the run: list before and after the next minute-17 sweep.
- A Sandbox that was instantiated but never started (a cold start the session cap refused, or the normalized-ID twin a reader woke) lists as `stopped` with a location for a few minutes, then `inactive`. Neither means a container ran.
- `npm run lane:slack -- <alias> thread … --out FILE` refuses to overwrite an existing file, so a polling readback writes a fresh path each time and moves it into place.
- Models refuse fault injection such as killing every process, even framed as QA. Exercise failure paths through limits (the session cap, the open-workspace limit) instead.
- A clone or install failing with DNS or connection errors while replies work points at mediated egress; see the [runbook](../../../docs/runbooks/coding-sandbox-deployment.md). GitHub rate limits on clone are upstream.
- A failed sandbox deploy prints `PARTIAL SANDBOX DEPLOY` or `SANDBOX DEPLOY STOPPED BEFORE THE WORKER UPLOAD`. When it leaves the lane locked, run `npm run env -- reconciliation <alias>`.
- Never Disconnect the lane's GitHub App. Creating an App needs a GitHub passkey, which only a person can supply.
