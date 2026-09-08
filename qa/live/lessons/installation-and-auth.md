# Installation and App Home verification lessons

LC-10 runs last. It needs a frozen baseline for the dedicated resettable QA app, explicit reset authority, the same app and team after reinstall, a healthy `WorkspaceInstallation`, the approved scope set, the authorized installer, and a changed active credential revision.

A fresh `app_home_opened` event must produce one Home view. An authorized selection creates an `AgentThreadRoute` with source `app_home`. A stale or unauthorized selection creates no route and republishes the directory with the generic unavailable notice.

The current Admin response does not expose the complete baseline, installer, scope, credential-revision, App Home publication, and route facts. Those blocked observers keep all three live variants from running. Wrong OAuth state, nonce, code, callback binding, signed-body replay, and secret handling remain in deterministic protocol tests and do not enter live evidence.
