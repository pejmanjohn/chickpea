/**
 * The fixed cases of `npm run verify:smoke`. Each case acts as the lane's
 * Owner through the world's Slack and Admin sessions, reads back with the
 * lane's readback app, and grades mechanically: a reply exists, it carries the
 * run's marker word, Admin reads back the saved value, or a URL path matches.
 * No case asks an agent to judge anything.
 *
 * A case returns `{ result, category, summary }`, where result is pass, fail
 * or blocked and category says whose failure it is (product, model, tool).
 * `needs` names cases whose output it uses; a case whose need did not pass is
 * recorded as blocked without running.
 */
import { createHash, randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tsMs = (ts) => Math.round(Number(ts) * 1000);

const pass = (summary) => ({ result: 'pass', category: null, summary });
const fail = (category, summary) => ({ result: 'fail', category, summary });

/** Polls `read` until it returns a value, or `undefined` after `timeoutMs`. */
async function pollUntil(read, { timeoutMs, intervalMs = 3_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(intervalMs);
  }
}

/**
 * Waits until the thread under `threadTs` holds a bot reply after `after`
 * that two reads `stableMs` apart agree on, so a streamed reply is read once
 * it stops changing.
 */
async function settledReplies(world, { channel, threadTs, after = threadTs, timeoutMs = 150_000, stableMs = 8_000 }) {
  const fromBot = (message) => message.ts !== threadTs && Number(message.ts) > Number(after) && Boolean(message.botId);
  const signature = (replies) => JSON.stringify(replies.map((message) => [message.ts, message.text.length, message.edited?.ts ?? null]));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const first = (await world.reader.thread(channel, threadTs)).messages.filter(fromBot);
    if (first.length) {
      await sleep(stableMs);
      const thread = await world.reader.thread(channel, threadTs);
      const second = thread.messages.filter(fromBot);
      if (signature(first) === signature(second)) return { replies: second, thread };
    } else {
      await sleep(3_000);
    }
    if (Date.now() > deadline) return { replies: first, thread: await world.reader.thread(channel, threadTs) };
  }
}

async function post(world, { channel, text, threadTs }) {
  const posted = await world.slack.call('chat.postMessage', { channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false });
  if (!posted?.ok) throw new Error(`chat.postMessage in ${channel} answered ${posted?.error ?? 'nothing'}.`);
  return posted.ts;
}

const hasWord = (messages, word) => messages.some((message) => message.text.toUpperCase().includes(word));
const brief = (message) => (message?.text ?? '').replace(/\s+/g, ' ').slice(0, 140);

/** Posts `text`, waits for the settled replies, and grades the marker word. */
async function askAndGrade(world, name, { channel, text, threadTs, word }) {
  const ts = await post(world, { channel, text, threadTs });
  const root = threadTs ?? ts;
  const settled = await settledReplies(world, { channel, threadTs: root, after: ts });
  world.evidence.write(`${name}-thread.json`, settled.thread);
  const seconds = settled.replies[0] ? ((tsMs(settled.replies[0].ts) - tsMs(ts)) / 1000).toFixed(1) : null;
  if (!settled.replies.length) return { ts, root, outcome: fail('product', `No bot reply in ${channel} to ${ts} within the wait.`) };
  if (!hasWord(settled.replies, word)) {
    return { ts, root, outcome: fail('model', `Bot replied in ${seconds} s without the marker ${word}: '${brief(settled.replies[0])}'.`) };
  }
  return { ts, root, outcome: pass(`Bot reply in ${seconds} s carries ${word}.`) };
}

/** Admin's record of an Agent by its display name, among non-archived Agents. */
async function agentByName(world, name) {
  const listed = await world.admin.call('GET', '/admin/api/agents');
  return (listed.body?.agents ?? []).find((agent) => agent.name === name && agent.lifecycle !== 'archived');
}

export const SMOKE_CASES = [
  {
    id: 'dm-reply',
    async run(world) {
      const word = world.word('DM');
      const { outcome } = await askAndGrade(world, 'dm-reply', {
        channel: world.dm, word, text: `Smoke check ${world.marker}: reply with one short sentence that includes the word ${word}.`,
      });
      return outcome;
    },
  },
  {
    id: 'channel-mention',
    async run(world, shared) {
      const word = world.word('MENTION');
      const { root, outcome } = await askAndGrade(world, 'channel-mention', {
        channel: world.channel, word,
        text: `<@${world.botUserId}> Smoke check ${world.marker}: reply with one short sentence that includes the word ${word}.`,
      });
      shared.mentionThread = root;
      return outcome;
    },
  },
  {
    id: 'thread-follow-up',
    needs: ['channel-mention'],
    async run(world, shared) {
      const word = world.word('FOLLOW');
      const { outcome } = await askAndGrade(world, 'thread-follow-up', {
        channel: world.channel, threadTs: shared.mentionThread, word,
        text: `Smoke check ${world.marker}, no mention: reply once more with one short sentence that includes the word ${word}.`,
      });
      return outcome;
    },
  },
  {
    id: 'agent-create-welcome',
    async run(world, shared) {
      const name = `Smoke ${world.marker}`;
      const handle = `smoke-${world.marker.toLowerCase()}`;
      const request = await post(world, {
        channel: world.dm,
        text: `Smoke check ${world.marker}: create a new Agent named "${name}" with the handle ${handle}. ` +
          'Its instructions: "Answer in one short sentence." No connections, no skills. Propose it so I can approve.',
      });
      const proposal = await settledReplies(world, { channel: world.dm, threadTs: request });
      world.evidence.write('agent-create-proposal.json', proposal.thread);
      if (!proposal.replies.length) return fail('product', `No reply to the Agent request ${request}.`);
      const approve = await post(world, { channel: world.dm, threadTs: request, text: 'approve' });
      const agent = await pollUntil(() => agentByName(world, name), { timeoutMs: 120_000 });
      if (!agent) {
        const thread = await world.reader.thread(world.dm, request);
        world.evidence.write('agent-create-thread.json', thread);
        return fail('model', `Approved at ${approve}, but Admin lists no Agent named ${name}. Last reply: '${brief(thread.messages.at(-1))}'.`);
      }
      shared.agent = agent;
      world.cleanup.push({ kind: 'agent', id: agent.id });
      const after = await settledReplies(world, { channel: world.dm, threadTs: request, after: approve, timeoutMs: 90_000 });
      world.evidence.write('agent-create-thread.json', after.thread);
      // The welcome is the new Agent's first message: Chickpea's bot posting under the Agent's name.
      const welcomes = after.replies.filter((message) => message.customName === agent.name);
      if (welcomes.length !== 1) {
        return fail('product', `Agent ${agent.id} created; expected one welcome after the approval, read ${welcomes.length} of ${after.replies.length} replies.`);
      }
      return pass(`Agent ${agent.id} (@${handle}) created on approval, with one welcome.`);
    },
  },
  {
    id: 'instruction-proposal',
    needs: ['agent-create-welcome'],
    async run(world, shared) {
      const word = world.word('RULE');
      const request = await post(world, {
        channel: world.dm,
        text: `Smoke check ${world.marker}: change the instructions of the Agent "${shared.agent.name}" to: ` +
          `"Answer in one short sentence and end with the word ${word}." Propose the change so I can approve.`,
      });
      const proposal = await settledReplies(world, { channel: world.dm, threadTs: request });
      world.evidence.write('instruction-proposal.json', proposal.thread);
      if (!proposal.replies.length) return fail('product', `No reply to the instruction request ${request}.`);
      const approve = await post(world, { channel: world.dm, threadTs: request, text: 'approve' });
      const saved = await pollUntil(async () => {
        const read = await world.admin.call('GET', `/admin/api/agents/${encodeURIComponent(shared.agent.id)}`);
        const agent = read.body?.agent ?? read.body;
        return typeof agent?.instructions === 'string' && agent.instructions.toUpperCase().includes(word) ? agent : undefined;
      }, { timeoutMs: 90_000 });
      world.evidence.write('instruction-readback.json', saved ?? null);
      if (!saved) return fail('model', `Approved at ${approve}, but Admin's instructions for ${shared.agent.id} lack ${word}.`);
      shared.agent = saved;
      return pass(`Approved instructions for ${saved.id} read back from Admin with ${word}.`);
    },
  },
  {
    id: 'admin-owner-save',
    needs: ['instruction-proposal'],
    async run(world, shared) {
      const account = await world.admin.call('GET', '/admin/api/account');
      const role = account.body?.account?.role;
      if (account.status !== 200 || role !== 'owner') return fail('product', `GET /admin/api/account answered ${account.status}, role ${role ?? 'none'}.`);
      const description = `Smoke ${world.marker} saved from Admin.`;
      const path = `/admin/api/agents/${encodeURIComponent(shared.agent.id)}`;
      const saved = await world.admin.call('PATCH', path, { description, expectedRevision: shared.agent.revision });
      const read = await world.admin.call('GET', path);
      const agent = read.body?.agent ?? read.body;
      world.evidence.write('admin-save.json', { saved: { status: saved.status, error: saved.body?.error ?? null }, read: { status: read.status, description: agent?.description } });
      if (saved.status !== 200 || agent?.description !== description) {
        return fail('product', `PATCH ${path} answered ${saved.status}${saved.body?.error ? ` (${saved.body.error})` : ''}; description reads '${agent?.description ?? 'none'}'.`);
      }
      return pass(`Owner session (role owner) saved a description on ${agent.id}, read back.`);
    },
  },
  {
    id: 'routine-due-now',
    async run(world) {
      const word = world.word('ROUTINE');
      // A channel routine needs a user Agent that works in the channel, and Admin lists it under that Agent;
      // a direct-message routine stays private to its person, so the due-now hook could not name it.
      const owner = world.channelAgent;
      if (!owner) return { result: 'blocked', category: 'tool', summary: `No published user Agent works in #qa-${world.lane}.` };
      const schedulesPath = `/admin/api/agents/${encodeURIComponent(owner.id)}/schedules`;
      const list = async () => (await world.admin.call('GET', schedulesPath)).body?.schedules ?? [];
      const known = new Set((await list()).map((schedule) => schedule.id));
      const request = await post(world, {
        channel: world.channel,
        text: `<!subteam^${owner.userGroupId}> Smoke check ${world.marker}: schedule a one-time task in this channel for tomorrow at 9:00 AM ` +
          `that posts one short message containing the word ${word}. Only once, no repeat.`,
      });
      const created = await pollUntil(async () => {
        const fresh = (await list()).filter((schedule) => !known.has(schedule.id));
        return fresh.length ? fresh : undefined;
      }, { timeoutMs: 150_000 });
      if (created) for (const schedule of created) world.cleanup.push({ kind: 'routine', id: schedule.id, schedulesPath });
      // The Agent's confirmation also carries the marker; let it land before the routine is made due.
      const confirmation = await settledReplies(world, { channel: world.channel, threadTs: request, timeoutMs: 60_000 });
      world.evidence.write('routine-request.json', confirmation.thread);
      if (!created) return fail('model', `Asked for a one-time routine at ${request}; Admin lists none. Last reply: '${brief(confirmation.thread.messages.at(-1))}'.`);
      const routine = created[0];
      const before = new Set(confirmation.thread.messages.map((message) => message.ts));
      const dueAt = Date.now();
      const due = await world.markDueNow(routine.id);
      if (due.status !== 200) return fail('tool', `The due-now hook answered ${due.status} ${JSON.stringify(due.body)} for ${routine.id}.`);
      // The delivery may open a new channel message or answer in the request's thread.
      const deliveries = async () => {
        const [history, thread] = await Promise.all([
          world.reader.history(world.channel, { oldest: request, limit: 100 }),
          world.reader.thread(world.channel, request),
        ]);
        const seen = new Map([...history.messages, ...thread.messages].map((message) => [message.ts, message]));
        const found = [...seen.values()].filter((message) => message.botId && !before.has(message.ts) && tsMs(message.ts) > dueAt &&
          message.text.toUpperCase().includes(word));
        return { history, thread, found };
      };
      const delivered = await pollUntil(async () => { const read = await deliveries(); return read.found.length ? read : undefined; }, { timeoutMs: 180_000, intervalMs: 5_000 });
      if (!delivered) return fail('product', `Routine ${routine.id} was made due; no delivery with ${word} within 180 s.`);
      // A finished one-time routine leaves the Agent's list, so completion is read from its own record.
      const completed = await pollUntil(async () => {
        const read = await world.admin.call('GET', `/admin/api/audit/scheduled_work/routines/${encodeURIComponent(routine.id)}`);
        return read.body?.routine?.state === 'completed' ? read.body.routine : undefined;
      }, { timeoutMs: 90_000 });
      const again = await deliveries();
      world.evidence.write('routine-delivery.json', again);
      const late = ((tsMs(delivered.found[0].ts) - dueAt) / 1000).toFixed(1);
      if (again.found.length !== 1 || !completed) {
        return fail('product', `Routine ${routine.id}: ${again.found.length} deliveries, Admin ${completed ? 'completed' : 'not completed'}.`);
      }
      return pass(`Routine ${routine.id} delivered once ${late} s after the due-now hook, and completed.`);
    },
  },
  {
    id: 'mcp-signin-resume',
    async run(world) {
      const { origin } = world;
      const redirect = 'http://127.0.0.1:47321/callback';
      const scope = 'chickpea:workspace offline_access';
      const registered = await fetch(`${origin}/api/auth/oauth2/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          application_type: 'native', client_name: `Chickpea smoke ${world.marker}`, grant_types: ['authorization_code', 'refresh_token'],
          redirect_uris: [redirect], response_types: ['code'], token_endpoint_auth_method: 'none', scope,
        }),
      });
      const client = await registered.json().catch(() => ({}));
      if (registered.status !== 201 || !client.client_id) return fail('product', `Client registration answered ${registered.status}.`);
      const verifier = randomBytes(32).toString('base64url');
      const query = new URLSearchParams({
        response_type: 'code', client_id: client.client_id, redirect_uri: redirect, scope, state: world.marker,
        resource: `${origin}/mcp`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      });
      const hops = [];
      let url = `${origin}/api/auth/oauth2/authorize?${query}`;
      let page = '';
      for (let hop = 0; hop < 6; hop += 1) {
        const response = await fetch(url, { redirect: 'manual' });
        hops.push(`${response.status} ${new URL(url).pathname}`);
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) { url = new URL(location, url).href; continue; }
        page = await response.text();
        // Better Auth answers a script's authorize with the browser's next stop as JSON.
        let next;
        try { next = JSON.parse(page); } catch { next = undefined; }
        if (next?.redirect === true && typeof next.url === 'string') { url = new URL(next.url, url).href; continue; }
        break;
      }
      const destination = /name="destination" value="([^"]*)"/u.exec(page)?.[1]?.replaceAll('&#x2F;', '/') ?? '';
      world.evidence.write('mcp-signin.json', { hops, destination });
      if (!/^\/auth\/mcp\/resume\/[A-Za-z0-9_-]{43,128}$/u.test(destination)) {
        return fail('product', `Signed-out MCP sign-in (${hops.join(' -> ')}) carries destination '${destination || 'none'}', not the MCP resume path.`);
      }
      const start = await fetch(`${origin}/auth/slack/oidc/start`, {
        method: 'POST', redirect: 'manual',
        headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ purpose: 'login', destination }),
      });
      const link = /data-slack-authorization-link href="([^"]*)"/u.exec(await start.text())?.[1]?.replaceAll('&amp;', '&') ?? '';
      const slack = link ? new URL(link) : null;
      if (start.status !== 200 || slack?.host !== 'slack.com' || slack.pathname !== '/openid/connect/authorize') {
        return fail('product', `Slack sign-in start for ${destination} answered ${start.status} with '${slack ? `${slack.host}${slack.pathname}` : 'no link'}'.`);
      }
      return pass(`Signed-out MCP sign-in (${hops.join(' -> ')}) keeps the MCP resume destination into Slack's authorize page.`);
    },
  },
];
