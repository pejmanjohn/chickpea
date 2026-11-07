# Find the first Agent

Use this guide when the person asks what to build with Chickpea, asks for an Agent without naming its job, or has just connected this client. Research before you propose. Nothing in this guide creates or changes anything.

## What a Chickpea Agent is

A Chickpea Agent is a teammate in the person's Slack workspace. People mention its handle in a direct message or a Channel, and it answers there. An Agent can connect to services (catalog services by sign-in, any other API or MCP server with a key), read repositories, keep memory, run work on a schedule, and use a browser. A new Agent starts in direct messages only. Adding it to a Channel is a later step.

## Step 1. Know the workspace

Call `inspect_workspace` once before you research. It names the workspace (`slackTeamName`), the person and their role, the Agents that already exist, and the catalog of services Chickpea can connect by sign-in. When `slackTeamName` is absent, say "this workspace" and do not guess a name. The lead proposal must belong to this workspace. Work the person does for another company or workspace can be an alternate that names that workspace, never the lead. If an existing Agent already does the job, say so instead of proposing it again.

## Step 2. Research on this machine

Read what you can already reach here, most recent first. Stop after about forty reads or once you hold two candidates with concrete evidence, whichever comes first.

- The sessions, memory, and notes you keep for this person.
- The person's own skills, scheduled automations, and saved prompts in this client. A repeated workflow usually lives there.
- The projects and repositories under their working directories: recent commits, READMEs, the systems they built.
- The tools you can see they use: your own connected servers, API clients and configuration names in their projects, command-line tools they call. Never open a secret store or a shell history file.

Nothing you read goes to Chickpea. The proposal names its sources (a project, a session, a tool) and never quotes their contents. After the person says yes, only the Agent's configuration is sent.

## Step 3. Pick candidates

- A system or data store the person built or runs, such as a CRM, an admin tool, a dataset, or an internal API. The Agent answers questions about it or acts in it from Slack.
- A workflow the person has repeated with you, such as a weekly report, a triage pass, or a release check. The Agent does it on demand or on a schedule.
- A tool the person uses every day that Chickpea can connect. The Agent works that tool from Slack. A tool with no catalog entry needs a custom connection and a key.

Rank candidates by how recent and how repeated they are. Prefer one with a concrete way in: an API, a key the person can issue, a repository, or a catalog service.

## Step 4. Propose

Present one lead proposal and up to two alternates, one line each. The lead proposal has four parts:

1. What the person already has and what it is for, naming the sources you saw.
2. The Slack front door: the message the person would send the Agent, and an example answer. Label the example as one, and never invent facts, numbers, or identifiers in it.
3. What you will do yourself: create the Agent, add the connection, and check it with one read through `test_connection` once the key is in place.
4. What the person has to do: approve a key link, sign in to a catalog service, issue a key, or say yes. Ask before you create a key or token in any live account, and ask for read-only scope.

Ask a question before proposing only when the answer changes what you would build. While you have a candidate with evidence, do not offer the curated starters.

## When history is thin

If you find no candidate with concrete evidence, ask at most three questions: what the person works on, which tools they use, and what they do repeatedly. Research again with the answers, then propose in the same form. Only if that also yields nothing, offer the curated starters the `new-agent` prompt lists; without that prompt, ask what the first Agent should do. Never invent a starter.

## After the yes

Follow `chickpea://guide/agent-authoring/v1`. Create the Agent with one `create_agent` operation through `apply_workspace_changes`, and set `firstAsk` to the front-door message from your proposal. Add the connections you said you would and get each key in place the way that guide says. The new Agent then sends the person a direct message in Slack that ends with that first ask. Hand over the receipt's `links.slack`, which opens that conversation, and `links.admin`.
