# Installation and App Home verification lessons

LC-10 runs last. It needs a frozen baseline for the dedicated resettable QA app, explicit reset authority, the same app and team after reinstall, a healthy `WorkspaceInstallation`, the approved scope set, the authorized installer, and a changed active credential revision.

A fresh `app_home_opened` event must produce one Home view. An authorized selection creates an `AgentThreadRoute` with source `app_home`. A stale or unauthorized selection creates no route and republishes the directory with the generic unavailable notice.

The current Admin response does not expose the complete baseline, installer, scope, credential-revision, App Home publication, and route facts. Those blocked observers keep all three live variants from running. Wrong OAuth state, nonce, code, callback binding, signed-body replay, and secret handling remain in deterministic protocol tests and do not enter live evidence.

## Shared-app cold installation and recovery

Use the Chickpea live-verification skill and a registered disposable shared-app
target. Record the exact candidate, owning worktree, account, Worker, workspace,
provider/model and cleanup scope privately. LC-10 resets a customer-owned app;
it does not prove this shared-app journey.

1. Follow only the candidate's `INSTALL_CHICKPEA_CLOUDFLARE.md`. Start with a
   signed-out Slack browser and preserve the original capability-bearing setup
   tab. Complete login while deliberately losing the OAuth return page.
2. Use **Check Slack installation**, then **Open Slack authorization again**.
   Confirm the saved claim is reused, Slack connects the intended workspace,
   and the intended Owner can sign in. Keep URLs and claim readback private.
3. With a controllable disposable claim fixture, test confirmed expiry,
   installation bound before expiry but refreshed afterward, a pending approval,
   and a stale tab racing a newer claim. A bound installation survives; stale
   responses must not clear the current claim or change its workspace. A
   transient status error offers retry without starting another installation.
4. Verify neutral provider copy, no preselection, disabled Continue, and the
   user's chosen model. Observe a substantive human-sent DM reply from this
   app/workspace and signed-in Admin. An already observed valid DM counts;
   still record release/commit and the absolute local project path.
5. For the Cloudflare prerequisite case, use a genuinely unregistered designated
   account. The wrapper must stop before build/D1, then succeed after the user's
   explicit account-wide subdomain choice and the identical rerun. Never delete
   or rename an existing subdomain to manufacture this fixture.

Record each missing fixture as unrun. Local protocol tests and simulated UI
checks do not establish shared-gateway or real Slack acceptance. Keep upgrade
and recovery acceptance separate: it needs a supported release pair, and
v0.1.16 has no incoming `supportedOrigins`. Do not change that declaration or
publish a release to create test eligibility.
