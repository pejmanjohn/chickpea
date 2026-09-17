// Provider-specific configuration stays separate from application settings.
// Never print ngrok output: authentication failures can echo the authtoken.
export function validateNgrokOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9-]+\.(?:ngrok-free\.(?:app|dev)|ngrok\.(?:app|dev|io))$/.test(url.hostname)) {
    throw new Error('Use the assigned HTTPS dev domain from https://dashboard.ngrok.com/domains. Do not invent a name or reuse a domain serving another installation.');
  }
  return url.origin;
}

export function renderNgrokConfig(token) {
  const value = String(token).trim();
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw new Error('The ngrok authtoken must be one non-empty token. Copy only the token, not the dashboard command.');
  }
  return `version: 3\nagent:\n  authtoken: ${JSON.stringify(value)}\n  web_addr: false\n  console_ui: false\n  remote_management: false\n  update_check: false\n  log: stdout\n  log_format: json\n  log_level: info\n`;
}

export function ngrokArguments(installation) {
  return ['http', `http://127.0.0.1:${installation.port}`, '--url', installation.origin,
    '--config', installation.tunnel.configFile, '--inspect=false'];
}

export function ngrokFailureHint(code) {
  // Only an allowlisted code may leave the output parser, never provider prose.
  if (['725', '726', '727', '728', '729'].includes(code)) {
    return 'ngrok has reached a usage or traffic limit. Check https://dashboard.ngrok.com/usage and billing. Wait for the applicable reset or choose a suitable plan; reinstalling does not reset quotas.';
  }
  const known = {
    '105': 'The ngrok authtoken is invalid.',
    '106': 'The ngrok authtoken was revoked.',
    '107': 'The ngrok authtoken is invalid.',
    '4018': 'ngrok requires a verified account and authtoken.',
    '108': 'The ngrok account has reached its simultaneous agent limit. Check https://dashboard.ngrok.com/agents. Leave unrelated agents running; use a separate account or a suitable plan.',
    '334': 'The ngrok domain is already online. Leave that tunnel running. Use a domain dedicated to this installation; do not enable endpoint pooling.',
    '6024': 'ngrok returned its browser warning. Visit the public address and select Visit Site before continuing setup or OAuth.',
    '8012': 'ngrok cannot reach Chickpea. Check that this installation is running on its configured loopback port.',
  };
  if (!Object.hasOwn(known, code)) return undefined;
  const auth = ['105', '106', '107', '4018'].includes(code)
    ? ' Sign in at https://dashboard.ngrok.com/get-started/your-authtoken, then stop Chickpea and run `chickpea-node tunnel authenticate --token-file /absolute/private/token-file` with the new token. Keep the same account and dev domain.' : '';
  return `${known[code]}${auth}`;
}

export function watchNgrokOutput(child, onFailure, { origin, port, onReady } = {}) {
  const seen = new Set();
  for (const stream of [child.stdout, child.stderr]) {
    let tail = '';
    let pending = '';
    stream?.on('data', (bytes) => {
      const value = tail + bytes.toString();
      for (const match of value.matchAll(/ERR_NGROK_(\d{2,5})(?!\d)/g)) {
        const code = match[1];
        const hint = ngrokFailureHint(code);
        if (hint && !seen.has(code)) { seen.add(code); onFailure(hint); }
      }
      tail = value.slice(-32);
      pending += bytes.toString();
      const lines = pending.split('\n');
      pending = lines.pop().slice(-16_384);
      for (const line of lines) {
        if (line.length > 16_384) continue;
        try {
          const record = JSON.parse(line);
          if (record.msg === 'started tunnel' && record.url === origin &&
              record.addr === `http://127.0.0.1:${port}`) onReady?.();
        } catch { /* Raw output, including malformed config with tokens, stays private. */ }
      }
    });
  }
}

// Compare a public response with the local asset, so an HTML warning, a generic
// 200 error page, redirect, or unrelated 404 cannot count as tunnel readiness.
export async function checkPublicRoute(installation, fetchImpl = fetch) {
  const pathname = '/admin/setup/client.js';
  const options = () => ({ redirect: 'manual', signal: AbortSignal.timeout(2_000),
    headers: { 'User-Agent': 'Chickpea-Installer/1', 'ngrok-skip-browser-warning': '1' } });
  let localReachable = false;
  try {
    const local = await fetchImpl(`http://127.0.0.1:${installation.port}${pathname}`, options());
    localReachable = [200, 404].includes(local.status);
    const localBody = await boundedBody(local);
    const remote = await fetchImpl(new URL(pathname, installation.origin).href, options());
    const code = remote.headers.get('ngrok-error-code')?.replace(/^ERR_NGROK_/, '');
    const hint = code && ngrokFailureHint(code);
    const remoteBody = await boundedBody(remote);
    if (hint) return { reachable: false, localReachable, hint };
    if (!localReachable || remote.status !== local.status) return { reachable: false, localReachable };
    return { localReachable, reachable: localBody !== null && localBody.length > 0 && localBody === remoteBody &&
      local.headers.get('content-type') === remote.headers.get('content-type') };
  } catch { return { reachable: false, localReachable }; }
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('base64');
      size += value.length;
      if (size > 256 * 1024) return null;
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
}
