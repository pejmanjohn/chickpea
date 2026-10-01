# Cloud sessions (dormant)

Dormant since 2026-09-25. A cloud session cannot claim a lane, because claims
live only in the host's environment registry, and it could not watch Slack
live, which is why cloud lanes were dropped. This page keeps the setup in case
cloud runs return. Unless a run uses it, remove this page and the cloud-only
tooling (`scripts/cloud-session-start.sh`, `scripts/cloud-private-home.mjs` and
the repository `.mcp.json` lane entries) after 2026-10-31.

## Lane browsers

A Claude Code cloud session has none of the host-configured servers in
[hosts.md](hosts.md#lane-browsers), so
the repository's `.mcp.json` defines the same three servers, `chrome-amber`,
`chrome-cobalt` and `chrome-violet`, each as
`node scripts/lane-browser.mjs serve <lane> --root ${CHICKPEA_LANE_CHROME_ROOT}`.
They are opt-in: the launcher refuses to start until `CHICKPEA_LANE_CHROME_ROOT`
names an absolute, owner-only directory outside the repository, so the file is
inert on a host that never set it. Set the variable in the cloud environment
(for example `/root/.chickpea/browsers`); the launcher creates the root and one
profile directory per lane under it with owner-only permissions. Start the
session at the repository root, where the relative script path resolves. On a
Mac the project entry and the user-scope entry end up in the same place: both
attach to the lane daemon, and `serve` also starts it when it is stopped. An
approved project entry replaces the user-scope one and needs
`CHICKPEA_LANE_CHROME_ROOT` set (the maintainer's user settings set it);
without the variable it fails to start, and Claude Code lists the duplicate
definition as a diagnostic, which is expected. `verify:hygiene` accepts
`.mcp.json` only in exactly this shape.

`serve` seeds the profile when a new cookie payload is present, starts the
lane daemon unless one already answers on its port, and attaches
`chrome-devtools-mcp` to it. The daemon is the environment's Chromium
(`CHICKPEA_LANE_CHROME_EXECUTABLE`, default `/opt/pw-browsers/chromium`; a
Playwright browsers directory or build directory resolves to its binary),
`--headless` whenever Linux has no display (`CHICKPEA_LANE_CHROME_HEADLESS=0`
forces a window), and `--no-sandbox` only when it runs as root. Puppeteer's
basic password store stays on Linux, where it is the only cookie store, so the
macOS keychain exemption in [hosts.md](hosts.md#lane-browsers) does not apply there. The server comes from
`node_modules/chrome-devtools-mcp` when it is installed, otherwise from
`npx chrome-devtools-mcp@1.10.1` (`CHICKPEA_LANE_CHROME_SERVER` names another
spec or an absolute entry point).
`npm run lane:browser -- serve <lane> --dry-run` prints the attach plan, the
daemon state and launch arguments, and the seed status as JSON without
starting the daemon; a new cookie payload is still seeded, which launches a
short headless Chromium. `serve` seeds, may wait up to 20 s for the daemon,
and may install the server through npx before it answers the MCP handshake,
so install `chrome-devtools-mcp` from the lockfile or raise the host's MCP
startup timeout (`MCP_TIMEOUT` in Claude Code) if the server is reported as
failed to start.

Network: the environment must allow `slack.com` and `*.slack.com` (the web
client, `edgeapi`, `files`), `*.slack-edge.com` (the client's static assets,
without which app.slack.com never boots), `*.workers.dev` together with every
lane Admin origin from the private lane matrix, `api.cloudflare.com` for
Wrangler, and `registry.npmjs.org` unless `chrome-devtools-mcp` is installed
from the lockfile. All traffic passes through the session proxy, which does
not upgrade WebSocket connections. Slack's real-time channel therefore never
connects: the client shows a reconnecting state, new messages appear only
after a fresh navigation, and presence, typing indicators and live thread
updates are unavailable. Read threads by URL and poll them as in the
[hosts.md](hosts.md#lane-browsers) recipe; nothing in this workflow depends on the socket. Admin pages load
normally.

Profiles are seeded from cookies, not by signing in. Slack's web sign-in needs
an email code, which the transcript must never relay, and a proxy-injected
`Cookie` header (an environment credential on some plans) cannot be verified
from inside the sandbox and would collide with the cookies Chromium sends
itself. Instead the maintainer exports each signed-in lane profile once, on
the Mac, with that lane's Chrome quit:

```sh
npm run lane:browser -- export amber --root "$HOME/.chickpea/browsers" \
  --to-file "$HOME/.chickpea/lane-cookies/amber.b64" --host <lane-admin-host>
```

The file is owner-only base64 of a `chickpea-lane-cookies/v1` document: the
profile's `slack.com` cookies plus every `--host` given, such as the lane
Admin host so Admin stays signed in (without it, sign in to Admin through
Sign in with Slack inside the seeded profile). The command reports cookie
names, domains, sizes and a digest; it never prints a value, and there is no
stdout mode. Paste the file's content into the cloud environment variable
`CHICKPEA_LANE_COOKIES_AMBER` (`_COBALT`, `_VIOLET` likewise; environment
variables are readable only by that environment's users), then delete the
file. The next `serve` imports the payload into the fresh profile over the
DevTools pipe, checks the readback by name and domain, quits Chromium so the
profile is written, and stores `chickpea-lane-seed.json` in the profile with
the payload digest, cookie names and domains. Cookies without an expiry are
skipped, because Chromium drops them at exit. Neither the browser nor the
server child inherits any `CHICKPEA_LANE_COOKIES_*` variable, and no value
reaches stdout, stderr, the marker, a run record or an error: a payload that
fails validation is reported by cookie position and field.

Rotation: export again and replace the variable. The changed digest makes the
next `serve` reseed on its own; `npm run lane:browser -- import <lane> --replace`
does it immediately inside a running session. Record the export date per lane
in the hand-written part of the private lane matrix. Revocation: on the lane's
Slack account, sign out of all other sessions from the account settings page,
which invalidates the exported session everywhere; remove the variable from
the environment; delete the cloud profile root. A cookie value that appears in
any transcript or record is a leaked secret: stop using it, revoke, re-export.

## Private files

Claude Code cloud sessions start from a fresh VM that carries only
environment variables, so the cloud SessionStart hook
(`scripts/cloud-session-start.sh`) runs `scripts/cloud-private-home.mjs` to
write the same files there, at the paths the readers already use, from
base64 variables in the personal cloud environment: `CHICKPEA_QA_SECRETS_ENV_B64`
for `~/.chickpea/qa-secrets.env`, `CHICKPEA_LANE_CREDENTIALS_B64` for the
`<lane>-live.json` and `<lane>-seed.json` files under
`~/.chickpea/lane-credentials/` (one JSON object keyed by file name, described in
[environments.md](environments.md)), and `CHICKPEA_QA_SEED_JSON_B64` for `~/.chickpea/qa-seed.json`. Run
`node scripts/cloud-private-home.mjs encode` on the maintainer's machine to
print those lines from the existing files, paste them into the cloud
environment's variables, and discard the output: it carries the secrets. The
hook writes only when `CLAUDE_CODE_REMOTE=true`, skips an absent variable,
fails the session start on a malformed one (naming the variable, never the
value), checks each file with its reader before it lands, and writes it
owner-only. Live-authority credentials may instead stay as
`CHICKPEA_ENV_<COLOR>_LIVE_AUTHORITY_URL` and `_READ_TOKEN`, which need no
file. The environment registry is host-bound and is never carried this way.
