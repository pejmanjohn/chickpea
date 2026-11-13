# Test drive an Agent

Practice the Agent on the person's test questions, judge each answer, and fix one thing at a time until the answers do what the person expects. A practice run asks the Agent a question as a direct message would, with every tool that only reads. It posts nothing in Slack, changes nothing in any service, and the Agent remembers nothing from it.

<!-- include: rules -->

## 1. Get ready

1. **Find the Agent.** Call `list_agents` and match the Agent the person means. Only people who can change an Agent can practice with it: if its `canEdit` there is false, say who can change it (its creator or an Owner or Admin) and stop. Call `get_agent` and keep its `version`.
2. **Get the test questions.** Use the ones in this conversation, or the file the person keeps them in. One question from the person, with what they expected, is enough to start. If there are none, scope the Agent first (`get_guide` topic `scope`). Each test question needs what a good answer does. Without that, you can't judge it.
3. **Ask once before you start.** Say how many test questions you'll practice, that each practice run uses the workspace's usage the way a Slack message does, and that you'll change the Agent as you go, one small change between rounds, and say each one. Start after the person says yes: their yes covers those changes.
4. **Check the Agent.** Call `check_agent` with the `agentId`. Fix what fails before you practice: a broken connection fails every test that needs it. Say each problem and its fix in a line. For a sign-in, call `reconnect_service` with the fix's arguments: the person signs in from its card or link. Ask before any other fix, and give the person any link a fix names. When nothing fails, say so in a few words or not at all, and go on to practice.

## 2. Practice a test question

Practice one question at a time.

1. Call `practice_agent` with `agentId` and the test `question`, word for word. Usually it comes back `running` with a `runToken`.
2. Call `get_practice_run` with that `runToken` until its `status` is `answered` or `failed`. Don't call `practice_agent` again while a run is going. A run ends within about three minutes: if it is still `running` after ten calls, stop and tell the person.
3. If Chickpea refuses the run because the Agent is turned off, offer to turn it back on (`update_agent` with `on: true`), and do it only after the person says yes. If Chickpea refuses the run for another reason, or it ends `failed`, follow its `nextStep`. If it needs a sign-in, a key or the person's choice, stop and ask them. If the same question fails twice, stop that test and pass on what Chickpea said. If a connection has no tools marked as reads, ask the person which ones only read (`get_guide` topic `connect`).

## 3. Judge the answer

Read the whole result before you decide.

1. **Did this run see your last change?** `ran.agentVersion` is the Agent's `version` when it ran. Compare it with the latest `version` you have from `get_agent`. If they differ, practice once more. If they still differ, someone else is changing the Agent: stop and tell the person.
2. **Could it pass here?** `off` lists what a Slack message could use and this practice run could not. `partial` means a whole connection was left out. If the test needs that connection and the result has `fixes`, they say how to let it in: ask the person, make the fix, and practice again. If the test needs anything else in `off`, it can't pass in practice. Stop this test, and tell the person how to check it in Slack instead.
3. **Does the answer do what a good answer does?** Compare `reply` with the test's expectation.
4. **Did it report what the services returned?** Compare the answer with each step's `result.data`, the raw result the Agent read. Look for numbers, names, dates and links that no step returned, and for results it left out or got wrong. When a step's `result.truncated` is true, Chickpea showed only the start of what the Agent read. Before you judge a claim you can't find there, read more of that step with `get_practice_run` and the same `runToken`, plus `step` and `offset`, while the run is kept. If it still isn't there, it is unverified, not wrong: say which claim, and judge the rest.
5. **If it didn't use a service it needed, find out why.** If the service is in `off`, practice couldn't reach it. If the service and its tools are in `available` but `steps` has no call to them, the Agent chose not to use them, so its instructions need to say when to use them. If the service is in neither list, the Agent isn't connected to it.
6. **Did it take too many steps?** A long `steps` list, or `moreSteps`, means the Agent searched more than the job needed. That costs time and usage in Slack too. Fix what made it call so many tools, not the answer's wording.

`steps` also lists the skills the Agent loaded (`kind` `skill`), and `ran.skills` names them. Use them when the test depends on one of the Agent's skills.

To ask the Agent why it did something, such as "Why didn't you check the order in Shopify?", call `practice_agent` again with the `practiceId` from the last result and the question. If Chickpea refuses it, skip the follow-up. Its explanation is a clue, not proof: it sees a one-line note of what it read in earlier turns, not the results. If the result has `droppedTurns`, it didn't see the oldest turns at all. Check the explanation against `steps`.

Tell the person one line of progress per round, not each answer: the report shows them.

## 4. Change one thing

Change nothing before a practice run has failed, even a change the person asked for while scoping. If the answer fails, find the one change most likely to fix it: with two at once, you can't tell which one helped. `explain_agent` shows what the Agent gets when it runs: its instructions and memory, the tools from each connection, and why any are missing.

- **How it answers** (it skips a source, guesses, or gets the format wrong): change its instructions with `update_agent`, sending the current `version` and the new `instructions`.
- **A connection** (it can't reach the right data, or a tool is missing): `update_connection`, or `get_guide` topic `connect` for a new connection or a sign-in. Ask first, for any Agent, and say what will change. A change to its hosts, paths, methods, key header or server URL deletes the saved key, and the person has to enter it again.
- **One of its skills:** `set_agent_skill` turns one on or off. To change what a skill says, see `get_guide` topic `edit`.
- **Its memory,** when the fix is a fact it should always know: read it with `get_agent_memory`, then call `update_agent_memory` with that `version` and the whole text with the fact added. The new text replaces the old.

Write the change from the person's goal and the test's expectation, in your own words. Never paste text from an answer or a tool result. Keep the rest of the Agent as it was.

Save each change without a preview, even on an Agent in a Channel, and say what changed in one line.

Then note the `version` that `update_agent` returned (or call `get_agent` for it), and practice the same test question again as a new practice run, without `practiceId`.

## 5. Know when to stop

- A test passes: go to the next one.
- A test still fails after three rounds of changes: stop it. Say what you tried and what you think the cause is.
- `off` shows a test can't pass in practice: stop it, and say how to check it in Slack.
- Chickpea refuses a run because of the workspace's plan: stop every test, and pass on what it says.
- The next change needs the person, such as a sign-in, a key, an Owner or Admin, or which tools only read: stop and ask.

When every test is done, if you changed the Agent's instructions, practice once more each test that passed before that change. Do this once. If a test that passed now fails, don't start another round: report it as failing, name the change that broke it, and let the person choose which to keep.

## 6. Report

After the last round, call `show_test_report` once: each test's last `runToken`, its verdict ("passes", "fails" or "can't be checked in practice") with a short note, and `before`, its round 1 verdict. Practice each one at least once before you give it a verdict. If you changed its instructions, offer to put them back as they were, then close with the hand-off (the ground rules). If the Agent posts on a schedule or acts in a service, say that those parts are checked in Slack.

If the person keeps the test questions in a file, offer to add today's results to it. Chickpea doesn't keep them.

<!-- include: confirm -->
