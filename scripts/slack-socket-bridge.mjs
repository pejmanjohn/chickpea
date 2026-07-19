// slack-socket-bridge.mjs — DEV-ONLY live-test bridge: Slack Socket Mode ->
// the local HTTP events endpoint. Run via `npm run slack:bridge`.
//
// WHEN TO USE: you want to drive the locally running server with REAL Slack
// events but don't want (or can't run) a public tunnel. Not a production
// transport: single consumer, immediate acks (so
// Slack-side retry semantics are not exercised — test those over HTTP), and it
// requires Socket Mode to be enabled on the app, which stops Slack from
// delivering events to the HTTP Request URL while enabled.
//
// SETUP:
//   1. In the Slack app console, enable Socket Mode.
//   2. Create an app-level token with the `connections:write` scope; it starts
//      with `xapp-` and is separate from the bot's `xoxb-` token.
//   3. Put that token and the app's signing secret in `.env.slack.local` as
//      SLACK_APP_TOKEN and SLACK_SIGNING_SECRET (or pass `--env <path>`).
//   4. Start the local Chickpea server, then run `npm run slack:bridge`.
// Disable Socket Mode again before testing or deploying the normal HTTP Events
// API path.
//
// HOW IT WORKS: the app's endpoint (POST /channels/slack/events) is what a
// public Slack Events API subscription would hit. This script opens a Socket
// Mode WebSocket to Slack (using an xapp- app-level token), receives the same
// Events API envelopes over that socket, re-signs each one with the app's
// signing secret exactly as Slack's HTTP delivery would, and POSTs it to the
// locally-running server. The server can't tell the difference: it verifies
// the v0 HMAC signature and processes a genuine event_callback envelope.
//
// IMPORTANT: while this is connected it consumes events for the app. Do not run
// it at the same time as another Socket Mode consumer (e.g. a real test run) —
// they would steal events from each other.
//
// Requires node >= 22.19 (see .nvmrc).
//
// Env (from the shell, or from an env file):
//   SLACK_APP_TOKEN       xapp- app-level token with connections:write (required)
//   SLACK_SIGNING_SECRET  must match the local server's (required)
//   PORT                  local server port to forward to (default 3583)
// Env file: `--env <path>` (default `.env.slack.local`, repo root); shell
// values win over file values.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SocketModeClient } from '@slack/socket-mode';

// --- Load the env file ---------------------------------------------------
// Minimal .env parser (no dotenv dependency). Reads KEY=VALUE lines, skips
// blanks and `#` comments, strips one layer of surrounding quotes, and only
// sets a key that isn't already present in process.env (so a value exported in
// the shell still wins). Missing file is non-fatal — we validate required keys
// below.
function loadEnvFile(path, { required = false } = {}) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    if (required) {
      // An explicitly requested env file that cannot be read is an operator
      // error (typo'd path) — starting anyway would silently use whatever
      // tokens the ambient shell holds, possibly for the wrong Slack app.
      console.error(`bridge: cannot read env file ${path} (from --env)`);
      process.exit(1);
    }
    return; // default file absent: rely on the ambient environment
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Accept shell-sourceable files: `export KEY=value` lines work too.
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a single pair of matching surrounding quotes if present.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envFlagIndex = process.argv.indexOf('--env');
let envFile = resolve(scriptDir, '..', '.env.slack.local');
let envExplicit = false;
if (envFlagIndex !== -1) {
  const value = process.argv[envFlagIndex + 1];
  if (!value || value.startsWith('--')) {
    console.error('bridge: --env requires a file path');
    process.exit(1);
  }
  envFile = resolve(process.cwd(), value);
  envExplicit = true;
}
loadEnvFile(envFile, { required: envExplicit });

const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const PORT = Number(process.env.PORT) || 3583;
const TARGET_URL = `http://127.0.0.1:${PORT}/channels/slack/events`;

if (!APP_TOKEN || !APP_TOKEN.startsWith('xapp-')) {
  console.error('bridge: SLACK_APP_TOKEN is missing or not an xapp- app-level token');
  process.exit(1);
}
if (!SIGNING_SECRET) {
  console.error('bridge: SLACK_SIGNING_SECRET is missing');
  process.exit(1);
}

// --- Signing -----------------------------------------------------------------
// Reproduce Slack's v0 request signature so the local endpoint's HMAC check
// passes. The base string is `v0:{timestamp}:{rawBody}` and the header value is
// `v0=` + lowercase hex HMAC-SHA256 keyed by the signing secret. The rawBody
// used here MUST be byte-identical to the body we POST, so we stringify once
// and reuse that exact string for both signing and the request body.
function slackSignature(timestamp, rawBody) {
  const hmac = createHmac('sha256', SIGNING_SECRET);
  hmac.update(`v0:${timestamp}:${rawBody}`);
  return `v0=${hmac.digest('hex')}`;
}

// --- Forward one Events API envelope to the local endpoint -------------------
// `eventsApiPayload` is the Events-API-shaped wrapper Slack would POST over
// HTTP: { token, team_id, api_app_id, event, type:'event_callback', event_id,
// event_time, authorizations }. Over Socket Mode this arrives as
// `envelope.payload` — i.e. the socket framing (envelope_id / retry_* /
// accepts_response_payload) has already been peeled off for us, so we forward
// the payload as-is.
async function forwardToEndpoint(eventsApiPayload) {
  const rawBody = JSON.stringify(eventsApiPayload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = slackSignature(timestamp, rawBody);

  const eventType = eventsApiPayload?.event?.type ?? 'unknown';
  // channel lives at event.channel for most events; DMs/assistant events may
  // carry it under event.channel or event.item.channel — best-effort for logs.
  const channel =
    eventsApiPayload?.event?.channel ?? eventsApiPayload?.event?.item?.channel ?? 'n/a';

  try {
    const res = await fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Signature': signature,
        'X-Slack-Request-Timestamp': String(timestamp),
      },
      body: rawBody,
    });
    console.log(`bridge: forwarded event=${eventType} channel=${channel} -> HTTP ${res.status}`);
  } catch (err) {
    // A connection refused here almost always means the local server isn't up.
    console.error(
      `bridge: forward failed event=${eventType} channel=${channel}: ${err?.message ?? err}`,
    );
  }
}

// --- Socket Mode client ------------------------------------------------------
const client = new SocketModeClient({ appToken: APP_TOKEN });

// Generic path: every inbound socket message is emitted as 'slack_event'. The
// arg shape is { ack, envelope_id, type, body, retry_num, retry_reason,
// accepts_response_payload }, where `type` is the socket message type
// ('events_api', 'slash_commands', 'interactive', ...) and `body` is the
// unwrapped payload. We only forward 'events_api' messages — those are the ones
// whose body is a genuine Events API event_callback wrapper the HTTP endpoint
// understands. Everything else (slash commands, interactivity) is acked and
// ignored, since the events endpoint doesn't handle them.
client.on('slack_event', async ({ ack, type, body }) => {
  // (a) Ack immediately so Slack doesn't retry — do this before any forwarding
  //     work, and unconditionally, so even ignored message types are acked.
  try {
    await ack();
  } catch (err) {
    console.error(`bridge: ack failed: ${err?.message ?? err}`);
  }

  if (type !== 'events_api') return;
  await forwardToEndpoint(body);
});

// Lifecycle logging. 'authenticated' fires once the app-level token is accepted;
// 'connected' fires when Slack completes the handshake (its `hello`). Reconnects
// are handled automatically by the client after .start(); we just log them.
let announcedReady = false;
function announceReady() {
  if (announcedReady) return;
  announcedReady = true;
  console.log(`bridge: connected, forwarding events to ${TARGET_URL}`);
}
client.on('authenticated', announceReady);
client.on('connected', announceReady);
client.on('disconnected', () => console.log('bridge: disconnected (will auto-reconnect)'));
client.on('reconnecting', () => console.log('bridge: reconnecting…'));

console.log('bridge: connecting to Slack socket mode…');
client.start().catch((err) => {
  console.error(`bridge: failed to start: ${err?.message ?? err}`);
  process.exit(1);
});
