/**
 * The in-page half of the runner matrix. The lane's operator has no Slack
 * token on gateway lanes (hosts.md, "Slack evidence on gateway lanes"), so the
 * only sender and reader is the lane browser's signed-in Slack web client.
 * `renderHarness` emits one self-contained function for the lane browser's
 * `evaluate_script`; it posts the planned messages as the signed-in test actor,
 * taps the client's existing websocket for status frames, and reads threads
 * back with `conversations.replies`. The session credential stays inside the
 * page: nothing here returns, logs, or stores it.
 *
 * The pure helpers below are embedded with `Function.prototype.toString`, so
 * they must not reference module scope. Node tests call them directly.
 */
import type { FrameEvent, MatrixPlan, MessageSummary } from './types.ts';

/** Reduce one websocket frame to a compact observation, or null when irrelevant. */
export function classifyFrame(frame: Record<string, unknown>, now: number): Omit<FrameEvent, never> | null {
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const isBot = (m: Record<string, unknown>) => Boolean(m.bot_id || m.subtype === 'bot_message' || m.bot_profile);
  const streamState = (m: Record<string, unknown>): string | undefined => {
    for (const [key, value] of Object.entries(m)) {
      if (/stream/i.test(key) && typeof value === 'string' && /^[a-z_]{3,24}$/.test(value)) return value;
      if (/stream/i.test(key) && value && typeof value === 'object') {
        for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
          if (/state|status/i.test(inner) && typeof nested === 'string' && /^[a-z_]{3,24}$/.test(nested)) return nested;
        }
      }
    }
    return undefined;
  };
  const type = str(frame.type);
  if (type === 'ai_assistant_status') {
    const channel = str(frame.channel_id), thread = str(frame.thread_ts);
    if (!channel || !thread) return null;
    const status = str(frame.status) ?? '';
    const custom = Array.isArray(frame.loading_messages) || !/typing/i.test(status);
    const kind = status ? (custom ? 'custom' : 'native') : (frame.is_using_sessions ? 'native-clear' : 'custom-clear');
    const event: FrameEvent = { t: now, kind, channel, thread, status: status.slice(0, 60) };
    const statusType = str(frame.status_type), who = str(frame.username);
    if (statusType) event.statusType = statusType;
    if (who) event.who = who.slice(0, 60);
    return event;
  }
  if (type !== 'message') return null;
  const channel = str(frame.channel);
  if (!channel) return null;
  if (frame.subtype === 'message_changed') {
    const m = (frame.message && typeof frame.message === 'object' ? frame.message : {}) as Record<string, unknown>;
    const thread = str(m.thread_ts) ?? str(m.ts);
    if (!thread || !isBot(m)) return null;
    const state = streamState(m);
    const event: FrameEvent = { t: now, kind: state ? `stream-${state}` : 'bot-edit', channel, thread, len: (str(m.text) ?? '').length };
    const ts = str(m.ts);
    if (ts) event.ts = ts;
    return event;
  }
  if (frame.subtype && frame.subtype !== 'bot_message' && frame.subtype !== 'thread_broadcast') return null;
  const ts = str(frame.ts);
  const thread = str(frame.thread_ts) ?? ts;
  if (!ts || !thread) return null;
  const event: FrameEvent = { t: now, kind: isBot(frame) ? 'bot-post' : 'user-post', channel, thread, ts, len: (str(frame.text) ?? '').length };
  return event;
}

/** Content-light readback of one Slack message. */
export function summarizeMessage(
  message: Record<string, unknown>,
  signatures: ReadonlyArray<{ key: string; prefix: string }>,
  marker: string,
): MessageSummary {
  const text = typeof message.text === 'string' ? message.text : '';
  const pieces: string[] = [];
  const types: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, depth + 1); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string' && ['text', 'plain_text', 'mrkdwn', 'link'].includes(String(record.type))) pieces.push(record.text);
    for (const [key, value] of Object.entries(record)) if (key !== 'text' || typeof value === 'object') walk(value, depth + 1);
  };
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).type === 'string') types.push(String((block as Record<string, unknown>).type));
    walk(block, 0);
  }
  const blockText = pieces.join('');
  const haystack = `${text}\n${blockText}`;
  const failure = signatures.find((signature) => haystack.includes(signature.prefix))?.key ?? null;
  const profile = (message.bot_profile && typeof message.bot_profile === 'object' ? message.bot_profile : {}) as Record<string, unknown>;
  const who = typeof message.username === 'string' ? message.username
    : typeof profile.name === 'string' ? profile.name
      : typeof message.user === 'string' ? 'user' : 'unknown';
  return {
    ts: String(message.ts ?? ''),
    bot: Boolean(message.bot_id || message.subtype === 'bot_message' || message.bot_profile),
    who: who.slice(0, 60),
    textLen: text.length,
    blockTextLen: blockText.length,
    blockTypes: types,
    footer: types.includes('context'),
    failure,
    marker: marker.length > 0 && haystack.includes(marker),
    tail: (blockText || text).slice(-120),
  };
}

export const HARNESS_GLOBAL = '__chickpeaRunnerMatrix';

/** The page runtime. Written as a function so tests can run it in a VM. */
function harnessRuntime(PLAN: MatrixPlan, lib: { classifyFrame: typeof classifyFrame; summarizeMessage: typeof summarizeMessage }, G: string) {
  const w = globalThis as unknown as Record<string, any>;
  const existing = w[G];
  if (existing && existing.tag === PLAN.tag) return existing.describe();
  if (existing && typeof existing.dispose === 'function') existing.dispose();
  const storageKey = `chickpea-runner-matrix:${PLAN.tag}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const state: any = { tag: PLAN.tag, armedT0: null, sent: {}, frames: [], errors: [], resolved: { dm: PLAN.dm, agents: {} }, timers: [], exported: null };
  try {
    const saved = JSON.parse(w.localStorage.getItem(storageKey) || 'null');
    if (saved && saved.tag === PLAN.tag) { state.sent = saved.sent || {}; state.armedT0 = saved.armedT0 ?? null; state.resolved = saved.resolved || state.resolved; }
  } catch { /* a fresh page has no saved progress */ }
  const persist = () => { try { w.localStorage.setItem(storageKey, JSON.stringify({ tag: PLAN.tag, sent: state.sent, armedT0: state.armedT0, resolved: state.resolved })); } catch { /* storage is a convenience */ } };

  const session = () => {
    const config = JSON.parse(w.localStorage.getItem('localConfig_v2') || '{}');
    const team = config && config.teams ? config.teams[PLAN.workspaceId] : null;
    if (!team || typeof team.token !== 'string') throw new Error('This tab is not signed in to the planned Slack workspace.');
    let base = '/api/';
    try { if (typeof team.url === 'string') base = new URL('api/', team.url).href; } catch { /* default base */ }
    return { base, credential: team.token as string };
  };
  const api = async (method: string, params: Record<string, string | number | undefined>) => {
    const { base, credential } = session();
    let retries = 0;
    for (;;) {
      const body = new w.FormData();
      body.append('token', credential);
      for (const [key, value] of Object.entries(params)) if (value !== undefined) body.append(key, String(value));
      const response = await w.fetch(base + method, { method: 'POST', body, credentials: 'include' });
      if (response.status === 429 && retries < 5) { retries += 1; await sleep((Number(response.headers.get('retry-after')) || 1) * 1000); continue; }
      const json = await response.json();
      if (json && json.error === 'ratelimited' && retries < 5) { retries += 1; await sleep(1000); continue; }
      return { json, retries };
    }
  };

  // Websocket tap: Slack reads MessageEvent.data from its existing socket.
  const seen = new WeakSet();
  const channels = new Set<string>([PLAN.channel]);
  if (PLAN.dm) channels.add(PLAN.dm);
  const descriptor = Object.getOwnPropertyDescriptor(w.MessageEvent.prototype, 'data');
  const onFrame = (raw: string) => {
    if (raw.indexOf('"ai_assistant_status"') < 0 && raw.indexOf('"message"') < 0) return;
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    const event = lib.classifyFrame(frame, Date.now());
    if (event && channels.has(event.channel) && state.frames.length < 20000) state.frames.push(event);
  };
  if (descriptor && descriptor.get) {
    Object.defineProperty(w.MessageEvent.prototype, 'data', {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get() {
        const value = descriptor.get!.call(this);
        try {
          if (!seen.has(this) && typeof value === 'string' && this.target instanceof w.WebSocket) { seen.add(this); onFrame(value); }
        } catch { /* observation never breaks the client */ }
        return value;
      },
    });
  } else state.errors.push('websocket tap unavailable');

  const resolve = async () => {
    const missing: string[] = [];
    if (!state.resolved.dm) {
      const { json } = await api('conversations.open', { users: PLAN.botUserId });
      if (json && json.ok && json.channel && json.channel.id) state.resolved.dm = json.channel.id; else missing.push(`dm:${json && json.error}`);
    }
    if (state.resolved.dm) channels.add(state.resolved.dm);
    const { json } = await api('usergroups.list', { include_disabled: 'false' });
    const groups = json && json.ok && Array.isArray(json.usergroups) ? json.usergroups : [];
    for (const [ref, handle] of Object.entries(PLAN.agents)) {
      const group = groups.find((entry: any) => entry && entry.handle === handle);
      if (group) state.resolved.agents[ref] = group.id; else missing.push(`agent-${ref}:${handle}`);
    }
    persist();
    return missing;
  };

  const threadOf = (label: string) => state.sent[label] && state.sent[label].ok ? state.sent[label] : null;
  const send = async (item: any) => {
    if (state.sent[item.label]) return;
    const channel = item.where === 'dm' ? state.resolved.dm : PLAN.channel;
    let threadTs: string | undefined;
    if (item.after) {
      const parent = threadOf(item.after.label);
      if (!parent) { state.sent[item.label] = { label: item.label, caseId: item.caseId, channel, t0: Date.now(), tAck: Date.now(), ok: false, error: 'parent_not_sent' }; persist(); return; }
      threadTs = parent.thread;
    }
    const mention = item.agent ? `<!subteam^${state.resolved.agents[item.agent]}>` : '';
    const text = item.text.replace('{mention}', mention);
    const t0 = Date.now();
    state.sent[item.label] = { label: item.label, caseId: item.caseId, channel, t0, tAck: t0, ok: false, error: 'pending' };
    try {
      const { json, retries } = await api('chat.postMessage', { channel, text, thread_ts: threadTs, unfurl_links: 'false', unfurl_media: 'false' });
      const record: any = { label: item.label, caseId: item.caseId, channel, t0, tAck: Date.now(), ok: Boolean(json && json.ok), retries };
      if (json && json.ok) { record.ts = json.ts; record.thread = threadTs || json.ts; } else record.error = String(json && json.error || 'unknown');
      state.sent[item.label] = record;
    } catch (error) {
      state.sent[item.label] = { label: item.label, caseId: item.caseId, channel, t0, tAck: Date.now(), ok: false, error: String((error as Error).message || error).slice(0, 120) };
    }
    persist();
  };
  const waitForFinal = async (label: string, deadline: number) => {
    while (Date.now() < deadline) {
      const parent = threadOf(label);
      if (parent && state.frames.some((f: any) => f.kind === 'bot-post' && f.channel === parent.channel && f.thread === parent.thread)) return true;
      if (parent) {
        try {
          const { json } = await api('conversations.replies', { channel: parent.channel, ts: parent.thread, limit: 20 });
          if (json && json.ok && Array.isArray(json.messages) && json.messages.some((m: any) => m.ts !== parent.ts && (m.bot_id || m.bot_profile))) return true;
        } catch { /* keep polling until the deadline */ }
      }
      await sleep(Math.max(250, Math.round(3000 * PLAN.timeScale)));
    }
    return false;
  };

  const api_ = {
    tag: PLAN.tag,
    describe() {
      const sent = Object.values(state.sent) as any[];
      return { tag: PLAN.tag, armedT0: state.armedT0, planned: PLAN.items.length, sent: sent.filter((s) => s.ok).length, failed: sent.filter((s) => !s.ok && s.error !== 'pending').map((s) => `${s.label}:${s.error}`), frames: state.frames.length, resolved: { dm: Boolean(state.resolved.dm), agents: Object.keys(state.resolved.agents) }, errors: state.errors.slice(-5) };
    },
    async arm(options: { leadMs?: number } = {}) {
      if (state.armedT0 && Date.now() < state.armedT0 + PLAN.endMs) return { ...api_.describe(), t0: state.armedT0, note: 'already armed; not rescheduled' };
      const missing = await resolve();
      if (missing.length) return { ...api_.describe(), t0: null, missing };
      const lead = Math.max(options.leadMs ?? 90000, PLAN.minLeadMs);
      state.armedT0 = Date.now() + lead;
      persist();
      api_.schedule();
      return { ...api_.describe(), t0: state.armedT0 };
    },
    schedule() {
      const t0 = state.armedT0;
      for (const item of PLAN.items) {
        if (state.sent[item.label]) continue;
        if (item.after) {
          const parent = PLAN.items.find((p) => p.label === item.after!.label)!;
          const start = Math.max(0, t0 + (parent.atMs ?? 0) - Date.now());
          state.timers.push(setTimeout(async () => {
            const ok = await waitForFinal(parent.label, t0 + PLAN.endMs);
            if (!ok) { state.errors.push(`${item.label}: parent final not observed`); return; }
            await sleep(item.after!.delayMs);
            await send(item);
          }, start));
        } else state.timers.push(setTimeout(() => { void send(item); }, Math.max(0, t0 + item.atMs! - Date.now())));
      }
    },
    disarm() {
      for (const timer of state.timers) clearTimeout(timer);
      state.timers = [];
      const unsent = PLAN.items.filter((item) => !state.sent[item.label]).length;
      if (Object.keys(state.sent).length === 0) state.armedT0 = null;
      persist();
      return { ...api_.describe(), unsent };
    },
    async collect(options: { chunkChars?: number } = {}) {
      const threads: Record<string, unknown[]> = {};
      const sent = Object.values(state.sent) as any[];
      const keys = new Map<string, { channel: string; thread: string }>();
      for (const s of sent) if (s.ok) keys.set(`${s.channel}:${s.thread}`, { channel: s.channel, thread: s.thread });
      const markerFor = (key: string) => {
        const root = sent.find((s) => s.ok && `${s.channel}:${s.ts}` === key);
        return root ? (PLAN.items.find((i) => i.label === root.label)?.marker ?? '') : '';
      };
      for (const [key, { channel, thread }] of keys) {
        const messages: unknown[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const { json } = await api('conversations.replies', { channel, ts: thread, limit: 200, cursor });
          if (!json || !json.ok) { state.errors.push(`replies ${key}: ${json && json.error}`); break; }
          for (const m of json.messages || []) {
            const own = sent.find((s) => s.ok && s.channel === channel && s.ts === m.ts);
            const marker = own ? (PLAN.items.find((i) => i.label === own.label)?.marker ?? '') : markerFor(key);
            messages.push(lib.summarizeMessage(m, PLAN.failureSignatures, marker));
          }
          cursor = json.response_metadata && json.response_metadata.next_cursor;
          if (!cursor) break;
        }
        threads[key] = messages;
      }
      const exported = {
        schema: 'chickpea-runner-matrix-export/v1', tag: PLAN.tag, armedT0: state.armedT0, exportedAt: Date.now(),
        sent, frames: state.frames, threads, resolved: state.resolved, errors: state.errors,
      };
      const text = JSON.stringify(exported);
      const size = Math.max(4000, options.chunkChars ?? 40000);
      state.exported = [];
      for (let i = 0; i < text.length; i += size) state.exported.push(text.slice(i, i + size));
      return { chunks: state.exported.length, chars: text.length, threads: keys.size, errors: state.errors.length };
    },
    chunk(index: number) {
      if (!state.exported || !state.exported[index]) throw new Error('Run collect() first, then read chunks 0..chunks-1.');
      return state.exported[index];
    },
    dispose() {
      for (const timer of state.timers) clearTimeout(timer);
      if (descriptor) Object.defineProperty(w.MessageEvent.prototype, 'data', descriptor);
    },
  };
  w[G] = api_;
  if (state.armedT0 && Date.now() < state.armedT0 + PLAN.endMs) api_.schedule();
  return api_.describe();
}

/** The injectable harness: one function expression for `evaluate_script`. */
export function renderHarness(plan: MatrixPlan): string {
  return [
    '() => {',
    '  // Chickpea runner-matrix harness. Generated; private (contains the run plan).',
    '  var __name = (target) => target;',
    `  const PLAN = ${JSON.stringify(plan)};`,
    `  const lib = { classifyFrame: ${classifyFrame.toString()}, summarizeMessage: ${summarizeMessage.toString()} };`,
    `  return (${harnessRuntime.toString()})(PLAN, lib, ${JSON.stringify(HARNESS_GLOBAL)});`,
    '}',
    '',
  ].join('\n');
}

export function renderSnippets(leadMs: number): Record<string, string> {
  const g = `globalThis[${JSON.stringify(HARNESS_GLOBAL)}]`;
  return {
    'arm.js': `async () => ${g}.arm({ leadMs: ${leadMs} })\n`,
    'status.js': `() => ${g}.describe()\n`,
    'collect.js': `async () => ${g}.collect({ chunkChars: 40000 })\n`,
    'chunk.js': `() => ${g}.chunk(0)\n`,
    'disarm.js': `() => ${g}.disarm()\n`,
  };
}
