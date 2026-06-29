# Claude Tag Research Brief

Created: 2026-06-26

Status: source-backed product research for a later Cloudflare Agents feasibility pass.

## Scope

This document explains what Claude Tag is, why it is valuable, how it works, and what the admin and Slack user surfaces expose. It is intentionally limited to the Anthropic/Claude Tag side of the investigation. It does not yet design the Cloudflare Agents alternative.

Primary inputs:

- Anthropic Claude Tag documentation, especially overview, how it works, setup, getting started, use cases, access scoping, customization, and connections.
- Local demo video: `CleanShot 2026-06-26 at 11.30.59.mp4`.
- Prior local memory from 2026-06-24, used only as a caution that the product's MCP/connection surface is changing quickly.

## Executive Summary

Claude Tag is Anthropic's organization-controlled agent layer for Slack and other external app surfaces. A user mentions `@Claude` in a Slack channel or thread, Claude starts a work session with the relevant Slack context, uses administrator-approved tools and data sources, and replies back in Slack with progress and results. Admins configure where Claude is available, what it can access, which repositories or external services it can use, and what instructions apply in each workspace or channel.

The core value proposition is not only "Claude in Slack." It is a managed enterprise agent deployment system:

- Slack-native invocation through mentions and threads.
- Central admin control over app connections, credentials, repositories, domains, plugins, skills, and instructions.
- Scope-specific configuration for all apps, Slack workspaces, and individual channels.
- Long-running work sessions that can be opened in Claude for richer inspection.
- A reusable access-bundle model so teams can define a capability package once and attach it to multiple scopes.
- Governance surfaces such as audit logs, spend controls, guest controls, and organization restriction.

The setup docs make the enterprise positioning explicit: Claude Tag is for Team and Enterprise organizations on Anthropic's first-party Claude service, not Pro/Free plans or third-party deployments, and it is not available to organizations with Zero Data Retention because it stores channel memory and session transcripts.

For a future Cloudflare Agents clone, the most important product contract is this: Claude Tag turns a Slack mention into a scoped, persistent, tool-capable agent session, where the effective tool/context policy is resolved from admin-managed access bundles plus workspace/channel overrides.

## What Claude Tag Is

Claude Tag lets an organization "tag Claude" from external apps, currently with Slack as the primary visible integration in the provided docs and video. In Slack, Claude behaves like an app/bot that can be invited into channels, mentioned in messages, and used inside threads. A mention creates or continues a Claude work session tied to that Slack context.

Anthropic positions the feature as a way to bring Claude into existing team workflows instead of forcing users to leave Slack, copy context into Claude, and manually paste results back. Claude can read the relevant conversation, inspect shared files, use configured integrations, and respond in the same thread where the work was requested.

Conceptually, Claude Tag is made of five layers:

1. **Invocation surface:** Slack mentions, DMs, and threads.
2. **Identity and membership layer:** Slack app install, Slack workspace connection, Claude account linking, organization restriction, and billing association.
3. **Scope policy layer:** all-app defaults, Slack workspace scopes, and channel scopes.
4. **Access/tool layer:** credentials, repositories, domains, plugins, skills, custom instructions, and custom MCP/server connections.
5. **Execution layer:** a Claude work session that can use the resolved capabilities, post progress, and reply with final results.

The product is in beta in the visible UI and docs. Exact controls may drift quickly.

## Value Proposition

### For End Users

Claude Tag removes the copy/paste loop. Users can ask Claude to summarize a thread, investigate a bug, search a repo, analyze shared files, draft a response, or answer a question from team context without leaving Slack.

It also gives users a low-friction way to delegate work. The interaction is Slack-native:

- Mention `@Claude`.
- Ask the question or assign the task.
- Continue the exchange in the thread.
- Open the underlying Claude session when more depth is needed.

The demo shows a representative engineering/repo task: the user asks Claude when an AI Tutor model changed from `gpt-5` to `gpt-5.5` in the `magoosh-rails` repo. Claude replies in the Slack thread, references a PR and commit, names the changed file, includes a small diff snippet, and provides an "Open session in Claude" link.

### For Admins

Claude Tag gives admins a governed deployment model. Admins can decide:

- Whether Claude Tag is enabled for the organization.
- Which Slack workspaces are connected.
- Whether users can DM Claude directly.
- Whether only Slack users with Claude accounts in the organization can use it.
- Which workspaces and channels inherit which access.
- Which repositories, apps, domains, plugins, skills, and instructions are available.
- Whether guests can use Claude.
- Whether channel members can edit channel instructions from Slack.
- Which model and environment/runner pool apply to a scope, where exposed by the UI.

This is the key difference from a generic Slack bot. Claude Tag is not just an app token plus a prompt. It is a Slack agent administration surface.

### For Organizations

The product creates a shared agent substrate for team work:

- It lowers the coordination cost of asking for help in a public work channel.
- It gives the organization a way to package internal context and tools as scoped capabilities.
- It lets teams reuse bundles across channels instead of creating one-off bots.
- It centralizes governance around credentials, repository access, spending, and logs.

The access-bundle model is especially important. It lets an org define "Exec," "Engineering," "Support," or similar bundles and attach those capability packages to the scopes where they make sense.

## The User Experience in Slack

### Joining and Connecting

The demo shows a user typing `@Claude connect` in the `exec_leadership` channel. Slack responds that it has invited `@Claude` to the channel. Claude is then added to the channel by the user.

Claude posts an onboarding message that explains:

- Claude is an AI assistant created by Anthropic.
- Users should mention `@Claude` to get started.
- When mentioned in a thread, Claude reads recent messages in that thread to understand context.
- Claude can access and analyze files shared in the conversation when mentioned.
- Claude only processes messages in threads where it is explicitly mentioned.
- Conversations are private and accessible through the user's connected Claude account.
- Claude says it does not retain or train on Slack conversations.

The video also shows two setup failure/remediation states:

- The Slack app installation can be out of date and missing permissions. Claude lists missing Slack scopes such as bookmark, canvas, channel, chat customization, emoji, MPIM, pins, reactions, user group, and user profile permissions, then asks for a Slack admin to reinstall or approve updated permissions.
- A workspace may need to be connected to the Claude organization for billing. Claude provides a one-time workspace code that expires in 15 minutes and tells the user to have a Claude organization admin redeem it in Claude admin settings.

### Asking Claude to Work

Once installed and connected, the user mentions Claude directly in a channel message or thread. In the demo, the user asks:

> when did the AI Tutor get updated? I know we updated the model from gpt-5 to gpt-5.5 but can't find the PR that did it. This is the magoosh-rails repo

Claude replies in the thread:

- First with a progress/status message saying it is digging through git history.
- Then with the result, including a PR reference, merge information, commit hash, changed file, and a short diff snippet.

Each Claude reply includes:

- A link to "Open session in Claude."
- A visible model/session label in the demo, such as `claude-opus-4-8[1m]`.
- A `Configure` link.

The thread UX matters because it preserves the original request, Claude's progress, and the answer in one Slack artifact. It also avoids flooding the channel with intermediate work unless the user chooses to also send a reply to the channel.

### Conversation Scope

From the docs and demo, Claude is designed to read the immediate Slack context needed for the request, not passively ingest all workspace messages. The user-facing disclosure says Claude reads recent thread messages when mentioned and only processes messages in threads where explicitly mentioned.

This gives the user-facing mental model: Claude is summoned into a conversation, not silently monitoring everything.

## How Claude Tag Works

### Session Lifecycle

At a high level, a Claude Tag request follows this flow:

1. A Slack user mentions `@Claude` in a permitted workspace/channel or DM.
2. Claude Tag verifies the Slack workspace, user/account linkage, organization policy, and channel scope.
3. Claude Tag resolves the effective configuration for that scope.
4. Claude starts a work session with the relevant Slack context and allowed tools.
5. Claude posts progress and final results back to Slack.
6. The user can continue in Slack or open the session in Claude.

The docs describe Claude Tag as running work in a Claude session. The video confirms that Slack replies link back to an underlying Claude session. This session continuity is a major part of the product: Slack is the front door, but Claude remains the deeper work surface.

Connections, plugins, and skill updates apply to new threads. Existing threads keep the access and tool versions they started with, so administrators test updated access by starting a fresh thread.

### Context Collection

Claude's Slack context comes from:

- The message where it is mentioned.
- Recent messages in the same thread.
- Files shared in the conversation when Claude is mentioned.
- Access-bundle resources such as repositories, credentials, domains, plugins, skills, and instructions.
- Scope-level custom instructions.
- Memory and routines where enabled.

Claude does not appear to consume arbitrary Slack history by default. The user-facing onboarding copy emphasizes explicit mention and thread context.

### Tool and Resource Use

Claude Tag can use multiple categories of resources:

- **Repositories:** GitHub organization repositories attached through an access bundle.
- **Credentials:** API credentials for curated services or custom HTTP/API apps.
- **Domains:** Allowed domains and ports for access without credentials.
- **Plugins:** Tool packages from a plugin directory/catalog, including custom MCP-related plugins in the docs.
- **Skills:** Claude skills exposed through the Claude libraries/admin surface.
- **Instructions:** System prompt additions at bundle, workspace, or channel scope.

The effective tool set is not globally uniform. It is resolved by scope. A channel can have a different set of bundles, plugins, instructions, model defaults, guest behavior, and member-edit behavior than a workspace default.

### Custom Connections and MCP

The current docs describe two related but distinct mechanisms:

1. **Custom HTTP/API credentials:** Admins can define a custom app credential by giving Claude a credential type, allowed websites, and custom headers. The demo's "Connect an app" form shows this exact model.
2. **Custom MCP server access:** The docs now describe a path where admins set up a custom plugin for an MCP server and connect credentials for that MCP server's host, then attach both the plugin and the app credential to the same access bundle.

This is a meaningful update compared with prior local memory from 2026-06-24, where the visible UI seemed to expose only static app/domain/header configuration and not typed MCP registration. As of the current docs, the product appears to support an MCP path through the plugin/credential combination. The demo video still mostly shows the HTTP credential UI, so exact custom MCP UX should be re-verified before designing parity.

### Sandboxing and Network Access

Anthropic's docs describe Claude Tag as using a sandboxed environment for work sessions. Network and credential access are governed by admin configuration. The docs also describe an Agent Proxy model for outbound access and credential injection.

The product design implication is that Claude should not receive raw, ambient network or credential access. Instead:

- Admins grant domains or app credentials.
- Claude can reach only allowed hosts and paths.
- Credentials are attached only for configured destinations.
- Plugins and custom MCP tools require explicit attachment to a scope/bundle.

For a clone, this implies a policy enforcement layer outside the model prompt. It should not rely only on natural language instructions.

## Admin Model

### Organization Enablement

The video shows an organization settings page with a `Claude Tag` product section. The top-level toggle is "Enable Claude Tag for your organization." The page says this allows the organization to tag Claude and hand off tasks in external apps.

The setup docs require:

- A Claude Team or Enterprise organization with Claude Tag enabled.
- No Zero Data Retention configuration.
- Claude organization Owner access for pairing workspaces and creating access bundles. Admins can view settings and can add credentials to an existing bundle, but Owner is required for setup writes.
- Slack administrator permissions for Slack setup.
- Usage credits for Team plans, because channel work draws from the organization's usage balance.

Slack is the only connected app visible in the demo's "Where Claude Tag works" section, with "1 workspace connected."

### Connected Apps and Workspaces

The main admin page has a "Where Claude Tag works" section:

- Application: Slack.
- Details: 1 workspace connected.
- Actions: connect, manage, add workspace, disconnect.

The Slack management modal in the demo is titled "Claude Tag in Slack" and exposes:

- `Allow direct messages`: whether members can message Claude Tag directly, not only in shared channels.
- `Restrict to your organization`: whether only Slack users with a Claude account in the org can use Claude. When off, anyone in the Slack workspace can use it.
- Connected workspaces: workspace name, workspace ID, active status, connection date, and disconnect action.

This modal is the Slack app/workspace integration control plane. It is distinct from the channel/access-bundle policy editor.

### Access Scopes

The demo shows two top-level access tabs:

- `All apps`
- `Slack`

The `All apps` view defines access inherited everywhere members tag Claude. It also displays a note that the access also applies to Claude Code cloud sessions.

The `Slack` view shows a scope tree:

- Slack root.
- Workspace, shown as `Magoosh`.
- Channel, shown as `exec_leadership`.

Each scope can have inherited or local configuration. The workspace scope says its access is inherited in all channels where members of the org tag Claude. The selected workspace has `Exec` attached as an access bundle, and the effective access summary resolves to `magoosh/magoosh-rails`.

The UI also supports adding a channel manually. The "Add channel" modal asks for:

- Slack channel ID.
- Optional display name.
- Optional description for admins.
- System prompt addendum appended to Claude's prompt for Slack conversations in that scope.

The modal instructs admins to right-click the Slack channel, copy the Slack link, and use the ID after the last slash.

### Access Bundles

Access bundles are reusable capability packages. The demo shows an `Exec` bundle with tabs:

- Credentials.
- Repositories.
- Domains.
- Plugins.
- Instructions.

The `Exec` bundle is marked as used in two places, which confirms bundles are reusable across scopes.

#### Credentials

The credentials tab says it gives Claude credentials to access apps the organization uses. It shows available apps such as Asana, Datadog, Datadog (US5), and GitLab, with connect buttons.

The "Connect an app" modal supports custom credentials:

- Add to: selected bundle, such as `Exec`.
- Name: for example, "Internal billing API."
- Credential type: the demo shows `Bearer`.
- Allowed websites: for example, `api.example.com`.
- Wildcards for subdomains using a leftmost `*`.
- Custom headers: name, prefix, and value. The demo shows `Authorization`, `Bearer`, and a masked secret.
- Add header.
- See resolved curl example.

The docs recommend dedicated agent identities for credentials. The credential is Claude's account in that tool, not the requesting user's account. Where a service supports service accounts, the dedicated service account should be scoped narrowly; where it does not, Anthropic suggests a dedicated user seat or equivalent agent account. Personal claude.ai connectors do not appear in this org-managed connection gallery, though they can still apply in DMs.

This is a powerful product surface. It turns admin-entered API credentials into a model-usable integration while scoping where the credential can be sent.

#### Repositories

The repositories tab gives Claude access to organization repositories. The demo shows:

- A search box.
- A warning that personal GitHub account installations are not shown and the app must be installed on an organization.
- An organization named `magoosh`.
- A selected repo `magoosh-rails`.
- A manage menu with searchable repository selection and apply action.

The Slack task in the demo then uses this repo access to answer a PR/history question.

#### Domains

The domains tab gives Claude access to specific domains and ports without credentials. The UI accepts:

- Domain, for example `api.example.com`.
- Ports, defaulting to `443`.
- Wildcards at the leftmost label, for example `*.example.com`.

This is an egress allowlist surface.

#### Plugins

The plugins tab lets Claude use specific plugins. The demo shows:

- A search box.
- Selected and available sections.
- Toggle controls for individual plugins.
- Visible examples including Adobe for Creativity, Adspirer, AI-Firstify, and Airtable.
- Category labels such as `knowledge-work-plugins`.

The current docs describe plugins as the route for custom MCP server tool exposure. For parity work, "plugin" should be treated as a tool-definition/runtime surface, while "credential" should be treated as secret/egress authorization.

#### Instructions

The instructions tab lets admins include specific instructions in Claude's system prompt when the bundle is used. Workspace and channel scopes also expose custom instructions. The channel-add modal calls this a "system prompt addendum."

Instructions are therefore layered:

- Bundle-level instructions.
- Workspace-level custom instructions.
- Channel-level prompt addendum.
- Potential channel-member edits, if allowed by admin settings.

### Scope-Level Advanced Settings

The demo's advanced workspace settings expose:

- Name: displayed as `Magoosh`.
- Default model: visible as inherited from `Opus 4.8`, with an `Inherit` dropdown.
- Environment: the environment or runner pool Claude uses for sessions started there, with `Organization default` selected.
- Allow Claude to respond to guests: visible as inherited allow.
- Guest access warning: Slack guests can use Claude Tag, read public channels and public channel memory, and may see content from channels they were not explicitly added to.
- Channel member edits: whether channel members can set channel instructions from a Configure link in Claude's replies.
- Slack workspace ID.

The docs also state that some settings are not user-changeable in channel sessions, including the model family switch that regular Claude chat exposes. The visible UI has default/inheritance controls. Treat exact model configurability as a beta surface to re-verify.

## Effective Access and Inheritance

Claude Tag's access model is hierarchical:

- Organization/all-app defaults can apply broadly.
- Slack workspace scopes inherit from broad defaults.
- Channel scopes can inherit and add channel-specific configuration.
- Access bundles can be attached to scopes and reused.
- Access summaries show the resolved result.

The video explicitly shows "Resolved access from all inherited access bundles and config." That means the admin product is trying to make inherited policy inspectable, not hidden.

For a clone, this suggests three hard product requirements:

1. Policy must be inspectable at the scope where a user invokes the agent.
2. Policy must be reusable, because one bundle can be used in multiple places.
3. Policy must be enforced at runtime, not only displayed in the admin UI.

## Governance, Safety, and Privacy

Claude Tag includes several governance levers:

- Organization-level enable/disable.
- Slack workspace connection management.
- Direct-message enablement.
- Restrict-to-organization toggle.
- Access-bundle scoping.
- Repository selection.
- Domain and credential allowlists.
- Plugin and skill attachment.
- Audit logs in the organization settings navigation.
- Spend limits in the admin setup docs.
- Guest-access controls and warnings.
- Channel-member instruction edit controls.

Spend is scoped differently across surfaces. The setup docs say channel work uses the organization's usage balance and can be capped by a Claude-in-Slack spending limit. DMs run on the user's own Claude account and are not capped by that channel-work limit.

Privacy and data handling need careful treatment. The Slack onboarding message says Claude only processes explicitly mentioned threads and does not retain or train on Slack conversations. The docs also note important enterprise constraints, including that Claude Tag is not available for organizations with Zero Data Retention enabled. For planning parity, do not collapse these into a single "no retention" claim. The safer reading is:

- Claude Tag does not passively monitor every Slack message.
- Claude Tag uses Slack context when explicitly mentioned.
- Claude Tag needs some session and memory state to function.
- Enterprise retention and training guarantees depend on the organization's Anthropic plan and settings.
- ZDR support is a specific limitation to re-check before enterprise claims.

Guest access is a visible risk surface. The demo warning says inherited guest access allows Slack guests to use Claude Tag, read public channels and public channel memory, and potentially see content from channels they were not explicitly added to. Any clone needs an explicit guest and Slack Connect posture before launch.

## Memory, Routines, and Proactivity

The docs describe more than reactive mentions. Claude Tag also supports proactivity and memory concepts:

- Routines can run on schedules or in response to configured triggers.
- Claude can perform recurring checks or produce regular summaries.
- Workspace/channel memory can shape future work.
- Channel instructions can be edited from Slack when admins allow it.

This widens the product from "Slack bot that answers mentions" to "Slack-native agent worker." For Cloudflare Agents planning, routines imply a scheduler, background workers, durable state, and safe posting rules.

## Demo Video Observations

The local video adds practical UI details that are not obvious from docs alone.

### Admin UI

- Claude Tag is under Organization settings, marked beta.
- The sidebar includes Claude Code, Claude in Chrome, Claude Tag, Access bundles, Audit logs, Cowork, Office Agents, Plugins, Connectors, Skills, and Directory.
- Slack is the connected application in "Where Claude Tag works."
- The Slack connection menu includes Manage and Add workspace.
- The Slack management modal includes direct messages, organization restriction, connected workspaces, connection date, and disconnect.
- Access can be configured under `All apps` and `Slack`.
- The Slack scope tree includes root Slack, workspace, and channel.
- The `Exec` access bundle is attached at the Magoosh workspace scope in the video and resolves to the `magoosh/magoosh-rails` repository.
- The `Exec` bundle tabs are credentials, repositories, domains, plugins, and instructions.
- Custom app credentials support allowed websites and custom headers.
- Domains support domain plus port.
- Plugins are selectable from a catalog with toggles.
- Instructions can be added directly to a bundle.
- Channel creation is manual by Slack channel ID.
- Advanced settings expose default model, environment, guest response, member edits, and Slack workspace ID.

### Slack UI

- Users invoke setup with `@Claude connect`.
- Slack invites Claude into the channel.
- Claude posts a channel onboarding/disclosure message.
- Claude detects missing Slack app permissions and tells admins to reinstall or approve updated permissions.
- Claude can generate a one-time workspace connection code for organization billing connection.
- Claude responds in a thread to task requests.
- Claude posts progress before the final result.
- Claude can cite PRs, commits, files, and inline code snippets in Slack.
- Replies include "Open session in Claude" and "Configure" links.
- The Slack reply footer exposes the model/session label.

## Capability Inventory for a Cloudflare Agents Clone

This is not the Cloudflare design yet. It is the capability checklist implied by Claude Tag.

### Required for Core Parity

- Slack app installation and permission management.
- Slack event ingestion for mentions, DMs, and thread replies.
- Workspace/account linking with organization billing or entitlement mapping.
- A per-workspace and per-channel scope model.
- Admin-defined access bundles.
- Repository connectors or code search integrations.
- Custom API credential storage and controlled injection.
- Domain and port egress allowlists.
- Plugin/tool registry.
- Scope-level custom instructions.
- A durable agent session per Slack task/thread.
- Slack progress messages and final replies.
- "Open session" link to a richer web UI.
- Runtime audit logs.
- Spend accounting and limits.

### Required for Stronger Enterprise Parity

- Guest and Slack Connect policy.
- Direct-message policy.
- Organization-only user restriction.
- Member-editable channel instructions with admin override.
- Routines and scheduled proactive work.
- Memory controls and visibility.
- Sandbox or runner-pool selection.
- Effective-access summary for admins.
- Credential proxy enforcement outside the model prompt.
- Per-scope model/default policy.

### Likely Differentiation Opportunities

- Model choice beyond Claude, if built on Cloudflare Agents and Workers AI or provider-agnostic routing.
- First-class skill packaging, since Skillet already treats skills as product artifacts.
- More transparent per-task runtime/cost evidence.
- Better local/private deployment posture for organizations that cannot use Anthropic's hosted product.
- Stronger custom tool registration if Cloudflare Agents can expose typed tools more directly than Claude Tag's current plugin/credential split.

## Product Tensions to Re-Verify

These are not blockers for this research doc, but they matter before implementation planning.

1. **Custom MCP support:** Prior local memory from 2026-06-24 found no visible MCP setup path in the UI, while current docs now describe custom MCP server access through a plugin plus connected app credentials. Re-verify the exact live admin UX.
2. **Model configurability:** The docs say channel sessions do not expose the usual Sonnet/Haiku switch, while the video shows a default model inheritance dropdown. Re-verify what admins can actually set by plan and scope.
3. **Environment/runner pools:** The video shows an environment selector. The docs need a closer pass before assuming what runner pools are and whether third-party runtimes are possible.
4. **Guest behavior:** The demo warning is broad enough that guest access should default to off in any clone until carefully designed.
5. **Memory semantics:** The product mixes private user sessions, channel/workspace memory, and Slack-visible configuration. A clone needs a clearer memory model before shipping.
6. **Permission drift:** The demo showed an outdated Slack app installation missing many scopes. A clone needs explicit permission versioning and upgrade recovery.

## Sources

Official Anthropic docs:

- [Claude Tag overview](https://claude.com/docs/claude-tag/overview)
- [How Claude Tag works](https://claude.com/docs/claude-tag/concepts/how-it-works)
- [Claude Tag setup overview](https://claude.com/docs/claude-tag/admins/setup-overview)
- [Add connections](https://claude.com/docs/claude-tag/admins/add-connections)
- [Custom connection guide](https://claude.com/docs/claude-tag/admins/connections/custom)
- [Attach connections to scope](https://claude.com/docs/claude-tag/admins/attach-to-scope)
- [Customize Claude Tag](https://claude.com/docs/claude-tag/admins/customize)
- [Getting started with Claude Tag](https://claude.com/docs/claude-tag/users/getting-started)
- [Claude Tag use cases](https://claude.com/docs/claude-tag/users/use-cases)
- [Agent identity](https://claude.com/docs/claude-tag/concepts/agent-identity)
- [Memory](https://claude.com/docs/claude-tag/users/memory)

Local source:

- `/Users/pejman/Library/Application Support/CleanShot/media/media_1hLCUwGTo7/CleanShot 2026-06-26 at 11.30.59.mp4`
