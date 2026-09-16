# Install Chickpea on a Mac with Node

This guide runs Chickpea on one Mac with Node and SQLite. It does not deploy a
Cloudflare Worker. Chickpea still needs a stable public HTTPS origin so Slack
can reach it. The example below uses a named Cloudflare Tunnel for HTTPS only.

This installation is a foreground service. Keep the Mac awake and connected,
and keep both Chickpea and the tunnel running. No background work runs while
Chickpea is stopped. Check the selected release notes for current Node feature
support. The Node target does not include the Cloudflare coding sandbox, and it
uses single-host SQLite rather than Cloudflare Durable Objects and D1.
This is a supported Node deployment, not full Cloudflare runtime parity.

## What you need

- macOS with [nvm](https://github.com/nvm-sh/nvm) available in your shell
- A Slack workspace where you may create and install an app
- A model provider account and credential supported by Chickpea
- A domain on Cloudflare nameservers if you use the named tunnel example

Use a customer-owned Slack app for Node. The shared Chickpea Slack app does not
provide the durable event-admission contract that the Node target requires.

## 1. Check out one release

Clone Chickpea and select the stable release tag you intend to run. The
[GitHub releases page](https://github.com/pejmanjohn/chickpea/releases) lists
published releases.

```sh
git clone https://github.com/pejmanjohn/chickpea.git
cd chickpea
git fetch --tags
git tag --list 'v[0-9]*' --sort=-v:refname | head
```

Set the exact tag after reviewing the release, resolve it to a commit, and
check out that commit. Recording both values makes the installed source
unambiguous even if a tag is moved later.

```sh
export CHICKPEA_RELEASE_TAG='vX.Y.Z'
export CHICKPEA_RELEASE_COMMIT="$(git rev-parse "${CHICKPEA_RELEASE_TAG}^{commit}")"
git checkout --detach "$CHICKPEA_RELEASE_COMMIT"
printf 'Chickpea release: %s\nCommit: %s\n' \
  "$CHICKPEA_RELEASE_TAG" "$CHICKPEA_RELEASE_COMMIT"
```

## 2. Install Node and build

Chickpea pins Node 24.20.0 in `.nvmrc`.

```sh
nvm install
nvm use
node --version
npm ci
npm run flue:build
```

`node --version` must print `v24.20.0`. `npm ci` installs the exact lockfile
for the selected release. The production launcher uses the built files under
`dist/`, so do not skip the build.

## 3. Create a stable HTTPS tunnel

You may use any tunnel or reverse proxy that provides one stable public HTTPS
origin and forwards it to `http://127.0.0.1:3000`. Keep the Node listener on
loopback. If you already operate that route, skip the Cloudflare commands and
set `CHICKPEA_PUBLIC_HOST` and `CHICKPEA_PUBLIC_ORIGIN` to its hostname and
origin before step 4.

Install `cloudflared` and authenticate it with the Cloudflare account that owns
your domain. Cloudflare publishes its supported installation options on the
[cloudflared downloads page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create chickpea-node
cloudflared tunnel list
```

Copy the tunnel UUID from the command output and choose the public hostname.

```sh
export CHICKPEA_TUNNEL_ID='replace-with-the-tunnel-uuid'
export CHICKPEA_PUBLIC_HOST='chickpea.example.com'
export CHICKPEA_PUBLIC_ORIGIN="https://$CHICKPEA_PUBLIC_HOST"
export CHICKPEA_TUNNEL_CREDENTIALS="$HOME/.cloudflared/$CHICKPEA_TUNNEL_ID.json"
test -f "$CHICKPEA_TUNNEL_CREDENTIALS"
```

Write the tunnel configuration. This forwards the one public hostname to
Chickpea's loopback-only HTTP listener. The dedicated filename avoids replacing
another tunnel's default configuration.

```sh
install -d -m 700 "$HOME/.cloudflared"
export CHICKPEA_TUNNEL_CONFIG="$HOME/.cloudflared/chickpea-node.yml"
if test -e "$CHICKPEA_TUNNEL_CONFIG"; then
  echo "Review the existing file: $CHICKPEA_TUNNEL_CONFIG" >&2
else
  cat > "$CHICKPEA_TUNNEL_CONFIG" <<EOF
tunnel: $CHICKPEA_TUNNEL_ID
credentials-file: $CHICKPEA_TUNNEL_CREDENTIALS
ingress:
  - hostname: $CHICKPEA_PUBLIC_HOST
    service: http://127.0.0.1:3000
  - service: http_status:404
EOF
  chmod 600 "$CHICKPEA_TUNNEL_CONFIG"
fi
cloudflared tunnel route dns chickpea-node "$CHICKPEA_PUBLIC_HOST"
cloudflared tunnel --config "$CHICKPEA_TUNNEL_CONFIG" ingress validate
```

Cloudflare documents the same locally managed named-tunnel flow in
[Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
and [Route traffic with a DNS record](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/).
Do not use a random `trycloudflare.com` quick tunnel for production. Cloudflare
describes quick tunnels as testing and development tools, and their hostname is
not stable.

## 4. Create private state and runtime settings

The next commands create one private installation directory outside the source
checkout. The inline Node script writes the secret directly to a mode 0600 file
and does not print it. It refuses to replace an existing runtime file, which
protects the stable authentication secret on restarts and updates.

```sh
export CHICKPEA_NODE_HOME="$HOME/Library/Application Support/Chickpea/node"
export CHICKPEA_RUNTIME_ENV="$CHICKPEA_NODE_HOME/runtime.env"
install -d -m 700 "$CHICKPEA_NODE_HOME" "$CHICKPEA_NODE_HOME/state"

node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const root = process.env.CHICKPEA_NODE_HOME;
const envFile = process.env.CHICKPEA_RUNTIME_ENV;
const rawOrigin = process.env.CHICKPEA_PUBLIC_ORIGIN;

if (!root || !envFile || !rawOrigin) {
  throw new Error('CHICKPEA_NODE_HOME, CHICKPEA_RUNTIME_ENV, and CHICKPEA_PUBLIC_ORIGIN are required');
}

const origin = new URL(rawOrigin);
if (
  origin.protocol !== 'https:' ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
) {
  throw new Error('CHICKPEA_PUBLIC_ORIGIN must be an HTTPS origin with no path, query, or fragment');
}

const state = join(root, 'state');
mkdirSync(state, { recursive: true, mode: 0o700 });

const values = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '3000',
  TAG_DB_PATH: join(state, 'transcripts.sqlite'),
  SLACK_STATE_DB_PATH: join(state, 'app.sqlite'),
  CHICKPEA_AUTH_DB_PATH: join(state, 'auth.sqlite'),
  CHICKPEA_CREDENTIAL_KEYRING_PATH: join(state, 'credential-keyring.json'),
  CHICKPEA_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SLACK_TAG_PUBLIC_URL: origin.origin,
};

const body = Object.entries(values)
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  .join('\n') + '\n';

const fd = openSync(envFile, 'wx', 0o600);
try {
  writeFileSync(fd, body, 'utf8');
} finally {
  closeSync(fd);
}
NODE
```

Quoted dotenv values preserve the spaces in the macOS application-support
path. Do not move only one database or the credential keyring. They form one
installation state and must be backed up and restored together.

## 5. Create the private setup link

Create the setup link only when you are ready to finish setup. It expires after
24 hours. The commands save the capability and URL in private files without
printing either value to the terminal.

```sh
export CHICKPEA_SETUP_OUTPUT="$CHICKPEA_NODE_HOME/setup-link.txt"
if test -e "$CHICKPEA_SETUP_OUTPUT" || \
   grep -q '^CHICKPEA_SETUP_CAPABILITY_DIGEST=' "$CHICKPEA_RUNTIME_ENV"; then
  echo 'A setup capability already exists. Keep it unless it has expired.' >&2
elif (umask 077; node scripts/create-setup-link.mjs "$CHICKPEA_PUBLIC_ORIGIN" > "$CHICKPEA_SETUP_OUTPUT"); then
  sed -n '1,2p' "$CHICKPEA_SETUP_OUTPUT" >> "$CHICKPEA_RUNTIME_ENV"
  chmod 600 "$CHICKPEA_RUNTIME_ENV" "$CHICKPEA_SETUP_OUTPUT"
else
  rm -f "$CHICKPEA_SETUP_OUTPUT"
fi
```

Keep `runtime.env` and `setup-link.txt` out of source control, shell history,
logs, and messages.

If the link expires before setup finishes, stop Chickpea, remove only the two
setup capability lines and the saved link, then repeat this step. Keep every
other runtime setting, especially `CHICKPEA_AUTH_SECRET`.

```sh
sed -i '' \
  -e '/^CHICKPEA_SETUP_CAPABILITY_DIGEST=/d' \
  -e '/^CHICKPEA_SETUP_CAPABILITY_ISSUED_AT=/d' \
  "$CHICKPEA_RUNTIME_ENV"
rm -f "$CHICKPEA_SETUP_OUTPUT"
```

## 6. Start Chickpea and the tunnel

Open two Terminal windows. In the first, enter the Chickpea checkout and start
the production launcher. Set the file path again because a new Terminal does
not inherit variables from the earlier shell.

```sh
cd /path/to/chickpea
nvm use
CHICKPEA_RUNTIME_ENV="$HOME/Library/Application Support/Chickpea/node/runtime.env"
npm run start:node -- --env-file "$CHICKPEA_RUNTIME_ENV"
```

In the second Terminal, start the named tunnel.

```sh
cloudflared tunnel --config "$HOME/.cloudflared/chickpea-node.yml" run chickpea-node
```

Both commands must remain running. Keep the Mac awake. Closing either Terminal,
logging out, restarting, or allowing the Mac to sleep interrupts service.
If you use another tunnel or reverse proxy, keep that process or service running
instead of `cloudflared`.

## 7. Install your Slack app and choose a model

With Chickpea and the tunnel running, open the private setup link from a third
Terminal:

```sh
CHICKPEA_SETUP_OUTPUT="$HOME/Library/Application Support/Chickpea/node/setup-link.txt"
open "$(tail -n 1 "$CHICKPEA_SETUP_OUTPUT")"
```

Follow [the customer-owned Slack app setup](SETUP_AGENT.md):

1. Choose **Create the Slack app** and provide a short-lived Slack configuration
   token. Chickpea creates the app from its reviewed manifest.
2. Install the app in the intended workspace and verify the Events URL.
3. Sign in with Slack to become the first Owner.
4. Choose a provider and model. Provider credentials can be stored in Settings.
5. Send a real direct message to `@Chickpea` and confirm that it replies.

This flow uses Slack's HTTP Events API through your HTTPS tunnel. It does not
need an app-level `xapp-` token. After setup succeeds, remove the saved URL:

```sh
rm "$HOME/Library/Application Support/Chickpea/node/setup-link.txt"
```

The setup page can configure Anthropic, OpenAI, OpenRouter, or REST-based
Cloudflare Workers AI. A Node installation cannot use a Worker-only binding.

For OpenAI chat, you can connect a ChatGPT subscription in **Settings → Model
providers → OpenAI**. Follow the device sign-in instructions using the account
whose subscription you want to use. OpenAI may require enabling device code
authorization for Codex in that account's security settings. Subscription usage
shares that account's limits. Chickpea never switches to API billing automatically.
For images, Flare and Sunburst require a separate OpenAI API key. **ChatGPT
Image** uses the connected subscription independently of the selected chat
authentication method; it generates one image per call and does not edit
images. ChatGPT chooses its output settings. Saving an API key does not change
your selected chat authentication method.

## Operate the installation

### Check status

Check the local listener, the public HTTPS route, and Cloudflare's tunnel
record. Replace the public origin with your installation's origin.

```sh
curl --fail --silent --show-error --output /dev/null \
  http://127.0.0.1:3000/admin && echo 'Chickpea local HTTP is reachable'

CHICKPEA_PUBLIC_ORIGIN='https://chickpea.example.com'
curl --fail --silent --show-error --output /dev/null \
  "$CHICKPEA_PUBLIC_ORIGIN/admin" && echo 'Chickpea public HTTPS is reachable'

cloudflared tunnel info chickpea-node
```

Reachability checks do not prove Slack delivery. A real Slack reply is the
end-to-end check. Skip the `cloudflared` status command if you use another
tunnel or reverse proxy.

### Stop

Press Control-C once in the Chickpea Terminal and wait for the process to exit.
The launcher drains background work and Flue with a 60-second shutdown deadline.
Then press Control-C in the tunnel Terminal. Do not use `kill -9` during normal
operation.

### Restart

Start the same built release with the same `runtime.env`, then start the same
tunnel. Do not rerun the state-generation script, replace
`CHICKPEA_AUTH_SECRET`, or create another tunnel. After a planned restart,
confirm the local and public status checks, a real Slack reply, and existing
state in Admin.

This guide does not install a LaunchAgent or another supervisor. For unattended
operation you must choose and maintain a macOS supervisor separately. The
production launcher and backup details are documented in
[Operating and upgrading Chickpea](docs/runbooks/operations.md).
