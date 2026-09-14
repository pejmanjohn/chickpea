# Meta Ads

Chickpea connects to Meta's official Ads MCP server at
`https://mcp.facebook.com/ads`. Each installation uses its own Meta developer
app. Chickpea does not operate a shared Meta app or require Composio for this
connector.

## Configure the installation

1. Follow [Meta's Ads MCP setup guide](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started)
   to configure a developer app for Ads MCP and Facebook Login for Business.
2. In Chickpea, open **Settings → Connectors → Meta Ads**. Copy the displayed
   callback URL into the app's valid OAuth redirect URIs. Both Admin and
   Slack-assisted setup use that exact callback.
3. Save the public **Meta App ID** in Chickpea. No app secret is required by
   this connector. Only a Chickpea owner or admin can change this setting.
4. Open an Agent's **Connections** tab, add **Meta Ads**, choose Personal or
   Team ownership, and sign in to Meta.
5. Review the ad account IDs and tools that Agent may use. Sign-in alone grants
   no tools. Only reviewed reporting tools whose discovered inputs support an
   exact ad account restriction are available. Campaign creation, editing and
   activation are not currently supported.

Use the deployment's stable public HTTPS origin. Callback paths generated for
individual setup sessions do not need to be registered separately. Localhost
registrations do not authorize callbacks to a deployed installation.

A self-hosted installation still needs its own Meta app. Meta's eligibility,
app roles, business verification and review requirements apply. An app for your
own business and a service accessing other businesses have different review
requirements; see [Meta's guidance](https://developers.facebook.com/blog/post/2026/07/16/meta-ads-mcp-server/)
before offering access to other businesses.

## Reconnect and change access

Changing or removing the installation App ID requires accounts using the old
configuration to sign in again. Saving the same App ID preserves existing
connections. Old callbacks and refresh responses cannot restore the prior app's
authorization after a change.

Rediscovery retains only previously selected tools whose input schemas remain
unchanged. Newly discovered tools require another review. Disconnecting the
Chickpea connection removes its local authorization; it does not revoke the
Meta app globally or change access used by other applications.
