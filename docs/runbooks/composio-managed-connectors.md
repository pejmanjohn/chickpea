# Composio-managed connectors

Chickpea can delegate OAuth credentials, refresh, and API execution to Composio while keeping authorization and product behavior inside Chickpea. New Gmail, Google Calendar, Google Drive, Google Sheets, Google Docs, Google Slides, Search Console, Google Analytics, and Notion connections use this managed path. Existing Native Notion connection records remain readable and editable so installations can upgrade without breaking saved Agents, but the native preset is no longer offered for new connections.

Self-hosters opt in by supplying their own Composio project key. Without that key the adapter is dormant and Chickpea's native API and MCP connection lanes continue to work.

## Security boundary

Chickpea owns:

- team versus personal ownership and account selection;
- stable per-organization or per-membership Composio user IDs;
- the capability ceiling granted to each account and Agent binding;
- write confirmation and current-member authorization;
- schedule dependency state, local revocation state, and reconnect UX;
- the small, stable tool surface exposed to the model.

Composio owns OAuth credentials, token refresh, Connect Link, and upstream Google API execution. Chickpea persists only the opaque connected-account reference and the non-secret policy. The remote principal and account reference are omitted from the durable runtime plan and model context.

Every invocation re-reads the live Chickpea account and Agent binding, pins one exact Composio account, and executes one reviewed Composio tool at a dated toolkit version. Multiple accounts that could satisfy the same tool group fail closed instead of making an implicit account choice.

## Readiness matrix

Every row requires an active project key plus its deterministic managed-auth configuration. Normal OSS setup prepares those configurations from one key in **Settings → Connectors**; lane-specific environment IDs are compatibility overrides, and the webhook is optional. Every override must belong to the active project and be enabled, Composio-managed, and unrestricted. An invalid or temporarily unverifiable override disables only that lane and emits a safe operator warning naming the environment variable; it does not disable the provider or other connectors.

| Connector/toolkit | Lanes | Admin selection | Additional hosted prerequisite |
|---|---|---|---|
| Gmail / `gmail` | Read, write | Exact team or personal account | Accept broad managed-app grant for launch |
| Calendar / `googlecalendar` | Read, write | Exact team or personal account | Accept broad managed-app grant for launch |
| Drive / `googledrive` | Read, write | Exact team or personal account | Accept broad managed-app grant for launch |
| Sheets / `googlesheets` | Read, write | Exact team or personal account | Disposable artifact canary |
| Docs / `googledocs` | Read, write | Exact team or personal account | Disposable artifact canary |
| Slides / `googleslides` | Read, write | Exact team or personal account | Disposable artifact canary |
| Search Console / `google_search_console` | Read | One or more sites | Selected/unselected resource denial canary |
| Analytics / `google_analytics` | Read | One or more GA4 properties | Selected/unselected resource denial canary |
| Notion / `notion` | Read, write | Provider OAuth page/database picker | Sibling-denial acceptance is a launch gate |
| HubSpot / `hubspot` | Read, write | Exact portal | Accept managed-app warning; triggers remain off |
| Gong / `gong` | Read | One or more workspaces | Accept documented company-wide endpoints |
| Google Ads / `googleads` | Read, write | One or more non-manager clients | Basic/Standard token plus permissible-use declaration |
| YouTube / `youtube` | Read, write | One or more channels; writes require one unambiguous actor | Quota/audit posture; expect managed-app shared quota |

## Curated Google surface

Each Google service is a separate connection and consent flow. Choosing **Read and write** adds the write capabilities to the read capabilities; it does not expose the rest of the Composio toolkit.

| Service | Chickpea capability | Composio tool | Model tool |
|---|---|---|---|
| Gmail | `gmail.profile.read` | `GMAIL_GET_PROFILE` | `gmail_get_profile` |
| Gmail | `gmail.messages.search` | `GMAIL_FETCH_EMAILS` | `gmail_search_messages` |
| Gmail | `gmail.drafts.create` | `GMAIL_CREATE_EMAIL_DRAFT` | `gmail_create_draft` |
| Gmail | `gmail.messages.send` | `GMAIL_SEND_EMAIL` | `gmail_send_message` |
| Calendar | `calendar.calendars.list` | `GOOGLECALENDAR_LIST_CALENDARS` | `google_calendar_list_calendars` |
| Calendar | `calendar.events.list` | `GOOGLECALENDAR_EVENTS_LIST` | `google_calendar_list_events` |
| Calendar | `calendar.events.create` | `GOOGLECALENDAR_CREATE_EVENT` | `google_calendar_create_event` |
| Calendar | `calendar.events.update` | `GOOGLECALENDAR_PATCH_EVENT` | `google_calendar_update_event` |
| Calendar | `calendar.events.delete` | `GOOGLECALENDAR_DELETE_EVENT` | `google_calendar_delete_event` |
| Drive | `drive.files.search` | `GOOGLEDRIVE_FIND_FILE` | `google_drive_search_files` |
| Drive | `drive.files.metadata` | `GOOGLEDRIVE_GET_FILE_METADATA` | `google_drive_get_file_metadata` |
| Drive | `drive.files.read` | `GOOGLEDRIVE_PARSE_FILE` | `google_drive_read_file` |
| Drive | `drive.files.create` | `GOOGLEDRIVE_CREATE_FILE_FROM_TEXT` | `google_drive_create_text_file` |
| Sheets | `sheets.spreadsheets.search` | `GOOGLESHEETS_SEARCH_SPREADSHEETS` | `google_sheets_search` |
| Sheets | `sheets.spreadsheets.metadata` | `GOOGLESHEETS_GET_SPREADSHEET_INFO` | `google_sheets_get_metadata` |
| Sheets | `sheets.values.get` | `GOOGLESHEETS_VALUES_GET` | `google_sheets_get_values` |
| Sheets | `sheets.tables.query` | `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW` | `google_sheets_lookup_row` |
| Sheets | `sheets.spreadsheets.create` | `GOOGLESHEETS_CREATE_GOOGLE_SHEET1` | `google_sheets_create` |
| Sheets | `sheets.values.update` | `GOOGLESHEETS_VALUES_UPDATE` | `google_sheets_update_values` |
| Sheets | `sheets.values.append` | `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` | `google_sheets_append_values` |
| Sheets | `sheets.rows.upsert` | `GOOGLESHEETS_UPSERT_ROWS` | `google_sheets_upsert_rows` |
| Sheets | `sheets.sheets.add` | `GOOGLESHEETS_ADD_SHEET` | `google_sheets_add_sheet` |
| Docs | `docs.documents.search` | `GOOGLEDOCS_SEARCH_DOCUMENTS` | `google_docs_search` |
| Docs | `docs.documents.get` | `GOOGLEDOCS_GET_DOCUMENT_BY_ID` | `google_docs_get` |
| Docs | `docs.documents.text` | `GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT` | `google_docs_get_text` |
| Docs | `docs.documents.export_pdf` | `GOOGLEDOCS_EXPORT_DOCUMENT_AS_PDF` | `google_docs_export_pdf` |
| Docs | `docs.documents.create` | `GOOGLEDOCS_CREATE_DOCUMENT` | `google_docs_create` |
| Docs | `docs.documents.create_markdown` | `GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN` | `google_docs_create_markdown` |
| Docs | `docs.documents.insert_text` | `GOOGLEDOCS_INSERT_TEXT_ACTION` | `google_docs_insert_text` |
| Docs | `docs.documents.update_markdown` | `GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN` | `google_docs_update_markdown` |
| Docs | `docs.documents.update_section_markdown` | `GOOGLEDOCS_UPDATE_DOCUMENT_SECTION_MARKDOWN` | `google_docs_update_section` |
| Slides | `slides.presentations.get` | `GOOGLESLIDES_PRESENTATIONS_GET` | `google_slides_get_presentation` |
| Slides | `slides.pages.get` | `GOOGLESLIDES_PRESENTATIONS_PAGES_GET` | `google_slides_get_page` |
| Slides | `slides.pages.thumbnail` | `GOOGLESLIDES_GET_PAGE_THUMBNAIL2` | `google_slides_get_thumbnail` |
| Slides | `slides.presentations.create` | `GOOGLESLIDES_CREATE_PRESENTATION` | `google_slides_create` |
| Slides | `slides.presentations.create_markdown` | `GOOGLESLIDES_CREATE_SLIDES_MARKDOWN` | `google_slides_create_markdown` |
| Slides | `slides.presentations.copy_template` | `GOOGLESLIDES_PRESENTATIONS_COPY_FROM_TEMPLATE` | `google_slides_copy_template` |
| Slides | `slides.presentations.batch_update` | `GOOGLESLIDES_PRESENTATIONS_BATCH_UPDATE` | `google_slides_update` |

Gmail search omits bodies, snippets, previews, raw payloads, and attachment data unless the model explicitly requests body access. Artifact searches return compact ID/title/link metadata. Sheets ranges and Markdown are bounded, and Slides accepts only reviewed create-slide, insert-text, and replace-all-text operations. Composio's deprecated Sheets batch update, SQL-like table query, arbitrary batch bodies, sharing, and delete tools are absent. Write and destructive tools pass through Chickpea's side-effect policy. Connector output is size-bounded before it returns to the model.

### Growth analytics resource boundary

Search Console and Google Analytics are read-only and resource-scoped. OAuth completion alone leaves the connection pending with no Agent tools. An Admin must choose one or more provider-discovered Search Console sites or GA4 properties. Chickpea stores opaque local handles plus safe labels; it does not expose the provider site URL, property ID, connected-account reference, or principal to the Agent. The provider adapter resolves a selected handle and inserts the real resource reference immediately before an exact-account call. An unknown, removed, or unselected handle fails before dispatch.

| Service | Chickpea capability | Composio tool | Model tool |
|---|---|---|---|
| Search Console | `search_console.sites.get` | `GOOGLE_SEARCH_CONSOLE_GET_SITE` | `google_search_console_get_site` |
| Search Console | `search_console.sitemaps.list` | `GOOGLE_SEARCH_CONSOLE_LIST_SITEMAPS` | `google_search_console_list_sitemaps` |
| Search Console | `search_console.sitemaps.get` | `GOOGLE_SEARCH_CONSOLE_GET_SITEMAP` | `google_search_console_get_sitemap` |
| Search Console | `search_console.urls.inspect` | `GOOGLE_SEARCH_CONSOLE_INSPECT_URL` | `google_search_console_inspect_url` |
| Search Console | `search_console.analytics.query` | `GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY` | `google_search_console_query_analytics` |
| Google Analytics | `analytics.properties.get` | `GOOGLE_ANALYTICS_GET_PROPERTY` | `google_analytics_get_property` |
| Google Analytics | `analytics.metadata.get` | `GOOGLE_ANALYTICS_GET_METADATA` | `google_analytics_get_metadata` |
| Google Analytics | `analytics.quotas.get` | `GOOGLE_ANALYTICS_GET_PROPERTY_QUOTAS_SNAPSHOT` | `google_analytics_get_quota` |
| Google Analytics | `analytics.reports.run` | `GOOGLE_ANALYTICS_RUN_REPORT` | `google_analytics_run_report` |
| Google Analytics | `analytics.reports.realtime` | `GOOGLE_ANALYTICS_RUN_REALTIME_REPORT` | `google_analytics_run_realtime_report` |
| Google Analytics | `analytics.reports.pivot` | `GOOGLE_ANALYTICS_RUN_PIVOT_REPORT` | `google_analytics_run_pivot_report` |
| Google Analytics | `analytics.reports.funnel` | `GOOGLE_ANALYTICS_RUN_FUNNEL_REPORT` | `google_analytics_run_funnel_report` |

Search Console site creation/deletion and sitemap submission are absent. Analytics administration, event ingestion, property/user management, and arbitrary filter bodies are absent. Date ranges are capped at 366 days; dimension, metric, row, offset, and pagination inputs are schema-bounded. When Analytics returns quota counters, the smallest remaining value is copied into connector telemetry without logging the report payload.

## Curated Notion surface

Notion uses the page/database picker in Notion's own OAuth screen as the authorization boundary. Chickpea does not maintain a second local page allowlist that could misrepresent a broader provider grant. The grant includes descendants that Notion makes available beneath the selected pages or databases. Reconnect the exact managed account to change that selection.

| Chickpea capability | Composio tool | Model tool |
|---|---|---|
| `notion.content.search` | `NOTION_FETCH_DATA` | `notion_search` |
| `notion.pages.get` | `NOTION_RETRIEVE_PAGE` | `notion_get_page` |
| `notion.pages.markdown` | `NOTION_GET_PAGE_MARKDOWN` | `notion_get_page_markdown` |
| `notion.databases.get` | `NOTION_FETCH_DATABASE` | `notion_get_database` |
| `notion.databases.query` | `NOTION_QUERY_DATABASE` | `notion_query_database` |
| `notion.data_sources.query` | `NOTION_QUERY_DATA_SOURCE` | `notion_query_data_source` |
| `notion.pages.create` | `NOTION_CREATE_NOTION_PAGE` | `notion_create_page` |
| `notion.pages.update_properties` | `NOTION_UPDATE_ROW_DATABASE` | `notion_update_page_properties` |
| `notion.pages.append_blocks` | `NOTION_ADD_MULTIPLE_PAGE_CONTENT` | `notion_append_page_blocks` |

Search and reads return bounded, normalized data. Page-property writes accept only reviewed scalar property types, and block appends accept a bounded text-oriented block vocabulary. Archive, delete, sharing, permission administration, arbitrary page updates, and raw block trees are absent. Admin may show a bounded list of provider-visible page/database labels after validation; those labels are informational and never treated as a local authorization decision.

New Notion connections use the managed path. Existing Native Notion records remain readable and editable but do not appear as a new-connection catalog option. If a legacy and managed Notion account are both attached, an unnamed Notion request withholds both account paths and asks the member to choose a label; naming one account selects only that path.

## Curated HubSpot surface

HubSpot is bound to one exact Composio connected account. During validation, Chickpea calls `HUBSPOT_GET_ACCOUNT_INFO` through that account and requires a valid portal ID. Portal/account selectors never appear in Agent input. Every later call pins the same Chickpea principal, connected-account reference, and toolkit version server-side.

| Chickpea capability | Composio tool | Model tool |
|---|---|---|
| `hubspot.account.get` | `HUBSPOT_GET_ACCOUNT_INFO` | `hubspot_get_account` |
| `hubspot.objects.search` | `HUBSPOT_SEARCH_CRM_OBJECTS_BY_CRITERIA` | `hubspot_search_objects` |
| `hubspot.objects.get` | `HUBSPOT_READ_CRM_OBJECT_BY_ID` | `hubspot_get_object` |
| `hubspot.owners.list` | `HUBSPOT_RETRIEVE_PAGE_OF_CRM_OWNERS` | `hubspot_list_owners` |
| `hubspot.pipelines.list` | `HUBSPOT_RETRIEVE_ALL_PIPELINES_FOR_SPECIFIED_OBJECT_TYPE` | `hubspot_list_pipelines` |
| `hubspot.associations.list` | `HUBSPOT_LIST_OBJECT_ASSOCIATIONS` | `hubspot_list_associations` |
| `hubspot.association_types.list` | `HUBSPOT_LIST_ASSOCIATION_TYPES` | `hubspot_list_association_types` |
| Contact/company/deal/ticket create | `HUBSPOT_CREATE_CRM_OBJECT_WITH_PROPERTIES` | Typed `hubspot_create_*` tools |
| Contact/company/deal/ticket update | `HUBSPOT_PARTIALLY_UPDATE_CRM_OBJECT_BY_ID` | Typed `hubspot_update_*` tools |
| `hubspot.notes.create` | `HUBSPOT_CREATE_NOTE` | `hubspot_create_note` |
| `hubspot.tasks.create` | `HUBSPOT_CREATE_TASK` | `hubspot_create_task` |
| `hubspot.meetings.create` | `HUBSPOT_CREATE_MEETING` | `hubspot_create_meeting` |
| `hubspot.associations.create` | `HUBSPOT_CREATE_OBJECT_ASSOCIATION` | `hubspot_create_association` |

Search is limited to contacts, companies, deals, tickets, notes, tasks, meetings, and calls. Chickpea accepts one bounded filter group, one sort, a page size of at most 100, and only the reviewed common property set for each object type. Creates and updates use typed fields that Chickpea converts to a provider property map; the model cannot submit arbitrary/custom property dictionaries. Returned records include stable IDs, selected allowlisted properties, display names, timestamps, pipeline/stage values where requested, and a pagination cursor. Every create, update, or association requires Chickpea's normal side-effect confirmation. A timeout after dispatch is ambiguous and must be verified by stable record ID/search before retrying.

Privacy/GDPR operations, archive/delete/merge, bulk and import APIs, schema and pipeline administration, workflows, marketing publication, raw API passthrough, and triggers are absent. As of 2026-08-23, Composio says its default HubSpot OAuth app is still awaiting HubSpot approval, so users may see a **Connecting an unverified app** warning. The connection can work after explicit acceptance. Composio-managed auth can remove only optional scopes already present on that app; use a custom auth config later if Chickpea needs its own approved branding or a different scope set. HubSpot triggers are intentionally disabled because Composio requires each user to provide a HubSpot app ID and developer API key, and Chickpea has no trigger-ingestion contract.

Track two upstream migration deadlines in staging canaries: HubSpot's legacy v1 OAuth endpoints are deprecated on 2027-02-16, and legacy v4 APIs become unsupported on 2027-03-30. Before either date, confirm the pinned Composio toolkit has migrated to HubSpot's supported date-based API and rerun portal validation plus disposable read/write canaries.

## Curated Gong surface

Gong is read-only and requires an Admin to select at least one provider-discovered workspace after OAuth. Until that selection is saved, the connection stays pending and no Gong tools reach Agents. Chickpea stores local opaque workspace handles and safe labels; Agent inputs never contain Gong workspace IDs, the Composio connected-account ID, or the Composio principal. The provider adapter resolves the selected local handle immediately before an exact-account call.

| Chickpea capability | Composio tool | Model tool |
|---|---|---|
| `gong.workspaces.list` | `GONG_LIST_ALL_COMPANY_WORKSPACES_V2_WORKSPACES` | `gong_list_workspaces` |
| `gong.users.list` | `GONG_LIST_USERS_V2_USERS` | `gong_list_users` |
| `gong.calls.list` | `GONG_LIST_CALLS_V2_CALLS` | `gong_list_calls` |
| `gong.calls.get` | `GONG_RETRIEVE_CALL_DETAILS_V2_CALLS` | `gong_get_call` |
| `gong.transcripts.get` | `GONG_RETRIEVE_CALL_TRANSCRIPTS_V1_CALL_TRANSCRIPTS` | `gong_get_transcript` |
| `gong.interactions.stats` | `GONG_RETRIEVE_INTERACTION_STATS_V1_STATS_INTERACTION` | `gong_get_interaction_stats` |
| `gong.coaching.metrics` | `GONG_RETRIEVE_COACHING_METRICS_V1_STATS_COACHING` | `gong_get_coaching_metrics` |
| `gong.scorecards.list` | `GONG_LIST_SCORECARDS_V2_SETTINGS_SCORECARDS` | `gong_list_scorecards` |
| `gong.scorecards.activity` | `GONG_RETRIEVE_SCORECARDS_ACTIVITY_V1_STATS_SCORECARDS` | `gong_get_scorecard_activity` |
| `gong.tasks.list` | `GONG_LIST_TASKS_V1_TASKS` | `gong_list_tasks` |
| `gong.trackers.list` | `GONG_LIST_TRACKERS_V2_SETTINGS_TRACKERS` | `gong_list_trackers` |
| `gong.call_outcomes.list` | `GONG_LIST_CALL_OUTCOMES_V2_SETTINGS_CALL_OUTCOMES` | `gong_list_call_outcomes` |

Call, coaching, interaction, and scorecard ranges are capped at 90 days. Task filters and every page/cursor are schema-bounded. Transcripts are normalized to at most 100 segments and 100,000 characters per result; text remains untrusted external content and receives no instruction authority. Connector telemetry records only sanitized result byte counts, latency, call counts, safe provider metadata, and outcomes. It never records transcript text or tool arguments.

The selected workspace is a strict Chickpea authorization gate, but several Gong company settings/statistics endpoints do not accept a workspace parameter. For those capabilities, selection does not narrow Gong's upstream response below the connected company's permissions. Treat `users`, interaction statistics, scorecard definitions/activity, and call-outcome definitions as company-visible reads gated by an Admin-selected workspace, not as proof of provider-enforced workspace isolation. Calls, transcripts, coaching, tasks, and trackers pass the selected workspace upstream where Gong supports it; call-detail responses additionally fail closed unless their returned workspace matches the selection. If a customer needs strict upstream workspace isolation for every read, omit the company-wide capabilities from that Agent binding.

User administration, permission changes, CRM registration, data/privacy deletion, raw API access, triggers, and every Gong write are absent. Toolkit version changes require contract review because Gong schemas and workspace coverage vary by endpoint.

## Curated Google Ads surface

Google Ads requires two layers of operator setup: a Composio OAuth auth config containing the Google Ads developer token, and a production-capability declaration in Chickpea. The developer token never appears in an authorization request, connection record, Agent schema, runtime plan, or tool argument. Create fresh auth configs after adding or changing the token; Composio documents that older configs created before its token-field change can fail because the token is no longer accepted at connection initiation.

After OAuth, Chickpea lists accessible roots, inspects whether each is a manager, discovers its direct subaccounts, and offers only client accounts in the resource picker. OAuth completion alone leaves the connection pending. An Admin must select one or more client customers; Chickpea stores a local handle and safe label while the numeric customer ID remains execution-only. Manager IDs are never valid Agent targets, and an unselected customer fails before dispatch.

| Surface | Chickpea capabilities | Composio tool |
|---|---|---|
| Selected account | `ads.customers.get` | `GOOGLEADS_SEARCH_STREAM_GAQL` |
| Campaign read | `ads.campaigns.get`, `ads.campaigns.report` | `GOOGLEADS_GET_CAMPAIGN_BY_ID`, `GOOGLEADS_SEARCH_STREAM_GAQL` |
| Ad group/ad/keyword performance | `ads.ad_groups.report`, `ads.ads.report`, `ads.keywords.report` | `GOOGLEADS_SEARCH_STREAM_GAQL` |
| Budgets | `ads.budgets.report`, create/update amount | Search stream plus `GOOGLEADS_MUTATE_CAMPAIGN_BUDGETS` |
| Campaign lifecycle | create paused, rename, pause, enable | `GOOGLEADS_MUTATE_CAMPAIGNS` |
| Ad group lifecycle | create paused, rename, pause, enable | `GOOGLEADS_MUTATE_AD_GROUPS` |
| Keyword lifecycle | create paused, pause, enable | `GOOGLEADS_MUTATE_AD_GROUP_CRITERIA` |
| Responsive Search ads | create paused, pause, enable | `GOOGLEADS_MUTATE_AD_GROUP_ADS` |

The model never provides GAQL. Each report builds a fixed query from a reviewed resource, fixed identity fields, an allowlist of eight metrics, a valid date range of at most 366 days, optional enabled/paused status, one allowlisted order field, and at most 500 rows. The provider customer ID is inserted after Chickpea authorization. Free-form fields, queries, summary settings, and raw operation arrays are absent.

Every create is single-entity and paused. Rename and pause are reversible writes. Campaign, ad-group, keyword, or ad enablement is external publication. Budget create/update is `spend_or_budget`; it requires the amount in micros and the selected account's three-letter currency, and Chickpea checks that currency against structured metadata captured during resource selection rather than parsing the display label. A customer whose currency is absent cannot be selected for a spend lane. The normal side-effect gate must show the selected account plus the campaign/entity/change; budget confirmation must show the currency and amount. A timeout or post-dispatch provider failure after any mutation is ambiguous: do not retry until an allowlisted report or stable resource ID proves the remote state.

Billing, user/access management, account creation, conversion upload, customer lists, labels, bidding-strategy/asset/targeting passthrough, remove/delete, partial-failure bulk mutation, raw GAQL, and arbitrary API calls are absent.

The standard path uses Composio managed OAuth and asks the user only to sign in with Google. Leave both Google Ads policy variables unset for this path: Composio's managed auth configuration owns the OAuth app and developer token, while Chickpea keeps its narrower capability and account-selection controls.

Optional Google Ads policy declarations remain fail closed when supplied:

- `COMPOSIO_GOOGLE_ADS_ACCESS_LEVEL=explorer` enables both Chickpea lanes. Google's Explorer tier allows production accounts with 2,880 operations per day. Google still prohibits account creation, user management, planning, and billing methods at this tier; none of those methods are present in Chickpea's curated connector.
- `COMPOSIO_GOOGLE_ADS_ACCESS_LEVEL=basic` or `standard` also requires `COMPOSIO_GOOGLE_ADS_PERMISSIBLE_USE`. `reporting` enables only the read lane; the write lane requires `ad_management`.
- `test` remains unavailable in a production installation because it can access only Google Ads test accounts. Unknown or partially declared policy values are also reported as `provider_prerequisite_missing`.
- Google currently documents Basic as 15,000 operations per sliding 24 hours and Standard as unlimited for most services. Basic and Standard applicants must declare a permissible-use category; Standard applications for external-user tools must be ready to provide demo access and meet Required Minimum Functionality.
- These environment values are operator assertions because Composio does not expose the developer-token tier through a connected account. Verify the tier in the Google Ads API Center before setting them. They do not enable custom auth configs: compatibility overrides must still be Composio-managed and unrestricted. Do not set them for the ordinary Composio-managed path.

As of 2026-08-23, Google lists v25 as current with a tentative August 2027 sunset, while v22 has a tentative October 2026 sunset. The Composio toolkit pin does not expose which Google Ads API version its implementation calls. For each toolkit upgrade and at least monthly, inspect the Google Cloud API method metrics for the actual `google.ads.googleads.v*` version and block release if it is on the next sunset path.

## Curated YouTube surface

YouTube remains pending after OAuth until an Admin selects at least one discovered channel. Agent schemas use only Chickpea-local channel handles; the selected upstream channel ID, Composio connected-account ID, and principal are injected server-side. Public search can return another channel's content, but those results never become management authority. Before every write, Chickpea rechecks target ownership where a target exists and requires the connected credential's `mine=true` channel list to contain exactly the selected channel. A credential that can act as several Brand channels is denied rather than guessing which identity will publish.

| Surface | Chickpea capabilities | Composio tool |
|---|---|---|
| Channel | identity/statistics and bounded activities | `YOUTUBE_LIST_CHANNELS`, `YOUTUBE_GET_CHANNEL_ACTIVITIES` |
| Videos | selected-channel list and details | `YOUTUBE_LIST_CHANNEL_VIDEOS`, `YOUTUBE_GET_VIDEO_DETAILS_BATCH` |
| Captions/comments | caption metadata and comment replies | `YOUTUBE_LIST_CAPTION_TRACK`, `YOUTUBE_LIST_COMMENTS` |
| Playlists | list, create/update, and add one item | Playlist list/create/update/item tools |
| Public discovery | bounded search | `YOUTUBE_SEARCH_YOU_TUBE` |
| Publication | comment/reply, bounded upload, metadata/visibility, thumbnail | Narrow YouTube write tools |

Every write is `external_publish`, including a private playlist or upload, because it changes a durable third-party account. Confirmation must identify the selected channel and the visibility or audience-impacting fields. Delete, account/permission administration, subscriptions, ratings, reports, bulk moderation, arbitrary caption content, raw API calls, and passthrough provider tools are absent.

Uploads accept only a model-visible `/workspace/...` reference. Chickpea freezes that file under a trusted random name, caps it at 8 MB, checks the declared MP4, WebM, or QuickTime signature, and keeps the bytes only for the invocation. The provider receives a Composio-staged object, never the model's path. A successful upload, video/thumbnail update, playlist mutation, or comment mutation is read back by stable ID before the tool reports verified success. If dispatch times out or read-back cannot prove the resource, the result is ambiguous and must never be retried automatically.

Chickpea reserves quota atomically across the whole Composio adapter/toolkit before dispatch, not per workspace. Google’s quota calculator, last updated 2026-06-01, defines three separate defaults: 10,000 general units, 100 `search.list` calls, and 100 `videos.insert` calls per Pacific-time day; search and video insert each cost one call in their own bucket rather than the older 100/1,600 general-unit schedule. Capability estimates include ownership/actor preflights and read-back calls. A request that fails local validation before any remote call releases every reservation. A failed ownership/actor preflight or Composio staging failure keeps any conservatively consumed general-unit allowance but releases a separate search/video-insert bucket whenever the capability tool provably never dispatched, regardless of the provider failure classification. Once the capability tool runs, reservations remain conservatively consumed. Exhaustion blocks before provider execution, and expired reservation rows are removed by usage retention. Raising a configured limit makes the YouTube lane unavailable until `COMPOSIO_YOUTUBE_QUOTA_AUDIT_APPROVED=true` records that the official audit/compliance process is complete.

These local reservations cannot manufacture upstream capacity. Composio warns that its managed/default YouTube OAuth app can share YouTube quota across users, so an otherwise healthy Chickpea budget can still receive an upstream quota error. The accepted launch choice is Composio's default app to minimize integration work. Before sustained production volume, use Composio custom auth with a Chickpea Google Cloud project so quota, consent branding, scopes, and quota-increase requests are controlled by Chickpea; reconnect existing accounts after changing auth configs. Also verify Google's upload audit posture: API projects that have not passed the required audit can have uploads forced private.

## Production project setup

Use separate Composio projects for development, staging, and production. Projects isolate API keys, connected accounts, auth configs, webhooks, and project settings.

1. Create the environment's Composio project. In Composio, open **Settings → Project Settings → API Keys** and create a project key with the permissions required for connected-account linking and inspection plus direct tool execution. The ordinary project key is the lowest-effort launch choice; if a scoped key is used, keep an end-to-end canary because Composio can add or reclassify endpoint permissions.

2. For a normal self-hosted installation, sign in to Chickpea as an owner or admin and open **Settings → Connectors**. Paste the project key once. Chickpea validates it, stores it in the encrypted credential store, and creates or reuses one deterministic Composio-managed auth configuration per toolkit named `Chickpea default — <toolkit> v1`. The standard flow never asks the operator to copy auth-config IDs.

3. For deployment-owned configuration, set `COMPOSIO_API_KEY` as a secret and `CHICKPEA_COMPOSIO_CONFIGURATION_MODE=deployment` as a deployment variable. **Settings → Connectors** reports the key as deployment-managed and never displays, replaces, or disables it. An owner/admin must choose **Prepare connector defaults** once after enabling this mode or upgrading a deployment that uses lane-specific `COMPOSIO_*_AUTH_CONFIG_ID` variables. Preparation verifies those optional compatibility overrides against the active project, persists only their non-secret IDs, and creates deterministic defaults for gaps; it never moves the project key into Chickpea's stored-settings lane. Until initial preparation finishes, existing connected accounts can still execute, but new managed authorizations remain unavailable. Chickpea logs the safe environment-variable names when this one-time preparation is required. Rotating `COMPOSIO_API_KEY` is different: Chickpea detects the fingerprint change, increments the provider generation, and pauses managed execution until an owner/admin retries preparation. That retry inspects every preserved connected account with the new key, restores matching accounts under the new lineage, marks accounts from another project for reconnection, and then prepares auth-config defaults for the new generation.

4. In **Project Settings → General**, leave **OAuth user verification** set to **Not configured**. Chickpea supplies an installation-specific callback URL for every Connect Link. Composio's project-wide verifier overrides that callback and is incompatible with Chickpea's shareable, first-completion-wins setup links. Use a separate Composio project for each Chickpea installation so each installation keeps its own accounts, settings, and return URLs.

5. Set execution log storage to **Don't store data** before sending customer data. Composio still receives tool arguments and upstream responses to execute calls; this setting controls retained payload logs.

6. Customize the project's Auth Screen with the Chickpea name and logo if desired. Google consent will still identify Composio's managed OAuth app unless Chickpea later brings its own verified Google OAuth app.

7. A webhook is optional. When Chickpea has a public HTTPS host, register `https://<chickpea-host>/webhooks/composio` and store its subscription secret as `COMPOSIO_WEBHOOK_SECRET` to receive expiry events sooner. Chickpea verifies the raw-body signature and accepts only the reviewed account-expiry event. Without a webhook, the hostless path still polls authorization, validates the exact account while connecting, pins that account and Chickpea principal on every execution, and moves the account to reconnection after a definitive authorization failure.

Composio-managed defaults are intentionally a development-effort tradeoff, not provider-level least privilege. The upstream Google or HubSpot grant can be broader than Chickpea's curated Agent capability ceiling. Revisit custom auth configs or Chickpea-owned OAuth credentials when customer requirements, provider approval, branding, or scale justify the work. Scope or auth-config changes affect only new grants, so reconnect affected accounts after changing them.

## Authorization and recovery flow

The Admin UI starts one hosted Connect Link for one saved Agent, connector, and team/personal owner. Chickpea derives the Composio user ID from the immutable organization or membership ID, stores a thirty-minute consume-once attempt, and keeps its browser secret in an HttpOnly, Secure, SameSite=Lax cookie. It opens the hosted sign-in in a new tab, persists only safe resume metadata in `sessionStorage`, and polls the exact request from the original Chickpea tab. Each hosted link also receives a callback URL derived from the current Chickpea installation so the provider tab returns to Chickpea's dedicated completion page. The callback does not authorize or select an account; exact-account polling remains the authority.

Each poll checks the exact pending workspace, Agent, owner, toolkit, capability ceiling, provider generation, project lineage, request ID, and server-derived principal. A pending response schedules another bounded poll. An active exact account is validated, imported, and attached once. Terminal, mismatched, expired, replayed, or stale-project results fail closed. Refreshing the Chickpea tab restores the waiting state; **Cancel** revokes only an unimported remote request and clears the local attempt.

The Connect Link request ID is the connected-account ID. Chickpea stores it before polling and accepts completion only when Composio returns that exact account, toolkit, and server-derived principal. It does not trust account or user identifiers from browser query parameters. Reconnect and additional-account flows allow multiple accounts because an active account may already exist for the same principal and default auth config; every tool execution still pins one exact account ID.

The generic reusable-connection API does not accept managed account references. Managed records can enter Chickpea only through the browser-bound Connect Link completion flow, so a member cannot import another project's or another member's opaque `ca_...` identifier.

An unknown or upgraded authorization-attempt format fails closed and emits `chickpea.managed_connection.invalid_authorization_attempt_blocked` with only any validated `adapterId`, `authorizationRef`, and `accountRef`. The member receives `managed_authorization_recovery_required` instead of being told to finish an unreachable browser flow. The durable key is `connections.managed.authorization.` followed by the first 32 hexadecimal characters of `sha256(actorMembershipId)`.

After confirming the event belongs to the affected member, a Chickpea workspace owner can reconcile it from the signed-in Admin browser console:

```js
await fetch('/admin/api/connections/managed/recover', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ actorMembershipId: 'membership_...' }),
}).then(async (response) => ({ status: response.status, body: await response.json() }));
```

This owner-only operation first preserves any reference already imported by a non-revoked Chickpea connection, deletes every other distinct validated Composio account reference with `revoke_on_delete=false`, then compare-and-set deletes the exact malformed setting. A partial provider failure preserves the setting so a retry can finish; Composio 404 responses are treated as already deleted. Success logs `chickpea.managed_connection.invalid_authorization_attempt_recovered`. If the blocked event contains no validated Composio reference, the endpoint returns 409: do not delete the setting directly, because it may be the only handle to a remote account; escalate for manual inspection.

The legacy public callback endpoint has been removed. Deployments must not configure a Composio project-level callback identity verifier for Chickpea's hostless flow, because it can make dashboard-created links behave differently. Restart any authorization that was already in flight during an upgrade from the Agent's Connections tab, then run the complete link-and-poll canary.

If authorization succeeds remotely but a later local import fails, the remote reference remains in the durable attempt so polling can retry without creating another grant. If Chickpea cannot preserve or safely import the reference, it deletes the otherwise orphaned Composio account before consuming the attempt and logs only bounded reference metadata. A reconnect preserves the Chickpea connection ID and Agent bindings. Schedules paused by an expiry remain `needs_attention` until explicitly reviewed and resumed.

Chickpea deliberately calls Composio account deletion with `revoke_on_delete=false`. Google revocation is grant-wide for a user/OAuth-client pair: the launch canary connected the same personal Calendar account twice, revoked one Composio account with `revoke_on_delete=true`, and the surviving account immediately began returning Google 401 errors. Chickpea cannot reliably identify shared grants across team and personal lanes because Composio exposes no stable non-secret upstream identity for every Google toolkit. Disconnect therefore removes the exact Composio account and its stored credential without revoking the broader Google grant. A user can revoke Composio from Google Account settings when they intend to invalidate every Chickpea connection sharing that Google OAuth client.

## Versioned execution

Chickpea uses `tools.execute()` instead of a Composio Session for production connector calls. Composio recommends Sessions for agent-selected tools, but Chickpea programmatically translates and normalizes each provider response. Direct execution is the documented path that requires and accepts a dated toolkit version on every call, which keeps those schemas stable. The adapter also fixes the Composio user ID, connected-account ID, and raw tool slug server-side; the model cannot choose them.

Current pins live in `src/connections/providers/composio/versions.ts`:

| Toolkit | Version |
|---|---|
| Gmail | `20260817_00` |
| Google Calendar | `20260812_00` |
| Google Drive | `20260815_00` |
| Google Sheets | `20260813_00` |
| Google Docs | `20260818_00` |
| Google Slides | `20260819_00` |
| Notion | `20260819_00` |
| Google Search Console | `20260806_00` |
| Google Analytics | `20260721_00` |
| HubSpot | `20260817_00` |
| Gong | `20260721_00` |
| Google Ads | `20260721_00` |
| YouTube | `20260721_00` |

Never use `latest` or `dangerouslySkipVersionCheck` in the production adapter. Upgrade one toolkit at a time:

1. Review the toolkit changelog and the dated schemas in Composio's dashboard/docs.
2. Update the version constant, provider mapping fixtures, and normalized result fixtures together.
3. Run typecheck, provider contract tests, managed runtime tests, and workerd import/execution tests.
4. Run the connector's read canary in staging. For a write connector, run one deliberately configured representative write canary and verify the remote state exactly once.
5. Inspect `/admin/api/usage/connectors` for the canary's version, outcome, call amplification, latency, rate-limit headroom, and price version.
6. Deploy only after the canary and independent review are clean. Roll back by restoring the previous mapping/version pair and rerunning its canary.

## Connector usage and cost report

Connector measurements are separate from LLM token measurements. Every attempted managed capability produces one terminal record, including local policy denial, invalid grant, provider outage, throttling, ambiguous write, or success. Stored fields are bounded metadata; arguments, results, tokens, provider account references, resource labels, and OAuth principals are excluded. Interactive calls correlate to their Work operation and execution. Scheduled calls correlate to the durable routine usage operation.

Authenticated Admins can query a bounded report:

```text
GET /admin/api/usage/connectors?from=<unix-ms>&to=<unix-ms>
GET /admin/api/usage/connectors?from=<unix-ms>&to=<unix-ms>&workspace=T...&agent=agent_...&toolkit=gmail
```

The report groups by workspace, Agent, toolkit, Chickpea capability, and outcome. It includes logical attempts, distinct connection accounts observed in the requested window, remote/provider tool-call counts, total sanitized result bytes, estimated variable cost, average latency, minimum reported rate-limit headroom, and maximum `Retry-After`. Raw connector attempts are retained for 90 days. Every response includes `retainedFrom` and `isComplete`; clients must treat `isComplete: false` as a truncated report rather than a zero-usage period. It covers Agent capability invocations only. Admin-time authorization, account validation, resource discovery and selection, reconnect, revocation, and webhook handling are excluded even when those paths call billed Composio tools. The distinct-account figure and estimated cost are therefore usage-window diagnostics, not a replacement for reconciling Composio's Connected Accounts inventory, operation logs, or invoice.

The immutable `composio-2026-08-15` price version records the current public list-price structure. A managed direct call is estimated at $0.0006 before free allowances, monthly credits, shared-connection charges, negotiated discounts, or optional add-ons. Managed connected accounts above their allowance, triggers, ZDR, white-labeling, and own-app rates remain separate price components. Chickpea never combines this estimate with model token cost. Update pricing by adding a new effective-dated version; do not rewrite historical measurements.

Composio rate limits are organization-wide, use a fixed one-minute window, and cover tool execution plus other authenticated API calls. Record `X-RateLimit-Remaining` when available. On 429, honor `Retry-After`; do not probe the account or blindly retry a write whose outcome may be ambiguous.

## Local and staged verification

The generic live verifier creates an in-memory Chickpea Agent, account, binding, and usage store, then runs one catalog capability through the production adapter. It defaults to the read-only Gmail profile canary and prints only result keys/size plus safe provider and measurement metadata. A scoped key must cover exact connected-account inspection and the selected direct tool execution; verify the complete hosted-link and polling flow separately before relying on a narrowed production key:

```bash
read -s COMPOSIO_API_KEY
export COMPOSIO_API_KEY
export COMPOSIO_USER_ID='your-stable-chickpea-user-id'
export COMPOSIO_CONNECTED_ACCOUNT_ID='ca_...'
npm run verify:composio:live
```

Select another catalog connector/capability with `COMPOSIO_CONNECTOR`, `COMPOSIO_ACCESS_LANE`, `COMPOSIO_CAPABILITY`, and `COMPOSIO_ARGUMENTS_JSON`. Resource-scoped connectors accept the same durable shape through `COMPOSIO_RESOURCE_CONSTRAINTS_JSON`. Any capability whose effect is not `read` fails before provider dispatch unless `COMPOSIO_ALLOW_WRITE_CANARY=1` is also set. Review the arguments and remote target first; the verifier emits a data-modifying warning before dispatch.

Canonical productivity canaries use the same command and an account connected to that exact toolkit:

```bash
# Safe search reads need no resource ID.
COMPOSIO_CONNECTOR=google-sheets COMPOSIO_CAPABILITY=sheets.spreadsheets.search \
  COMPOSIO_ARGUMENTS_JSON='{"query":"Chickpea canary","maxResults":5}' \
  npm run verify:composio:live

COMPOSIO_CONNECTOR=google-docs COMPOSIO_CAPABILITY=docs.documents.search \
  COMPOSIO_ARGUMENTS_JSON='{"query":"Chickpea canary","maxResults":5}' \
  npm run verify:composio:live

# Supply a disposable presentation ID for the Slides read canary.
COMPOSIO_CONNECTOR=google-slides COMPOSIO_CAPABILITY=slides.presentations.get \
  COMPOSIO_ARGUMENTS_JSON='{"presentationId":"<disposable-presentation-id>"}' \
  npm run verify:composio:live

# The Notion account must have been authorized against only a disposable test page.
COMPOSIO_CONNECTOR=notion COMPOSIO_CAPABILITY=notion.content.search \
  COMPOSIO_ARGUMENTS_JSON='{"query":"Chickpea Notion canary","pageSize":10}' \
  npm run verify:composio:live
```

Search Console and Analytics canaries use the same verifier. Set `COMPOSIO_RESOURCE_CONSTRAINTS_JSON` to a staging copy of the exact saved resource constraints, then pass only its local `siteHandle` or `propertyHandle` in `COMPOSIO_ARGUMENTS_JSON`. Use a seven-day range and at most ten rows. Never pass the upstream site URL or property ID as a model argument.

For a representative write, set `COMPOSIO_ACCESS_LANE=write`, choose one create/update capability, provide a disposable target in `COMPOSIO_ARGUMENTS_JSON`, and set `COMPOSIO_ALLOW_WRITE_CANARY=1`. Verify the remote artifact before cleanup; do not retry an ambiguous write.

Before making managed Notion the recommended path in an environment, run the complete least-privilege acceptance with two disposable sibling pages or databases:

1. Connect managed Notion from Chickpea and select only sibling A in Notion's picker.
2. Through the Agent tools, search/read sibling A, create one child page under A with confirmation, and read it back.
3. Prove sibling B is absent from search and a direct read of B is denied. The tool must not widen the grant or retry with another account.
4. Reconnect the exact managed account, select only sibling B, and prove B is readable while A is no longer readable.
5. Disconnect that exact managed account and verify only its Agent bindings are affected. Do not grant-wide revoke a shared provider credential during this check.

Record the account labels, provider log IDs, toolkit version, and pass/fail outcomes without retaining page content or provider object IDs. Treat a failed boundary check as a Notion launch blocker rather than bypassing the managed authorization boundary.

Before enabling Search Console or Analytics for customers, repeat each read canary with one selected and one accessible-but-unselected resource. The selected handle must work and the unselected handle must fail before a provider call. Exercise multi-page resource discovery, then revoke provider access to the selected site/property and verify the next call fails closed and the connection requires attention. Confirm the runtime plan still exposes no Search Console mutation or Analytics administration/event-ingestion capability.

Before enabling HubSpot for customers, connect a disposable portal and record the unverified-app warning shown during managed OAuth. Verify the returned portal identity, search a disposable contact/company/deal, page the results, and read back only requested common properties. With explicit confirmation, create and update one disposable note/task or CRM record, then verify the stable ID before any retry. Attempt an unreviewed property, another portal selector, a write without confirmation, and an excluded delete/workflow/privacy/bulk/trigger capability; each must fail before dispatch or be absent. Inspect connector usage for one provider call per operation and no CRM content in telemetry.

Before enabling Gong for customers, connect a disposable company, exercise multi-page workspace discovery, and select one workspace. Prove an unknown or accessible-but-unselected local handle fails before dispatch. List a short call window, fetch one call, and page a bounded transcript containing instruction-like text; the text must remain ordinary tool data. Confirm transcript content is absent from logs and connector usage while `totalResultBytes` increases. Exercise the company-wide reads separately and verify the Admin-facing scope warning is acceptable for that workspace. Attempt a Gong write, raw API call, permission change, and data-erasure operation; each must be absent.

Before enabling Google Ads, verify Basic/Standard access and reporting/ad-management permissible use in the API Center, then set the two readiness declarations. Connect a manager with one disposable client account and prove the manager and another accessible-but-unselected client cannot be used as action targets. Run every report family over seven days and at most ten rows. With explicit confirmation, create a disposable budget and paused Search campaign/ad group/keyword/responsive Search ad, read each stable ID, and enable only the deliberately safe test entity. Confirm budget currency/amount in the approval, then pause it and read back state. Simulate a timeout after dispatch and prove the action is reported ambiguous without retry. Inspect Cloud API metrics for the underlying Google Ads API version and the connector report for call amplification, throttling, and no query/result content. Do not run this canary against a production-spend account.

Before enabling YouTube, connect a disposable channel, select it through Chickpea, and prove a second accessible-but-unselected channel cannot be a management target. Exercise channel/video/playlist reads and one public search whose results belong to another channel; no write tool may accept that result as authority. With explicit confirmation, upload a tiny private or unlisted disposable video from `/workspace`, verify the returned ID through the automatic read-back, update metadata, create a private playlist, add the video, post only a deliberately disposable comment if appropriate, and inspect the connector report for the expected quota reservations and call amplification. Run path-escape, wrong-signature, oversize, Brand-channel ambiguity, near-exhausted quota, and simulated post-dispatch timeout cases; each must fail closed or return ambiguous without a retry. Record cleanup instructions and delete provider artifacts only through a separately approved action. Verify current Google Cloud quota/audit status and expect managed-app shared-quota errors even when Chickpea's local budget has headroom.

For local webhook testing, use Composio's signed forwarder against the real handler:

```bash
composio dev triggers listen --forward "http://localhost:8787/webhooks/composio"
```

Before enabling a customer workspace, prove in staging:

- read-only and read/write consent for every enabled Google service;
- personal and team ownership, including two Google accounts for one member;
- wrong-user polling rejection, stale-project rejection, and completion replay rejection;
- expired-account webhook, fail-closed tool calls, reconnect-in-place, and schedule review;
- exact remote-account deletion, duplicate-account survivor behavior, provider outage behavior, result redaction, and side-effect confirmation;
- p50/p95 connector latency, Composio operation volume, rate-limit headroom, and hosted cost from the connector usage report.

## Operational limits

- The adapter exposes only reviewed Chickpea capabilities. Do not turn the full Composio catalog into an unreviewed model tool catalog.
- The exact `@composio/core` SDK and every parsed toolkit version are pinned. Contract tests and a staged canary are required before upgrading either or widening capabilities.
- Direct `tools.execute()` adds Composio's direct-execution unit price after its allowance. Chickpea accepts that charge so programmatically parsed schemas stay pinned and exact-account execution remains explicit.
- Composio allocates a connected account before returning its ID, so an isolate loss in that narrow response-before-persistence window can leave an account that Chickpea never learned about. Reconcile the Composio project's Connected Accounts inventory at least monthly and after any authorization outage: filter to Chickpea principals (`chickpea:` user IDs), compare every `ca_...` ID with non-revoked Chickpea managed accounts and unresolved authorization events, wait at least forty minutes after creation, and delete only IDs absent from both sets with `revoke_on_delete=false`. Never use grant-wide revocation for this cleanup.
- Keep the active Composio project configuration available until every managed account is disconnected. Chickpea intentionally refuses a local-only disconnect when the project key is absent because it cannot delete the remote Composio account; the Admin UI returns an actionable restore-credentials error and leaves the account fail-closed in `needs_attention` with dependent schedules paused.
- The Worker artifact carries the Composio SDK cost even when the adapter is dormant. Keep it within the provider-adapter size budget.
- Native Google records are a migration fallback only. Do not bulk-delete them until every affected account has been reconnected through Composio and scheduled work has been checked.
- A native Google account spanning several services is withheld from all of them when any managed connector duplicates one service and the request does not identify a unique account. Migrate Gmail, Calendar, and Drive together when practical; otherwise give the native account a distinctive label that users can name during the transition.

References: [authentication and stable user IDs](https://docs.composio.dev/docs/authentication), [Connect Link SDK](https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts), [connected accounts and callback identity verification](https://docs.composio.dev/reference/v3/api-reference/connected-accounts), [deferred auth completion](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth), [receiving and verifying webhooks](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events), [scoped project keys](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions), [toolkit versioning](https://docs.composio.dev/docs/tools-direct/toolkit-versioning), [rate limits](https://docs.composio.dev/reference/v3/rate-limits), [pricing](https://composio.dev/pricing), [Gmail](https://docs.composio.dev/toolkits/gmail), [Google Calendar](https://docs.composio.dev/toolkits/googlecalendar), [Google Drive](https://docs.composio.dev/toolkits/googledrive), [Google Sheets](https://docs.composio.dev/toolkits/googlesheets), [Google Docs](https://docs.composio.dev/toolkits/googledocs), [Google Slides](https://docs.composio.dev/toolkits/googleslides), [Google Search Console](https://docs.composio.dev/toolkits/google_search_console), [Google Analytics](https://docs.composio.dev/toolkits/google_analytics), [HubSpot](https://docs.composio.dev/toolkits/hubspot), [HubSpot OAuth v1 deprecation](https://developers.hubspot.com/changelog/v1-oauth-api-deprecation), [HubSpot v4 end of support](https://developers.hubspot.com/changelog/deprecating-support-for-hubspot-v4-apis), [Gong](https://docs.composio.dev/toolkits/gong), [Google Ads](https://docs.composio.dev/toolkits/googleads), [Google Ads access levels and permissible use](https://developers.google.com/google-ads/api/docs/api-policy/access-levels), [Google Ads API sunsets](https://developers.google.com/google-ads/api/docs/sunset-dates), [YouTube](https://docs.composio.dev/toolkits/youtube), [YouTube quota costs](https://developers.google.com/youtube/v3/determine_quota_cost), [YouTube quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits), [Notion](https://docs.composio.dev/toolkits/notion), and [Notion OAuth authorization](https://developers.notion.com/guides/get-started/authorization).
