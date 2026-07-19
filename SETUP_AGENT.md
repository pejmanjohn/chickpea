# Slack setup runbook — for an AI agent (or a careful human)

This walks the Slack side of a Chickpea install: create the app, install it,
and hand two values back to `/admin`. It exists because two steps confuse
everyone: the bot token **does not exist** until the app is installed, and
Slack's console offers three other token-shaped strings that are wrong for the
normal HTTP Events API setup.

**What you need before starting:** the Chickpea `/admin` URL (printed at the
end of the deploy: `https://<worker>.<subdomain>.workers.dev/admin`), the
`TAG_ADMIN_TOKEN` chosen at deploy time, and — critically — the name of the
**Slack workspace the bot should live in**.

**If you are an AI agent:** confirm the target workspace with your human
before step 2; it is the one choice that cannot be corrected later without
reinstalling. Let your human paste secrets if your environment's policy
prefers that; everything else is clicking.

## Steps

1. **Open the manifest link.** In `/admin` (sign in with the
   `TAG_ADMIN_TOKEN`), click **Create your Slack app**. It opens Slack's app
   console with a manifest that pre-fills everything, including this
   install's events URL. (No `/admin` access? `https://api.slack.com/apps` →
   **Create New App** → **From a manifest**, and paste the repo's
   `slack-app-manifest.json` — but then you must edit
   `settings.event_subscriptions.request_url` to
   `https://<your-worker>/channels/slack/events` yourself. The `/admin` link
   does that substitution for you; prefer it.)

2. **Pick the workspace — carefully.** Slack forces a "Pick a workspace"
   choice during creation. Choose the workspace the bot should answer in.
   An app created in the wrong workspace will install, validate, and then
   silently never hear a mention from the right one.

3. **Create the app.** Review the manifest preview → **Next** → **Create**.
   The app now exists — but it is **not installed** and has **no bot token
   yet**. Do not hunt for a token on this screen; there isn't one.

4. **Install it.** Left sidebar → **OAuth & Permissions** → **Install to
   Workspace** → **Allow**. Only now does the **Bot User OAuth Token**
   appear at the top of that same page. It starts with `xoxb-`. Copy it.

5. **Copy the signing secret.** Left sidebar → **Basic Information** →
   **App Credentials** → **Signing Secret** → **Show** → copy.

6. **The traps — do not copy these:**
   - **App-Level Token** (`xapp-…`) — wrong for `/admin` and the normal HTTP
     Events API setup. It is used only by the optional local-development Socket
     Mode bridge documented in `README.md`.
   - **Verification Token** — deprecated by Slack. Wrong value.
   - **Client Secret** — OAuth-flow plumbing. Wrong value.
   Chickpea wants exactly two values: the `xoxb-…` bot token and the
   Signing Secret.

7. **Paste both into `/admin`** → Connect Slack → **Validate & save**. The
   token is validated live against Slack before anything is stored. On
   success the admin names the connected workspace — **check it matches the
   workspace from step 2**. If it names the wrong one, delete the app in
   Slack's console and restart from step 1; do not proceed.

8. **Add a channel.** In `/admin`, add the channel the bot should answer in
   (the picker lists channels by name). Chickpea joins an assigned public
   channel automatically. For a private channel, invite the bot first with
   `/invite @Tag`, then refresh the picker and add it.

9. **Verify.** Mention `@Tag` in the assigned channel with any question. One
   streamed reply should arrive in a thread, footed with the profile and
   model that answered. If nothing arrives within a minute: `/admin` shows
   the connection state, and `npx wrangler tail <worker-name>` shows each
   event's outcome live.
