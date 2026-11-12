# Scope an Agent

A good teammate starts with a clear job. Draft the Agent's brief and its test questions from what you already know, ask only what would change the Agent, and leave the person with test questions a test drive can practice.

<!-- include: rules -->

## 1. Read the Agent

Call `list_agents` and match the Agent the person means. If they haven't said which, and there is more than one, ask. Call `get_agent` for its job, instructions, connections and Channels, and `list_schedules` with its `agentId` for what it runs on a schedule.

## 2. Draft the brief

Fill in each part yourself first. Use this conversation, the Agent as `get_agent` shows it, and what you already know about the person's work. Don't ask for chat history or documents.

- **Job:** what the Agent does, and what the person stops doing once it works.
- **Who asks, and where:** the teams or roles that will ask it, and whether they ask in direct messages, in a Channel, or it works on a schedule.
- **Sources:** where the answers come from, such as a connected service or public web pages. Name each one, and say what the Agent uses it for.
- **Never:** what the Agent must never do, and what it must ask before doing.
- **A good answer:** its length, its format, and what it always includes, such as a link to the record it used.

## 3. Ask what changes the Agent

Show the draft brief, then ask about the parts you had to guess. Ask only where the answer would change the Agent's instructions, its connections or its test questions. Put your draft answer in each question, so the person corrects it instead of starting from nothing. For example: "I assumed sales asks it in #sales, not in direct messages. Is that right?"

Ask at most five questions in all. Keep what is still unsettled in the brief, marked as a guess. If the draft has no guesses, ask nothing and go to step 4.

## 4. Write the test questions

Write 3 to 8 test questions. Each one has two parts:

- **The question,** as a person would type it to the Agent in Slack. Chickpea receives it when it's practiced, so never put a key, a password or private details in it, and never quote the person's files or past sessions.
- **What a good answer does,** in one sentence that you can check, such as "Gives the order's ship date from Shopify and links the order." Don't write the answer itself.

Cover the job the person cares about most first. Then add a question where the data is missing or unclear, and a question that asks the Agent for something its brief says it must never do.

A practice run only reads, in a direct message. Mark each test that practice can't fully check, and say how the person can check it in Slack instead:

- A post on a schedule: practice can run the task as a question, but nothing is posted.
- A change in a service, such as creating or sending something: the Agent only says what it would do.
- An answer that depends on Channel messages, reading Slack, a website login, a code repository or making images.

## 5. Keep them

Show the finished brief and its test questions in one block, so the person can copy it. Ask them to correct anything that's wrong.

Chickpea doesn't store the brief or the test questions. Never add them to the Agent's instructions or memory: the Agent would then see the test questions it is judged on. If you can write files in the current folder, offer to save them in `chickpea/<agent handle>-tests.md` there, and save only if they say yes. Otherwise, tell the person that a new chat won't have them, so they can keep a copy.

## 6. Hand over

If the brief shows a change the Agent clearly needs, such as a rule its instructions don't mention, name it, but don't make it here, even if the person agrees: the test drive makes it after a test fails, so you can see it was needed. Then test drive the Agent on these test questions (`get_guide` topic `test-drive`). If its connections still wait for a sign-in, finish that first (`get_guide` topic `connect`).
