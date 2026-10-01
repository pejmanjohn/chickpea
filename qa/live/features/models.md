# Models, providers and images

Docs: `/agents/models-and-providers/`. Record areas: `providers`. Legacy contracts: none.

## What it covers

- Four providers: Anthropic, OpenAI (Platform API keys only), OpenRouter, and Cloudflare Workers AI, which is keyless through the Worker's binding and absent on Node. Models are written `<provider>/<model>`.
- An environment key wins and shows as Environment managed, with no Change or Remove. Otherwise a key saved in Settings → Model providers is validated with the provider first and reaches Agents within 5 seconds.
- A turn runs on the Agent's pin, else the workspace Default model. `@Chickpea` is never pinned. A pin change applies to new threads; a default change applies to the next admitted message.
- The picker shows live Anthropic and OpenAI lists plus catalog entries, and only starred OpenRouter and Workers AI models. The Workers AI toggle hides `cloudflare/*` models without touching saved pins.
- The model catalog is hosted (refreshed about every 6 hours) or bundled, shown as the Compatibility rules line with Refresh. A failed refresh keeps the last good list.
- Image role: Default image model, overridable on an Agent's Model tab. Agents with it filled get the image tool; Flare and Sunburst use the OpenAI key and can edit images posted in the thread. Clearing it removes the tool on the next request.
- Coding role: Default coding model, for the Cloudflare coding sandbox only. Unset means coding workspaces use each Agent's own model.
- Nothing switches models automatically. A new catalog model is a manual pick, and no update changes a saved default or pin.
- A fresh Cloudflare install seeds `cloudflare/@cf/zai-org/glm-4.7-flash`; a fresh Node install seeds no default.

## How a person reaches it

- Admin: Settings → Model providers (Owner or Admin) for provider cards, the three defaults and the catalog line; an Agent's Model tab for pins.
- Slack: every reply runs on the resolved model. Ask an Agent with the image role to make an image, or to edit one posted in the thread.
- MCP: `inspect_workspace` shows provider availability. `prepare_provider_setup` (Owner or Admin) returns a requester-bound key link; `remove_provider_credential` is confirmation-gated. The image role is Admin-only.

## How to drive it on a lane

- Read the lane's models from `npm run env -- capabilities all`, Settings → Model providers, or the model footer of a one-word Agent reply. Test on the lane's configured model unless the request names others.
- Lane provider keys come from the lane secrets file through the guarded deploy, so they read as Environment managed. Verifiers never type a key; the Admin add-key flow needs a provider with no environment key and a person.
- Before changing a default or role, register it with `record resource --ownership restore --expected-file` holding the model id. Never pin the role revision: it is a monotonic counter, so cleanup could never verify.
- Case shape: `case-add --area providers --proof slack --proof admin`. Add `--proof model` only for a separately graded model-only judgment.
- Requests: "<run marker> make a square image of a lighthouse"; post a small logo and ask for an ad that keeps it; with the image role unset, ask for an image.
- Variants: the unset role gets an honest reply naming Settings → Model providers → Default image model; a pinned run Agent answers in a new thread on its pin; `prepare_provider_setup` for an environment-managed provider returns `invalid_request`.
- Cleanup: archive run Agents and restore each changed default, role or pin by value.

## Proof and gotchas

- Admin proof is the saved value plus its notice, for example "Default image model saved. Agents use it on their next request." Confirm the notice; a select that never fired its change event saves nothing.
- A weak default model can fail in ways that look like product bugs. Grade those `model`; do not substitute a stronger model silently.
- The image path once failed only under workerd, through a fetch option Node accepts. Node-only tests never prove the deployed image path.
- Workers AI `gpt-oss` models can emit raw Harmony framing as content. Any `<|channel|>` marker or analysis text that reaches Slack fails the case as `product`.
- OpenRouter tiers can require provider-account settings and answer 403 or 404 until they are set. That is the provider account, not Chickpea.
- A hosted catalog that names a profile the install does not compile is rejected whole. `npm run verify:model-catalog:served` checks what is hosted; after any Refresh, confirm every pin and the default are unchanged.
- Image generation and inspection costs are not yet in Usage, so a Usage readback cannot prove an image call.
