# Meta Ads

Chickpea connects to Meta's official Ads MCP server at
`https://mcp.facebook.com/ads`. Each installation uses its own Meta developer
app. Chickpea does not operate a shared Meta app or require Composio for this
connector.

## Configure the installation

1. [Create a Meta app](https://developers.facebook.com/apps/creation/). Under
   **Ads and monetization**, choose the **Create & manage ads with ads MCP
   server** use case. The use case adds Facebook Login for Business. A
   business portfolio is needed only when the app reaches ad accounts your
   business does not own or manage. [Meta's Ads MCP setup guide](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started)
   has the full flow. Chickpea requests `ads_mcp_management` and `ads_read`
   for reporting. Choosing **Reporting and editing** instead requests
   `ads_mcp_management` and `ads_management`.
2. In Chickpea, open **Settings → Connectors → Meta Ads** and copy the
   callback URL. In the Meta app, open **Facebook Login for Business →
   Settings** and paste it into **Valid OAuth Redirect URIs** under **Client
   OAuth settings**. It must match exactly. Both Admin and Slack-assisted setup
   use that callback.
3. Copy the App ID from the top of the app dashboard and save it in Chickpea.
   No app secret is required by this connector. Only a Chickpea owner or admin
   can change this setting.
4. Open an Agent's **Connections** tab, add **Meta Ads**, choose Personal or
   Team ownership, choose reporting or reporting and editing access, and sign
   in to Meta.
5. Review the ad account IDs and tools that Agent may use. Sign-in alone grants
   no tools. Reporting tools require an exact ad account restriction. Meta's
   account-queryability and reporting-field helpers are separate, unchecked
   choices; the account helper returns only the approved accounts. Write tools
   are also unchecked until explicitly selected. Some tools, including
   Instagram boosting, can require additional Meta permissions and remain
   unavailable when the signed-in token does not have them.

A new Meta app starts in Development mode, and only people with a role on the
app (Admin, Developer, or Tester) can grant its permissions. Add each person
who will sign in from Chickpea to the app first.

Reporting tools answer for one approved ad account per call. Besides
campaign reporting and insights, they cover the account's custom audiences
and custom conversions. Their optional filters for particular campaigns, ads
or datasets stay unavailable, so each answers for the whole account. Meta's
account activity log (`ads_account_get_activity_logs`) is not offered: the
Agent's turn failed right after its result in testing.

The tool catalog is gated by the schemas returned by the latest Meta discovery.
Chickpea shows only tools whose current schemas pass its safety checks. The
current catalog supports changes to existing ad sets through
`ads_update_entity`; `ads_create_ad_set` remains unavailable because its
creation schema has not been validated. Reconnect to refresh the catalog after
Meta changes its schemas.

Before changing an existing object or creating an ad or ad set under a parent,
Chickpea uses the same OAuth token for a read-only Graph API v26 lookup of the
object's `id` and `account_id`. The write is blocked before the MCP call unless
that ownership matches an approved ad account. Other creations must name an
approved account. Audience operations whose MCP input has no ad account use
the connection's internal approved-account scope for the same check. Selecting
a write tool grants the Agent access to it; Chickpea instructs the model to make
only requested changes, but does not add an automatic confirmation to every
write call.

Meta's update service has been observed to pause an active campaign during a
budget decrease even when the request contains only the budget. Chickpea blocks
budget changes to active entities through `ads_update_entity` before sending the
write. Change those budgets in Ads Manager. Chickpea does not reactivate an
entity automatically after an unexpected pause.

The helpers may request bounded correlation, advertiser-request, or reporting
field-name inputs. These are provider metadata, not ad-account selectors. The
account helper may also advertise optional pagination inputs, but Chickpea does
not expose those to the Agent. Its first response must be complete; a paginated
or otherwise unfamiliar account response fails closed without exposing other
accounts. Meta currently describes account results as pages of up to 50, so an
installation with more than 50 visible ad accounts cannot use this helper until
bounded pagination is supported.

Use the deployment's stable public HTTPS origin. Callback paths generated for
individual setup sessions do not need to be registered separately. Localhost
registrations do not authorize callbacks to a deployed installation.

A self-hosted installation still needs its own Meta app. Meta's eligibility,
app roles, business verification and review requirements apply. An app for your
own business and a service accessing other businesses have different review
requirements; see [Meta's guidance](https://developers.facebook.com/blog/post/2026/07/16/meta-ads-mcp-server/)
before offering access to other businesses.

## Reconnect and change access

Use **Reconnect for reporting** or **Reconnect for reporting and editing** in
the account's menu to refresh Meta permissions or its tool catalog. Reconnect
does not silently increase an existing connection's access. The Agent cannot
use the account until sign-in completes. If you cancel at Meta, use **Sign in**
to finish connecting again.

Changing or removing the installation App ID requires accounts using the old
configuration to sign in again. Saving the same App ID preserves existing
connections. Old callbacks and refresh responses cannot restore the prior app's
authorization after a change.

Rediscovery retains only previously selected tools whose input schemas remain
unchanged. Newly discovered tools require another review. Disconnecting the
Chickpea connection removes its local authorization; it does not revoke the
Meta app globally or change access used by other applications.

Verify reporting with a read-only request before testing changes. Actual ad
creation, editing, activation, audience changes, and deletion require an
attended manual check in an approved test account.
