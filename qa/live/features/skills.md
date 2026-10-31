# Skills

Docs: `/agents/skills/`. Record areas: `skills`. Legacy contracts: LC-06.

## What it covers

- A skill is a name, description, instructions and enabled flag on one Agent. Only enabled skills load, and a malformed one is skipped without ending the turn.
- Sources: 20 suggested skills toggled in Admin, skills written in Admin, imports from `owner/repo`, `owner/repo@skill`, a GitHub tree URL or a `skills.sh` link, and Admin uploads of `SKILL.md` files, other markdown whose header has a name and description, and `.zip` or `.skill` archives.
- A Slack upload installs SKILL.md, `.zip` and `.skill` files attached to the person's own message to the Agent, at most 10 per message. A same-name skill is replaced only when that message asks to replace it, otherwise it is left unchanged and the receipt says to send the files again asking to replace them. The receipt lists what changed and offers undo, and files Slack cannot give are listed as left out.
- A Slack import needs the exact source in the current message. One scriptless skill installs at once with a receipt saying it is active from the next message, with undo; several candidates are listed, and you post the chosen source URL in a new message.
- A mutable branch is pinned to the inspected commit before anything is written. The commit, path and source URL are not stored, and there is no update check.
- Same name with different content is never overwritten silently: only a new message `replace <name> from <source URL>` replaces it. Identical content reports already installed.
- Scripts never come across. Slack and MCP refuse a skill directory with executable files; Admin copies only the `SKILL.md` text and labels the candidate.
- Private repositories import only in Admin through the GitHub App; Slack refuses them and points to Admin.
- Enabling, disabling or removing one named skill applies at once with a receipt and undo, keeps every other skill, and is open only to editors of that Agent.
- Skills stop at their Agent: one Agent cannot install, disable or remove another Agent's skill.
- Connector skills: an Agent with an Asana, Zendesk or legacy Google Workspace API connection, or a repository grant, carries a matching built-in skill. An Agent skill with the same name, even a disabled one, takes its place.
- A repository scan reads at most 40 skill directories and says when it was capped.

## How a person reaches it

- Slack: hand the Agent the link, attach skill files and ask it to add them, or ask it to enable, disable or remove a named skill.
- Admin: Agents → the Agent → Skills (suggestions, New skill, Import from URL then Find skills, or Upload or a drop on Build your own; then Add N skills).
- MCP: `import_skill` installs immediately, `upload_skills` installs from markdown text or a base64 archive, and `manage_agent_skill` enables, disables or removes.
- CLI: `chickpea-cli skills upload <origin> <agentId> <file...>` sends files from disk to `upload_skills`.

## How to drive it on a lane

- Use a disposable Agent attached to the QA channel and a public, scriptless test skill at a pinned commit, given as a direct skill-directory URL.
- Install from a fresh thread. In a new message, ask something whose answer depends on the skill and include the run marker.
- Remove the exact skill by name and confirm in a fresh thread that the behaviour has ended.
- Cross-Agent denial: from Agent A, ask to disable or remove a skill on Agent B, then read Agent B's Skills tab.
- Slack upload: attach synthetic files to one message addressed only to the Agent (a large SKILL.md, two SKILL.md files, or a zip of skill folders with `__MACOSX` entries) and ask it to add them. Read the receipt, the Skills tab, then reply `undo` and read the tab again. On a gateway lane this needs a shared gateway that accepts `accept`.
- Case shape: `case-add --area skills --proof slack --proof admin` (or `--proof mcp`) and `--max-wait-ms 120000`.
- Cleanup: remove run-owned skills and archive the disposable Agent (registered with `--kind agent --ownership owned --cleanup-preset archived-agent`). On the fixtures Agent, restore the exact skill list with `--ownership restore`.

## Proof and gotchas

- A receipt is not proof. Read the Admin Skills tab and run a behavioural turn after activation, then repeat both after removal.
- The skill is active from the next message, so a behaviour check inside the install message proves nothing.
- An exact install or remove command must apply without asking for approval.
- Nothing on the Agent records the source commit, so durable provenance cannot be read back. Keep the import receipt as private evidence and report provenance as a gap (LC-06).
- Mutable refs, packaged scripts, several candidates, silent same-name replacement and cross-Agent changes all fail the case.
- Cross-Agent denial must not reveal Agent B's skills or swap in a same-named skill on Agent A.
- "Install" or "remove" inside ordinary prose must change nothing; only an exact single-target command does.
- Slack labels a `.skill` upload `binary`, `application/octet-stream`, and a `.markdown` upload a `text/plain` snippet served as `application/force-download`; the readers decide archives by name and zip signature.
- The activity status reads "Using a skill…" then "Reviewing skill results…", never names the skill, and must clear when the reply lands.
- A large repository hits the 40-directory cap. Narrow it with `owner/repo@skill` or a directory URL.
- To switch off a connector skill, save a disabled Agent skill with the same name. Removing that row brings the built-in skill back.
- A private import in Admin first asks GitHub anonymously from the Worker. On a deployed standalone lane GitHub's anonymous rate limit can answer that probe with `github_rate_limited`, for private and missing repositories alike, and the GitHub App path is then never tried. Grade it blocked (upstream) and retry after the limit resets. Hosted asks the installation's own GitHub binding instead: a repository it grants imports, and any other still answers `github_rate_limited`.
