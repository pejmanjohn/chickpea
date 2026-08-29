import type { ConnectionAccountManagedPolicy } from '../../config/types.ts';
import { md5 } from '@noble/hashes/legacy.js';
import {
  MANAGED_ARTIFACT_ARGUMENT,
  type ManagedConnectionArtifact,
} from '../artifacts.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  type ManagedAccessLane,
  type ManagedConnectorDefinition,
  type ManagedProviderAvailability,
} from '../catalog/index.ts';
import {
  HUBSPOT_OBJECT_PROPERTIES,
  HUBSPOT_OBJECT_TYPES,
} from '../catalog/hubspot.ts';
import type {
  ManagedConnectionExecutionInput,
  ManagedConnectionExecutionResult,
  ManagedConnectionProvider,
} from '../managed.ts';
import {
  ManagedAuthorizationAllocatedError,
  ManagedAuthorizationExpiredError,
  ManagedProviderRequestError,
} from '../managed-errors.ts';
import { composioToolkitVersion } from './composio/versions.ts';

interface ComposioSessionLike {
  execute(
    tool: string,
    arguments_: Record<string, unknown>,
    modifiers?: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<{
    data: Record<string, unknown>;
    error?: string | null;
    successful?: boolean;
    logId?: string;
  }>;
}

export interface ComposioAuthConfigLike {
  id: string;
  name: string;
  toolkit: { slug: string };
  status: string;
  credentials?: Record<string, unknown> | undefined;
  restrictToFollowingTools?: string[] | undefined;
  isComposioManaged?: boolean | undefined;
  createdAt?: string | undefined;
  toolAccessConfig?: {
    toolsAvailableForExecution?: string[] | undefined;
    toolsForConnectedAccountCreation?: string[] | undefined;
  } | undefined;
}

export interface ComposioClientLike {
  authConfigs?: {
    list(
      query?: {
        cursor?: string;
        isComposioManaged?: boolean;
        limit?: number;
        search?: string;
        showDisabled?: boolean;
        toolkit?: string;
      },
      requestOptions?: { signal?: AbortSignal },
    ): Promise<{
      items: ComposioAuthConfigLike[];
      nextCursor: string | null;
      totalPages: number;
    }>;
    create(
      toolkit: string,
      options: {
        type: 'use_composio_managed_auth';
        name: string;
      },
      requestOptions?: { signal?: AbortSignal },
    ): Promise<{
      id: string;
      authScheme: string;
      isComposioManaged: boolean;
      toolkit: string;
    }>;
    get?(
      id: string,
      requestOptions?: { signal?: AbortSignal },
    ): Promise<ComposioAuthConfigLike>;
  };
  connectedAccounts?: {
    link(
      userId: string,
      authConfigId: string,
      options?: { callbackUrl?: string; allowMultiple?: boolean },
      requestOptions?: { signal?: AbortSignal },
    ): Promise<{ id: string; redirectUrl?: string | null }>;
    get?(
      id: string,
      requestOptions?: { signal?: AbortSignal },
    ): Promise<{
      id: string;
      status: string;
      isDisabled: boolean;
      toolkit: { slug: string };
    }>;
  };
  sessions: {
    create(
      userId: string,
      config: Record<string, unknown>,
      requestOptions?: { signal?: AbortSignal },
    ): Promise<ComposioSessionLike>;
  };
  tools?: {
    execute(
      tool: string,
      input: {
        userId: string;
        connectedAccountId: string;
        version: string;
        arguments: Record<string, unknown>;
      },
      options?: { signal?: AbortSignal },
    ): Promise<{
      data: Record<string, unknown>;
      error?: string | null | undefined;
      successful?: boolean | undefined;
      logId?: string | undefined;
    }>;
  };
}

export interface ComposioConnectedAccount {
  id: string;
  status: string;
  isDisabled: boolean;
  toolkit: string;
  /** Deprecated by Composio and may be omitted from list responses. */
  userId?: string;
}

export type ComposioManagedAuthConfigIds = Readonly<Record<
  string,
  Readonly<Partial<Record<ManagedAccessLane, string | undefined>>> | undefined
>>;

export function isComposioAuthConfigId(value: string | undefined): value is string {
  return Boolean(value && /^ac_[A-Za-z0-9_-]{1,200}$/.test(value));
}

interface ComposioManagedConnectionProviderOptions {
  apiKey?: string;
  authConfigIds?: ComposioManagedAuthConfigIds;
  googleAdsAccessLevel?: string;
  googleAdsPermissibleUse?: string;
  youtubeGeneralDailyQuota?: string;
  youtubeSearchDailyLimit?: string;
  youtubeUploadDailyLimit?: string;
  youtubeQuotaAuditApproved?: string;
  createClient?: (input: { apiKey: string }) => Promise<ComposioClientLike>;
  revokeAccount?: (input: {
    apiKey: string;
    accountRef: string;
    signal: AbortSignal;
  }) => Promise<void>;
  getConnectedAccount?: (input: {
    apiKey: string;
    accountRef: string;
    principalRef: string;
    signal: AbortSignal;
  }) => Promise<ComposioConnectedAccount>;
}

interface ComposioCapability {
  toolkit: string;
  tool: string;
  arguments(input: Record<string, unknown>): Record<string, unknown>;
  sanitize(
    data: Record<string, unknown>,
    input: Record<string, unknown>,
  ): Record<string, unknown>;
}

const COMPOSIO_CAPABILITIES: Readonly<Record<string, ComposioCapability>> = {
  'gmail.profile.read': {
    toolkit: 'gmail',
    tool: 'GMAIL_GET_PROFILE',
    arguments: () => ({ user_id: 'me' }),
    sanitize: identityResult,
  },
  'gmail.messages.search': {
    toolkit: 'gmail',
    tool: 'GMAIL_FETCH_EMAILS',
    arguments: (input) => ({
      user_id: 'me',
      query: requiredString(input.query, 'query', 2_000),
      max_results: boundedInteger(input.maxResults, 1, 10, 5),
      include_payload: input.includeBody === true,
    }),
    sanitize: (data, input) => input.includeBody === true ? data : projectGmailSearchMetadata(data),
  },
  'gmail.drafts.create': {
    toolkit: 'gmail',
    tool: 'GMAIL_CREATE_EMAIL_DRAFT',
    arguments: (input) => ({
      recipient_email: requiredString(input.recipientEmail, 'recipientEmail', 1_000),
      subject: requiredContentString(input.subject, 'subject', 2_000),
      body: requiredContentString(input.body, 'body', 100_000),
      is_html: input.isHtml === true,
    }),
    sanitize: identityResult,
  },
  'gmail.messages.send': {
    toolkit: 'gmail',
    tool: 'GMAIL_SEND_EMAIL',
    arguments: (input) => ({
      user_id: 'me',
      recipient_email: optionalString(input.recipientEmail, 'recipientEmail', 1_000),
      extra_recipients: optionalStringArray(input.extraRecipients, 'extraRecipients', 50, 1_000),
      cc: optionalStringArray(input.cc, 'cc', 50, 1_000),
      bcc: optionalStringArray(input.bcc, 'bcc', 50, 1_000),
      subject: optionalContentString(input.subject, 'subject', 2_000),
      body: optionalContentString(input.body, 'body', 100_000),
      is_html: input.isHtml === true,
    }),
    sanitize: identityResult,
  },
  'calendar.calendars.list': {
    toolkit: 'googlecalendar',
    tool: 'GOOGLECALENDAR_LIST_CALENDARS',
    arguments: (input) => ({
      max_results: boundedInteger(input.maxResults, 1, 250, 100),
      page_token: optionalString(input.pageToken, 'pageToken', 2_000),
    }),
    sanitize: identityResult,
  },
  'calendar.events.list': {
    toolkit: 'googlecalendar',
    tool: 'GOOGLECALENDAR_EVENTS_LIST',
    arguments: (input) => ({
      calendarId: optionalString(input.calendarId, 'calendarId', 1_000) ?? 'primary',
      q: optionalString(input.query, 'query', 2_000),
      timeMin: optionalString(input.timeMin, 'timeMin', 128),
      timeMax: optionalString(input.timeMax, 'timeMax', 128),
      timeZone: optionalString(input.timeZone, 'timeZone', 128),
      pageToken: optionalString(input.pageToken, 'pageToken', 2_000),
      maxResults: boundedInteger(input.maxResults, 1, 250, 50),
      singleEvents: input.singleEvents !== false,
      orderBy: input.singleEvents === false ? undefined : 'startTime',
      showDeleted: input.showDeleted === true,
    }),
    sanitize: identityResult,
  },
  'calendar.events.create': {
    toolkit: 'googlecalendar',
    tool: 'GOOGLECALENDAR_CREATE_EVENT',
    arguments: (input) => ({
      calendar_id: optionalString(input.calendarId, 'calendarId', 1_000) ?? 'primary',
      summary: optionalContentString(input.summary, 'summary', 2_000),
      description: optionalContentString(input.description, 'description', 20_000),
      location: optionalContentString(input.location, 'location', 2_000),
      start_datetime: requiredString(input.startDateTime, 'startDateTime', 128),
      end_datetime: optionalString(input.endDateTime, 'endDateTime', 128),
      timezone: optionalString(input.timeZone, 'timeZone', 128),
      attendees: optionalStringArray(input.attendees, 'attendees', 100, 1_000),
      send_updates: optionalEnum(input.sendUpdates, 'sendUpdates', ['all', 'externalOnly', 'none']),
      create_meeting_room: input.createMeetingRoom === true,
    }),
    sanitize: identityResult,
  },
  'calendar.events.update': {
    toolkit: 'googlecalendar',
    tool: 'GOOGLECALENDAR_PATCH_EVENT',
    arguments: (input) => ({
      calendar_id: optionalString(input.calendarId, 'calendarId', 1_000) ?? 'primary',
      event_id: requiredString(input.eventId, 'eventId', 1_000),
      summary: optionalContentString(input.summary, 'summary', 2_000),
      description: optionalContentString(input.description, 'description', 20_000),
      location: optionalContentString(input.location, 'location', 2_000),
      start_time: optionalString(input.startDateTime, 'startDateTime', 128),
      end_time: optionalString(input.endDateTime, 'endDateTime', 128),
      timezone: optionalString(input.timeZone, 'timeZone', 128),
      attendees: optionalStringArray(input.attendees, 'attendees', 100, 1_000),
      send_updates: optionalEnum(input.sendUpdates, 'sendUpdates', ['all', 'externalOnly', 'none']),
    }),
    sanitize: identityResult,
  },
  'calendar.events.delete': {
    toolkit: 'googlecalendar',
    tool: 'GOOGLECALENDAR_DELETE_EVENT',
    arguments: (input) => ({
      calendar_id: optionalString(input.calendarId, 'calendarId', 1_000) ?? 'primary',
      event_id: requiredString(input.eventId, 'eventId', 1_000),
      send_updates: optionalEnum(input.sendUpdates, 'sendUpdates', ['all', 'externalOnly', 'none']),
    }),
    sanitize: identityResult,
  },
  'drive.files.search': {
    toolkit: 'googledrive',
    tool: 'GOOGLEDRIVE_FIND_FILE',
    arguments: (input) => ({
      q: optionalString(input.query, 'query', 2_000),
      folder_id: optionalString(input.folderId, 'folderId', 1_000),
      pageSize: boundedInteger(input.pageSize, 1, 100, 25),
      pageToken: optionalString(input.pageToken, 'pageToken', 2_000),
      corpora: optionalEnum(input.corpora, 'corpora', ['user', 'drive', 'domain', 'allDrives']) ?? 'allDrives',
      driveId: optionalString(input.driveId, 'driveId', 1_000),
    }),
    sanitize: identityResult,
  },
  'drive.files.metadata': {
    toolkit: 'googledrive',
    tool: 'GOOGLEDRIVE_GET_FILE_METADATA',
    arguments: (input) => ({
      fileId: requiredString(input.fileId, 'fileId', 1_000),
      fields: 'id,name,mimeType,size,createdTime,modifiedTime,parents,owners,webViewLink,webContentLink,trashed,starred',
      supportsAllDrives: true,
    }),
    sanitize: identityResult,
  },
  'drive.files.read': {
    toolkit: 'googledrive',
    tool: 'GOOGLEDRIVE_PARSE_FILE',
    arguments: (input) => ({
      file_id: requiredString(input.fileId, 'fileId', 1_000),
      mime_type: optionalString(input.mimeType, 'mimeType', 256),
    }),
    sanitize: identityResult,
  },
  'drive.files.create': {
    toolkit: 'googledrive',
    tool: 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT',
    arguments: (input) => ({
      file_name: requiredString(input.fileName, 'fileName', 1_000),
      text_content: requiredContentString(input.textContent, 'textContent', 100_000),
      mime_type: optionalString(input.mimeType, 'mimeType', 256) ?? 'text/plain',
    }),
    sanitize: identityResult,
  },
  'sheets.spreadsheets.search': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_SEARCH_SPREADSHEETS',
    arguments: (input) => ({
      query: optionalString(input.query, 'query', 2_000),
      page_token: optionalString(input.pageToken, 'pageToken', 2_000),
      max_results: boundedInteger(input.maxResults, 1, 100, 10),
      search_type: 'both',
      include_trashed: false,
      include_shared_drives: true,
      order_by: 'modifiedTime desc',
    }),
    sanitize: projectWorkspaceSearch,
  },
  'sheets.spreadsheets.metadata': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_GET_SPREADSHEET_INFO',
    arguments: (input) => ({
      spreadsheet_id: requiredString(input.spreadsheetId, 'spreadsheetId', 1_000),
      fields: 'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))',
      include_grid_data: false,
    }),
    sanitize: projectSpreadsheetMetadata,
  },
  'sheets.values.get': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_VALUES_GET',
    arguments: (input) => ({
      spreadsheet_id: requiredString(input.spreadsheetId, 'spreadsheetId', 1_000),
      range: requiredString(input.range, 'range', 1_000),
      start_row: optionalInteger(input.startRow, 1, 1_000_000),
      end_row: optionalInteger(input.endRow, 1, 1_000_000),
      major_dimension: optionalEnum(input.majorDimension, 'majorDimension', ['ROWS', 'COLUMNS']),
      value_render_option: optionalEnum(input.valueRenderOption, 'valueRenderOption', [
        'FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA',
      ]) ?? 'FORMATTED_VALUE',
      date_time_render_option: 'FORMATTED_STRING',
    }),
    sanitize: identityResult,
  },
  'sheets.tables.query': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW',
    arguments: (input) => ({
      spreadsheet_id: requiredString(input.spreadsheetId, 'spreadsheetId', 1_000),
      query: requiredString(input.query, 'query', 2_000),
      range: optionalString(input.range, 'range', 1_000),
      case_sensitive: input.caseSensitive === true,
      normalize_whitespace: true,
      value_render_option: 'FORMATTED_VALUE',
      date_time_render_option: 'FORMATTED_STRING',
    }),
    sanitize: identityResult,
  },
  'sheets.spreadsheets.create': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    arguments: (input) => ({
      title: requiredString(input.title, 'title', 2_000),
      folder_id: optionalString(input.folderId, 'folderId', 1_000),
    }),
    sanitize: projectCreatedArtifact,
  },
  'sheets.values.update': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_VALUES_UPDATE',
    arguments: (input) => ({
      spreadsheet_id: requiredString(input.spreadsheetId, 'spreadsheetId', 1_000),
      range: requiredString(input.range, 'range', 1_000),
      values: requiredCellMatrix(input.values),
      major_dimension: optionalEnum(input.majorDimension, 'majorDimension', ['ROWS', 'COLUMNS']) ?? 'ROWS',
      value_input_option: optionalEnum(input.valueInputOption, 'valueInputOption', ['RAW', 'USER_ENTERED']) ?? 'USER_ENTERED',
      auto_expand_sheet: true,
      include_values_in_response: false,
    }),
    sanitize: identityResult,
  },
  'sheets.values.append': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
    arguments: (input) => ({
      spreadsheetId: requiredString(input.spreadsheetId, 'spreadsheetId', 1_000),
      range: requiredString(input.range, 'range', 1_000),
      values: requiredCellMatrix(input.values),
      majorDimension: 'ROWS',
      insertDataOption: 'INSERT_ROWS',
      valueInputOption: optionalEnum(input.valueInputOption, 'valueInputOption', ['RAW', 'USER_ENTERED']) ?? 'USER_ENTERED',
      includeValuesInResponse: false,
    }),
    sanitize: identityResult,
  },
  'sheets.rows.upsert': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_UPSERT_ROWS',
    arguments: (input) => ({
      spreadsheetId: requiredString(input.spreadsheetId, 'spreadsheetId', 1_000),
      sheetName: requiredContentString(input.sheetName, 'sheetName', 500),
      headers: requiredStringArray(input.headers, 'headers', 100, 2_000),
      rows: requiredCellMatrix(input.rows),
      keyColumn: requiredString(input.keyColumn, 'keyColumn', 2_000),
      tableStart: optionalString(input.tableStart, 'tableStart', 32) ?? 'A1',
      strictMode: true,
    }),
    sanitize: identityResult,
  },
  'sheets.sheets.add': {
    toolkit: 'googlesheets',
    tool: 'GOOGLESHEETS_ADD_SHEET',
    arguments: (input) => ({
      spreadsheet_id: requiredString(input.spreadsheetId, 'spreadsheetId', 1_000),
      title: requiredString(input.title, 'title', 2_000),
      properties: {
        sheetType: 'GRID',
        gridProperties: {
          rowCount: boundedInteger(input.rowCount, 1, 100_000, 100),
          columnCount: boundedInteger(input.columnCount, 1, 18_278, 26),
          frozenRowCount: boundedInteger(input.frozenRowCount, 0, 100_000, 0),
          frozenColumnCount: boundedInteger(input.frozenColumnCount, 0, 18_278, 0),
          hideGridlines: input.hideGridlines === true,
        },
      },
      force_unique: input.forceUnique !== false,
    }),
    sanitize: identityResult,
  },
  'docs.documents.search': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_SEARCH_DOCUMENTS',
    arguments: (input) => ({
      query: optionalString(input.query, 'query', 2_000),
      page_token: optionalString(input.pageToken, 'pageToken', 2_000),
      max_results: boundedInteger(input.maxResults, 1, 100, 10),
      response_detail: 'minimal',
      include_trashed: false,
      include_shared_drives: true,
      order_by: 'modifiedTime desc',
    }),
    sanitize: projectWorkspaceSearch,
  },
  'docs.documents.get': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
    arguments: (input) => ({
      id: requiredString(input.documentId, 'documentId', 1_000),
      includeTabsContent: input.includeTabs === true,
    }),
    sanitize: projectDocumentStructure,
  },
  'docs.documents.text': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
    arguments: (input) => ({
      document_id: requiredString(input.documentId, 'documentId', 1_000),
      include_tabs_content: input.includeTabs === true,
      include_tables: input.includeTables !== false,
      include_headers: input.includeHeaders === true,
      include_footers: input.includeFooters === true,
      include_footnotes: input.includeFootnotes === true,
    }),
    sanitize: identityResult,
  },
  'docs.documents.export_pdf': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_EXPORT_DOCUMENT_AS_PDF',
    arguments: (input) => ({
      file_id: requiredString(input.documentId, 'documentId', 1_000),
      filename: optionalString(input.filename, 'filename', 240),
    }),
    sanitize: projectExportArtifact,
  },
  'docs.documents.create': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_CREATE_DOCUMENT',
    arguments: (input) => ({
      title: requiredString(input.title, 'title', 2_000),
      text: optionalContentString(input.text, 'text', 100_000),
    }),
    sanitize: projectCreatedArtifact,
  },
  'docs.documents.create_markdown': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    arguments: (input) => ({
      title: requiredString(input.title, 'title', 2_000),
      markdown_text: requiredContentString(input.markdown, 'markdown', 100_000),
    }),
    sanitize: projectCreatedArtifact,
  },
  'docs.documents.insert_text': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_INSERT_TEXT_ACTION',
    arguments: (input) => ({
      document_id: requiredString(input.documentId, 'documentId', 1_000),
      text_to_insert: requiredContentString(input.text, 'text', 100_000),
      append_to_end: input.appendToEnd === true,
      insertion_index: optionalInteger(input.insertionIndex, 1, 10_000_000),
      tab_id: optionalString(input.tabId, 'tabId', 1_000),
    }),
    sanitize: identityResult,
  },
  'docs.documents.update_markdown': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
    arguments: (input) => ({
      id: requiredString(input.documentId, 'documentId', 1_000),
      markdown: requiredContentString(input.markdown, 'markdown', 100_000),
      tab_id: optionalString(input.tabId, 'tabId', 1_000),
    }),
    sanitize: identityResult,
  },
  'docs.documents.update_section_markdown': {
    toolkit: 'googledocs',
    tool: 'GOOGLEDOCS_UPDATE_DOCUMENT_SECTION_MARKDOWN',
    arguments: (input) => ({
      document_id: requiredString(input.documentId, 'documentId', 1_000),
      markdown_text: requiredContentString(input.markdown, 'markdown', 100_000),
      start_index: optionalInteger(input.startIndex, 1, 10_000_000),
      end_index: optionalInteger(input.endIndex, 2, 10_000_001),
      tab_id: optionalString(input.tabId, 'tabId', 1_000),
    }),
    sanitize: identityResult,
  },
  'slides.presentations.get': {
    toolkit: 'googleslides',
    tool: 'GOOGLESLIDES_PRESENTATIONS_GET',
    arguments: (input) => ({
      presentationId: requiredString(input.presentationId, 'presentationId', 1_000),
      fields: 'presentationId,title,locale,revisionId,pageSize,slides(objectId,pageType,pageElements(objectId,title,description,shape(shapeType,text)))',
    }),
    sanitize: projectPresentation,
  },
  'slides.pages.get': {
    toolkit: 'googleslides',
    tool: 'GOOGLESLIDES_PRESENTATIONS_PAGES_GET',
    arguments: (input) => ({
      presentationId: requiredString(input.presentationId, 'presentationId', 1_000),
      pageObjectId: requiredString(input.pageObjectId, 'pageObjectId', 1_000),
    }),
    sanitize: projectPresentationPage,
  },
  'slides.pages.thumbnail': {
    toolkit: 'googleslides',
    tool: 'GOOGLESLIDES_GET_PAGE_THUMBNAIL2',
    arguments: (input) => ({
      presentationId: requiredString(input.presentationId, 'presentationId', 1_000),
      pageObjectId: requiredString(input.pageObjectId, 'pageObjectId', 1_000),
      'thumbnailProperties.mimeType': 'PNG',
      'thumbnailProperties.thumbnailSize': optionalEnum(input.size, 'size', [
        'SMALL', 'MEDIUM', 'LARGE',
      ]) ?? 'MEDIUM',
    }),
    sanitize: projectExportArtifact,
  },
  'slides.presentations.create': {
    toolkit: 'googleslides',
    tool: 'GOOGLESLIDES_CREATE_PRESENTATION',
    arguments: (input) => ({
      title: requiredString(input.title, 'title', 2_000),
      locale: optionalString(input.locale, 'locale', 35),
    }),
    sanitize: projectCreatedArtifact,
  },
  'slides.presentations.create_markdown': {
    toolkit: 'googleslides',
    tool: 'GOOGLESLIDES_CREATE_SLIDES_MARKDOWN',
    arguments: (input) => ({
      title: requiredString(input.title, 'title', 2_000),
      markdown_text: requiredContentString(input.markdown, 'markdown', 100_000),
    }),
    sanitize: projectCreatedArtifact,
  },
  'slides.presentations.copy_template': {
    toolkit: 'googleslides',
    tool: 'GOOGLESLIDES_PRESENTATIONS_COPY_FROM_TEMPLATE',
    arguments: (input) => ({
      template_presentation_id: requiredString(
        input.templatePresentationId, 'templatePresentationId', 1_000,
      ),
      new_title: requiredString(input.title, 'title', 2_000),
      parent_folder_id: optionalString(input.parentFolderId, 'parentFolderId', 1_000),
    }),
    sanitize: projectCreatedArtifact,
  },
  'slides.presentations.batch_update': {
    toolkit: 'googleslides',
    tool: 'GOOGLESLIDES_PRESENTATIONS_BATCH_UPDATE',
    arguments: (input) => ({
      presentationId: requiredString(input.presentationId, 'presentationId', 1_000),
      requests: slidesRequests(input.operations),
      writeControl: input.requiredRevisionId === undefined ? undefined : {
        requiredRevisionId: requiredString(
          input.requiredRevisionId, 'requiredRevisionId', 1_000,
        ),
      },
    }),
    sanitize: identityResult,
  },
  'search_console.sites.get': {
    toolkit: 'google_search_console',
    tool: 'GOOGLE_SEARCH_CONSOLE_GET_SITE',
    arguments: (input) => ({
      site_url: requiredString(input.siteUrl, 'siteUrl', 2_000),
    }),
    sanitize: identityResult,
  },
  'search_console.sitemaps.list': {
    toolkit: 'google_search_console',
    tool: 'GOOGLE_SEARCH_CONSOLE_LIST_SITEMAPS',
    arguments: (input) => ({
      site_url: requiredString(input.siteUrl, 'siteUrl', 2_000),
      sitemap_index: optionalString(input.sitemapIndex, 'sitemapIndex', 2_000),
    }),
    sanitize: identityResult,
  },
  'search_console.sitemaps.get': {
    toolkit: 'google_search_console',
    tool: 'GOOGLE_SEARCH_CONSOLE_GET_SITEMAP',
    arguments: (input) => ({
      site_url: requiredString(input.siteUrl, 'siteUrl', 2_000),
      feedpath: requiredString(input.feedpath, 'feedpath', 2_000),
    }),
    sanitize: identityResult,
  },
  'search_console.urls.inspect': {
    toolkit: 'google_search_console',
    tool: 'GOOGLE_SEARCH_CONSOLE_INSPECT_URL',
    arguments: (input) => ({
      site_url: requiredString(input.siteUrl, 'siteUrl', 2_000),
      inspection_url: requiredString(input.inspectionUrl, 'inspectionUrl', 2_000),
      language_code: optionalString(input.languageCode, 'languageCode', 35),
    }),
    sanitize: identityResult,
  },
  'search_console.analytics.query': {
    toolkit: 'google_search_console',
    tool: 'GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY',
    arguments: (input) => ({
      site_url: requiredString(input.siteUrl, 'siteUrl', 2_000),
      start_date: requiredString(input.startDate, 'startDate', 10),
      end_date: requiredString(input.endDate, 'endDate', 10),
      dimensions: optionalStringArray(input.dimensions, 'dimensions', 5, 32),
      search_type: optionalEnum(input.searchType, 'searchType', [
        'web', 'image', 'video', 'news', 'discover', 'googleNews',
      ]) ?? 'web',
      data_state: optionalEnum(input.dataState, 'dataState', ['final', 'all']) ?? 'final',
      row_limit: boundedInteger(input.rowLimit, 1, 1_000, 100),
      start_row: boundedInteger(input.startRow, 0, 25_000, 0),
    }),
    sanitize: identityResult,
  },
  'analytics.properties.get': {
    toolkit: 'google_analytics',
    tool: 'GOOGLE_ANALYTICS_GET_PROPERTY',
    arguments: (input) => ({
      name: requiredString(input.property, 'property', 1_000),
    }),
    sanitize: identityResult,
  },
  'analytics.metadata.get': {
    toolkit: 'google_analytics',
    tool: 'GOOGLE_ANALYTICS_GET_METADATA',
    arguments: (input) => ({
      name: `${requiredString(input.property, 'property', 1_000)}/metadata`,
    }),
    sanitize: identityResult,
  },
  'analytics.quotas.get': {
    toolkit: 'google_analytics',
    tool: 'GOOGLE_ANALYTICS_GET_PROPERTY_QUOTAS_SNAPSHOT',
    arguments: (input) => ({
      property: requiredString(input.property, 'property', 1_000),
    }),
    sanitize: identityResult,
  },
  'analytics.reports.run': {
    toolkit: 'google_analytics',
    tool: 'GOOGLE_ANALYTICS_RUN_REPORT',
    arguments: (input) => ({
      property: requiredString(input.property, 'property', 1_000),
      dateRanges: [analyticsDateRange(input)],
      dimensions: analyticsNamedFields(input.dimensions, 'dimensions', 9),
      metrics: analyticsNamedFields(input.metrics, 'metrics', 10, true),
      limit: boundedInteger(input.limit, 1, 1_000, 100),
      offset: boundedInteger(input.offset, 0, 100_000, 0),
      keepEmptyRows: input.keepEmptyRows === true,
      returnPropertyQuota: input.returnPropertyQuota === true,
    }),
    sanitize: identityResult,
  },
  'analytics.reports.realtime': {
    toolkit: 'google_analytics',
    tool: 'GOOGLE_ANALYTICS_RUN_REALTIME_REPORT',
    arguments: (input) => ({
      property: requiredString(input.property, 'property', 1_000),
      dimensions: analyticsNamedFields(input.dimensions, 'dimensions', 4),
      metrics: analyticsNamedFields(input.metrics, 'metrics', 4, true),
      limit: boundedInteger(input.limit, 1, 1_000, 100),
      returnPropertyQuota: input.returnPropertyQuota === true,
    }),
    sanitize: identityResult,
  },
  'analytics.reports.pivot': {
    toolkit: 'google_analytics',
    tool: 'GOOGLE_ANALYTICS_RUN_PIVOT_REPORT',
    arguments: (input) => analyticsPivotArguments(input),
    sanitize: identityResult,
  },
  'analytics.reports.funnel': {
    toolkit: 'google_analytics',
    tool: 'GOOGLE_ANALYTICS_RUN_FUNNEL_REPORT',
    arguments: (input) => analyticsFunnelArguments(input),
    sanitize: identityResult,
  },
  'hubspot.account.get': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_GET_ACCOUNT_INFO',
    arguments: () => ({}),
    sanitize: projectHubSpotAccount,
  },
  'hubspot.objects.search': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_SEARCH_CRM_OBJECTS_BY_CRITERIA',
    arguments: hubSpotSearchArguments,
    sanitize: (data, input) => projectHubSpotPage(
      data,
      hubSpotObjectType(input.objectType),
      input.properties,
    ),
  },
  'hubspot.objects.get': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_READ_CRM_OBJECT_BY_ID',
    arguments: (input) => {
      const objectType = hubSpotObjectType(input.objectType);
      return {
        objectType,
        objectId: requiredString(input.objectId, 'objectId', 256),
        archived: false,
        properties: hubSpotReadProperties(objectType, input.properties),
        associations: hubSpotAssociationObjectTypes(input.associations, 'associations'),
      };
    },
    sanitize: (data, input) => projectHubSpotRecord(
      data,
      hubSpotObjectType(input.objectType),
      input.properties,
    ),
  },
  'hubspot.owners.list': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_RETRIEVE_PAGE_OF_CRM_OWNERS',
    arguments: (input) => ({
      email: optionalString(input.email, 'email', 320),
      after: optionalString(input.after, 'after', 256),
      limit: boundedInteger(input.limit, 1, 100, 100),
      archived: false,
    }),
    sanitize: projectHubSpotOwners,
  },
  'hubspot.pipelines.list': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_RETRIEVE_ALL_PIPELINES_FOR_SPECIFIED_OBJECT_TYPE',
    arguments: (input) => ({
      objectType: requiredHubSpotPipelineType(input.objectType),
    }),
    sanitize: projectHubSpotPipelines,
  },
  'hubspot.associations.list': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_LIST_OBJECT_ASSOCIATIONS',
    arguments: (input) => ({
      objectType: requiredHubSpotAssociationType(input.objectType, 'objectType'),
      objectId: requiredString(input.objectId, 'objectId', 256),
      toObjectType: requiredHubSpotAssociationType(input.toObjectType, 'toObjectType'),
      after: optionalString(input.after, 'after', 256),
      limit: boundedInteger(input.limit, 1, 500, 100),
    }),
    sanitize: projectHubSpotAssociations,
  },
  'hubspot.association_types.list': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_LIST_ASSOCIATION_TYPES',
    arguments: (input) => ({
      fromObjectType: requiredHubSpotAssociationType(input.fromObjectType, 'fromObjectType'),
      toObjectType: requiredHubSpotAssociationType(input.toObjectType, 'toObjectType'),
    }),
    sanitize: projectHubSpotAssociationTypes,
  },
  'hubspot.contacts.create': hubSpotCreateCapability('contacts', {
    email: 'email', firstName: 'firstname', lastName: 'lastname', phone: 'phone',
    mobilePhone: 'mobilephone', jobTitle: 'jobtitle', companyName: 'company',
    website: 'website', lifecycleStage: 'lifecyclestage', leadStatus: 'hs_lead_status',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.contacts.update': hubSpotUpdateCapability('contacts', {
    email: 'email', firstName: 'firstname', lastName: 'lastname', phone: 'phone',
    mobilePhone: 'mobilephone', jobTitle: 'jobtitle', companyName: 'company',
    website: 'website', lifecycleStage: 'lifecyclestage', leadStatus: 'hs_lead_status',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.companies.create': hubSpotCreateCapability('companies', {
    name: 'name', domain: 'domain', phone: 'phone', city: 'city', state: 'state',
    country: 'country', industry: 'industry', employeeCount: 'numberofemployees',
    annualRevenue: 'annualrevenue', lifecycleStage: 'lifecyclestage',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.companies.update': hubSpotUpdateCapability('companies', {
    name: 'name', domain: 'domain', phone: 'phone', city: 'city', state: 'state',
    country: 'country', industry: 'industry', employeeCount: 'numberofemployees',
    annualRevenue: 'annualrevenue', lifecycleStage: 'lifecyclestage',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.deals.create': hubSpotCreateCapability('deals', {
    name: 'dealname', amount: 'amount', stageId: 'dealstage', pipelineId: 'pipeline',
    closeDate: 'closedate', dealType: 'dealtype', description: 'description',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.deals.update': hubSpotUpdateCapability('deals', {
    name: 'dealname', amount: 'amount', stageId: 'dealstage', pipelineId: 'pipeline',
    closeDate: 'closedate', dealType: 'dealtype', description: 'description',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.tickets.create': hubSpotCreateCapability('tickets', {
    subject: 'subject', content: 'content', pipelineId: 'hs_pipeline',
    stageId: 'hs_pipeline_stage', priority: 'hs_ticket_priority',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.tickets.update': hubSpotUpdateCapability('tickets', {
    subject: 'subject', content: 'content', pipelineId: 'hs_pipeline',
    stageId: 'hs_pipeline_stage', priority: 'hs_ticket_priority',
    ownerId: 'hubspot_owner_id',
  }),
  'hubspot.notes.create': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_CREATE_NOTE',
    arguments: (input) => ({
      hs_note_body: requiredContentString(input.body, 'body', 65_536),
      hs_timestamp: requiredString(input.timestamp, 'timestamp', 128),
      hubspot_owner_id: optionalString(input.ownerId, 'ownerId', 256),
    }),
    sanitize: (data) => projectHubSpotRecord(data, 'notes'),
  },
  'hubspot.tasks.create': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_CREATE_TASK',
    arguments: (input) => ({
      hs_task_subject: requiredString(input.subject, 'subject', 2_000),
      hs_task_body: optionalContentString(input.body, 'body', 65_536),
      hs_timestamp: requiredString(input.dueAt, 'dueAt', 128),
      hs_task_type: optionalEnum(input.type, 'type', ['CALL', 'EMAIL', 'TODO']) ?? 'TODO',
      hs_task_status: optionalEnum(input.status, 'status', ['NOT_STARTED', 'COMPLETED']) ?? 'NOT_STARTED',
      hs_task_priority: optionalEnum(input.priority, 'priority', ['LOW', 'MEDIUM', 'HIGH', 'NONE']) ?? 'NONE',
      hubspot_owner_id: optionalString(input.ownerId, 'ownerId', 256),
    }),
    sanitize: (data) => projectHubSpotRecord(data, 'tasks'),
  },
  'hubspot.meetings.create': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_CREATE_MEETING',
    arguments: (input) => ({
      hs_timestamp: requiredString(input.startsAt, 'startsAt', 128),
      hs_meeting_title: requiredString(input.title, 'title', 2_000),
      hs_meeting_body: optionalContentString(input.body, 'body', 65_536),
      hs_meeting_start_time: requiredString(input.startsAt, 'startsAt', 128),
      hs_meeting_end_time: optionalString(input.endsAt, 'endsAt', 128),
      hs_meeting_outcome: optionalEnum(input.outcome, 'outcome', [
        'SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELED',
      ]) ?? 'SCHEDULED',
      hs_meeting_location: optionalString(input.location, 'location', 2_000),
      hubspot_owner_id: optionalString(input.ownerId, 'ownerId', 256),
    }),
    sanitize: (data) => projectHubSpotRecord(data, 'meetings'),
  },
  'hubspot.associations.create': {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_CREATE_OBJECT_ASSOCIATION',
    arguments: (input) => ({
      objectType: requiredHubSpotAssociationType(input.objectType, 'objectType'),
      objectId: requiredString(input.objectId, 'objectId', 256),
      toObjectType: requiredHubSpotAssociationType(input.toObjectType, 'toObjectType'),
      toObjectId: requiredString(input.toObjectId, 'toObjectId', 256),
      labels: [{
        associationCategory: requiredHubSpotAssociationCategory(input.associationCategory),
        associationTypeId: boundedInteger(input.associationTypeId, 1, 2_147_483_647, 1),
      }],
    }),
    sanitize: projectHubSpotAssociations,
  },
  'gong.workspaces.list': {
    toolkit: 'gong',
    tool: 'GONG_LIST_ALL_COMPANY_WORKSPACES_V2_WORKSPACES',
    arguments: () => ({}),
    sanitize: (data, input) => projectGongWorkspaces(
      data,
      requiredString(input.workspaceId, 'workspaceId', 256),
      requiredString(input.workspaceHandle, 'workspaceHandle', 128),
    ),
  },
  'gong.users.list': {
    toolkit: 'gong',
    tool: 'GONG_LIST_ALL_USERS_V2_USERS',
    arguments: (input) => ({
      cursor: optionalString(input.cursor, 'cursor', 2_000),
      includeAvatars: false,
    }),
    sanitize: projectGongUsers,
  },
  'gong.calls.list': {
    toolkit: 'gong',
    tool: 'GONG_RETRIEVE_CALL_DATA_BY_DATE_RANGE_V2_CALLS',
    arguments: (input) => ({
      workspaceId: requiredString(input.workspaceId, 'workspaceId', 256),
      fromDateTime: requiredString(input.fromDateTime, 'fromDateTime', 128),
      toDateTime: requiredString(input.toDateTime, 'toDateTime', 128),
      cursor: optionalString(input.cursor, 'cursor', 2_000),
    }),
    sanitize: (data, input) => projectGongCalls(
      data, requiredString(input.workspaceId, 'workspaceId', 256), false,
    ),
  },
  'gong.calls.get': {
    toolkit: 'gong',
    tool: 'GONG_GET_CALL_BY_ID',
    arguments: (input) => ({
      call_id: requiredGongId(input.callId, 'callId'),
    }),
    sanitize: (data, input) => projectGongCall(
      data, requiredString(input.workspaceId, 'workspaceId', 256), true,
    ),
  },
  'gong.transcripts.get': {
    toolkit: 'gong',
    tool: 'GONG_GET_CALL_TRANSCRIPT',
    arguments: (input) => ({
      cursor: optionalString(input.cursor, 'cursor', 2_000),
      filter: {
        callIds: [requiredGongId(input.callId, 'callId')],
        workspaceId: requiredString(input.workspaceId, 'workspaceId', 256),
      },
    }),
    sanitize: projectGongTranscript,
  },
  'gong.interactions.stats': {
    toolkit: 'gong',
    tool: 'GONG_GET_INTERACTION_STATISTICS',
    arguments: (input) => ({
      cursor: optionalString(input.cursor, 'cursor', 2_000),
      filter: {
        fromDate: requiredString(input.fromDate, 'fromDate', 10),
        toDate: requiredString(input.toDate, 'toDate', 10),
        userIds: optionalGongIds(input.userIds, 'userIds', 100),
      },
    }),
    sanitize: projectGongMetricPage,
  },
  'gong.coaching.metrics': {
    toolkit: 'gong',
    tool: 'GONG_LIST_ALL_COACHING_METRICS_V2_COACHING',
    arguments: (input) => ({
      workspace__id: requiredString(input.workspaceId, 'workspaceId', 256),
      manager__id: requiredGongId(input.managerId, 'managerId'),
      from: requiredString(input.fromDateTime, 'fromDateTime', 128),
      to: requiredString(input.toDateTime, 'toDateTime', 128),
    }),
    sanitize: projectGongMetricPage,
  },
  'gong.scorecards.list': {
    toolkit: 'gong',
    tool: 'GONG_LIST_SCORECARDS',
    arguments: () => ({}),
    sanitize: projectGongMetricPage,
  },
  'gong.scorecards.activity': {
    toolkit: 'gong',
    tool: 'GONG_CREATE_ACTIVITY_SCORECARDS_REPORT',
    arguments: (input) => ({
      cursor: optionalString(input.cursor, 'cursor', 2_000),
      filter__callFromDate: requiredString(input.callFromDate, 'callFromDate', 10),
      filter__callToDate: requiredString(input.callToDate, 'callToDate', 10),
      filter__reviewMethod: optionalEnum(input.reviewMethod, 'reviewMethod', [
        'AUTOMATIC', 'BOTH', 'MANUAL',
      ]) ?? 'BOTH',
      filter__scorecardIds: optionalGongIds(input.scorecardIds, 'scorecardIds', 50),
      filter__reviewedUserIds: optionalGongIds(
        input.reviewedUserIds, 'reviewedUserIds', 50,
      ),
    }),
    sanitize: projectGongMetricPage,
  },
  'gong.tasks.list': {
    toolkit: 'gong',
    tool: 'GONG_LIST_TASKS',
    arguments: (input) => ({
      cursor: optionalString(input.cursor, 'cursor', 2_000),
      filter: {
        workspaceId: requiredString(input.workspaceId, 'workspaceId', 256),
        userId: requiredGongId(input.userId, 'userId'),
        status: requiredEnumArray(input.status, 'status', ['OPEN', 'DONE', 'DISMISSED'], 3),
        taskAction: requiredEnumArray(input.actions, 'actions', [
          'CALL', 'EMAIL', 'LINKEDIN_MESSAGE', 'LINKEDIN_CONNECT',
          'LINKEDIN_INTERACT', 'CUSTOM',
        ], 6),
        types: optionalEnumArray(input.types, 'types', ['FLOW', 'ONE_OFF'], 2) ?? [],
      },
    }),
    sanitize: projectGongMetricPage,
  },
  'gong.trackers.list': {
    toolkit: 'gong',
    tool: 'GONG_RETRIEVE_TRACKER_DETAILS_V2_SETTINGS_TRACKERS',
    arguments: (input) => ({
      workspaceId: requiredString(input.workspaceId, 'workspaceId', 256),
    }),
    sanitize: projectGongMetricPage,
  },
  'gong.call_outcomes.list': {
    toolkit: 'gong',
    tool: 'GONG_LIST_CALL_OUTCOMES',
    arguments: () => ({}),
    sanitize: projectGongMetricPage,
  },
  'ads.customers.get': googleAdsReportCapability('customer'),
  'ads.campaigns.get': {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_GET_CAMPAIGN_BY_ID',
    arguments: (input) => ({
      id: requiredGoogleAdsId(input.campaignId, 'campaignId'),
      customer_id: requiredGoogleAdsId(input.customerId, 'customerId'),
    }),
    sanitize: projectGoogleAdsResult,
  },
  'ads.campaigns.report': googleAdsReportCapability('campaign'),
  'ads.ad_groups.report': googleAdsReportCapability('ad_group'),
  'ads.ads.report': googleAdsReportCapability('ad_group_ad'),
  'ads.keywords.report': googleAdsReportCapability('keyword_view'),
  'ads.budgets.report': googleAdsReportCapability('campaign_budget'),
  'ads.campaigns.create_paused': {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_CAMPAIGNS',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      const start = optionalString(input.startDate, 'startDate', 10);
      const end = optionalString(input.endDate, 'endDate', 10);
      return googleAdsMutationArguments(customerId, [{
        operation_type: 'create',
        create: {
          name: requiredString(input.name, 'name', 128),
          status: 'paused',
          advertising_channel_type: 'search',
          campaign_budget: googleAdsResourceName(
            customerId, 'campaignBudgets', input.campaignBudgetId, 'campaignBudgetId',
          ),
          manual_cpc: {},
          contains_eu_political_advertising: input.containsEuPoliticalAdvertising === true
            ? 'CONTAINS_EU_POLITICAL_ADVERTISING'
            : 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...(start ? { start_date_time: `${start} 00:00:00` } : {}),
          ...(end ? { end_date_time: `${end} 23:59:59` } : {}),
        },
      }]);
    },
    sanitize: projectGoogleAdsMutation,
  },
  'ads.campaigns.rename': googleAdsCampaignUpdate('name'),
  'ads.campaigns.pause': googleAdsCampaignUpdate('status', 'paused'),
  'ads.campaigns.enable': googleAdsCampaignUpdate('status', 'enabled'),
  'ads.budgets.create': {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_CAMPAIGN_BUDGETS',
    arguments: (input) => {
      requiredCurrencyCode(input.currencyCode);
      return googleAdsMutationArguments(
        requiredGoogleAdsId(input.customerId, 'customerId'),
        [{ create: {
          name: requiredString(input.name, 'name', 128),
          amount_micros: requiredGoogleAdsAmount(input.amountMicros),
          delivery_method: 'STANDARD',
          period: 'DAILY',
          explicitly_shared: false,
        } }],
      );
    },
    sanitize: projectGoogleAdsMutation,
  },
  'ads.budgets.update_amount': {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_CAMPAIGN_BUDGETS',
    arguments: (input) => {
      requiredCurrencyCode(input.currencyCode);
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      return googleAdsMutationArguments(customerId, [{
        update: {
          resource_name: googleAdsResourceName(
            customerId, 'campaignBudgets', input.campaignBudgetId, 'campaignBudgetId',
          ),
          amount_micros: requiredGoogleAdsAmount(input.amountMicros),
        },
        update_mask: 'amount_micros',
      }]);
    },
    sanitize: projectGoogleAdsMutation,
  },
  'ads.ad_groups.create_paused': {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_AD_GROUPS',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      return googleAdsMutationArguments(customerId, [{ create: {
        name: requiredString(input.name, 'name', 128),
        status: 'PAUSED',
        type: 'SEARCH_STANDARD',
        campaign: googleAdsResourceName(
          customerId, 'campaigns', input.campaignId, 'campaignId',
        ),
      } }]);
    },
    sanitize: projectGoogleAdsMutation,
  },
  'ads.ad_groups.rename': googleAdsAdGroupUpdate('name'),
  'ads.ad_groups.pause': googleAdsAdGroupUpdate('status', 'PAUSED'),
  'ads.ad_groups.enable': googleAdsAdGroupUpdate('status', 'ENABLED'),
  'ads.keywords.create_paused': {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_AD_GROUP_CRITERIA',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      return googleAdsMutationArguments(customerId, [{ create: {
        ad_group: googleAdsResourceName(
          customerId, 'adGroups', input.adGroupId, 'adGroupId',
        ),
        status: 'PAUSED',
        negative: input.negative === true,
        keyword: {
          text: requiredString(input.text, 'text', 80),
          match_type: requiredEnum(input.matchType, 'matchType', ['EXACT', 'PHRASE', 'BROAD']),
        },
        ...(input.cpcBidMicros === undefined
          ? {}
          : { cpc_bid_micros: requiredGoogleAdsAmount(input.cpcBidMicros) }),
      } }]);
    },
    sanitize: projectGoogleAdsMutation,
  },
  'ads.keywords.pause': googleAdsKeywordUpdate('PAUSED'),
  'ads.keywords.enable': googleAdsKeywordUpdate('ENABLED'),
  'ads.ads.create_paused': {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_AD_GROUP_ADS',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      return googleAdsMutationArguments(customerId, [{ create: {
        ad_group: googleAdsResourceName(
          customerId, 'adGroups', input.adGroupId, 'adGroupId',
        ),
        status: 'PAUSED',
        ad: {
          final_urls: requiredUrlArray(input.finalUrls, 'finalUrls', 3),
          responsive_search_ad: {
            headlines: googleAdsTextAssets(input.headlines, 'headlines', 15, 30),
            descriptions: googleAdsTextAssets(input.descriptions, 'descriptions', 4, 90),
          },
        },
      } }]);
    },
    sanitize: projectGoogleAdsMutation,
  },
  'ads.ads.pause': googleAdsAdUpdate('PAUSED'),
  'ads.ads.enable': googleAdsAdUpdate('ENABLED'),
  'youtube.channels.get': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_LIST_CHANNELS',
    arguments: (input) => ({
      id: requiredString(input.channelId, 'channelId', 128),
      part: 'id,snippet,statistics,contentDetails,status',
    }),
    sanitize: projectYouTubeResult,
  },
  'youtube.activities.list': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_GET_CHANNEL_ACTIVITIES',
    arguments: (input) => ({
      channelId: requiredString(input.channelId, 'channelId', 128),
      part: 'id,snippet,contentDetails',
      maxResults: boundedInteger(input.maxResults, 1, 50, 25),
      pageToken: optionalString(input.pageToken, 'pageToken', 2_000),
      publishedAfter: optionalString(input.publishedAfter, 'publishedAfter', 128),
      publishedBefore: optionalString(input.publishedBefore, 'publishedBefore', 128),
    }),
    sanitize: projectYouTubeResult,
  },
  'youtube.videos.list': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_LIST_CHANNEL_VIDEOS',
    arguments: (input) => ({
      channelId: requiredString(input.channelId, 'channelId', 128),
      part: 'id,snippet,contentDetails,status,statistics',
      maxResults: boundedInteger(input.maxResults, 1, 50, 25),
      pageToken: optionalString(input.pageToken, 'pageToken', 2_000),
    }),
    sanitize: projectYouTubeResult,
  },
  'youtube.videos.get': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_GET_VIDEO_DETAILS_BATCH',
    arguments: (input) => ({
      id: requiredStringArray(input.videoIds, 'videoIds', 50, 128),
      parts: ['id', 'snippet', 'contentDetails', 'status', 'statistics'],
    }),
    sanitize: (data, input) => projectSelectedYouTubeVideos(
      data, requiredString(input.channelId, 'channelId', 128),
    ),
  },
  'youtube.captions.list': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_LIST_CAPTION_TRACK',
    arguments: (input) => ({
      video_id: requiredString(input.videoId, 'videoId', 128),
      part: 'id,snippet',
    }),
    sanitize: projectYouTubeResult,
  },
  'youtube.comments.list_replies': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_LIST_COMMENTS',
    arguments: (input) => ({
      parentId: requiredString(input.parentId, 'parentId', 128),
    }),
    sanitize: projectYouTubeResult,
  },
  'youtube.playlists.list': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_LIST_USER_PLAYLISTS',
    arguments: (input) => ({
      part: 'id,snippet,contentDetails,status',
      maxResults: boundedInteger(input.maxResults, 1, 50, 25),
      pageToken: optionalString(input.pageToken, 'pageToken', 2_000),
    }),
    sanitize: (data, input) => projectSelectedYouTubePlaylists(
      data, requiredString(input.channelId, 'channelId', 128),
    ),
  },
  'youtube.playlist_items.list': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_LIST_PLAYLIST_ITEMS',
    arguments: (input) => ({
      playlistId: requiredString(input.playlistId, 'playlistId', 128),
      part: 'id,snippet,contentDetails,status',
      maxResults: boundedInteger(input.maxResults, 1, 50, 25),
      pageToken: optionalString(input.pageToken, 'pageToken', 2_000),
    }),
    sanitize: projectYouTubeResult,
  },
  'youtube.search.public': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_SEARCH_YOU_TUBE',
    arguments: (input) => ({
      q: requiredString(input.query, 'query', 500),
      type: optionalEnum(input.type, 'type', ['channel', 'playlist', 'video']) ?? 'video',
      order: optionalEnum(input.order, 'order', [
        'date', 'rating', 'relevance', 'title', 'videoCount', 'viewCount',
      ]) ?? 'relevance',
      maxResults: boundedInteger(input.maxResults, 1, 25, 10),
      pageToken: optionalString(input.pageToken, 'pageToken', 2_000),
      publishedAfter: optionalString(input.publishedAfter, 'publishedAfter', 128),
      publishedBefore: optionalString(input.publishedBefore, 'publishedBefore', 128),
    }),
    sanitize: projectYouTubeResult,
  },
  'youtube.playlists.create': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_CREATE_PLAYLIST',
    arguments: (input) => ({
      title: requiredContentString(input.title, 'title', 100),
      description: optionalContentString(input.description, 'description', 5_000),
      privacyStatus: requiredEnum(input.privacyStatus, 'privacyStatus', [
        'private', 'unlisted', 'public',
      ]),
    }),
    sanitize: projectYouTubeMutation,
  },
  'youtube.playlists.update': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_UPDATE_PLAYLIST',
    arguments: (input) => ({
      id: requiredString(input.playlistId, 'playlistId', 128),
      snippet: {
        title: requiredContentString(input.title, 'title', 100),
        description: optionalContentString(input.description, 'description', 5_000),
      },
      status: { privacyStatus: requiredEnum(input.privacyStatus, 'privacyStatus', [
        'private', 'unlisted', 'public',
      ]) },
    }),
    sanitize: projectYouTubeMutation,
  },
  'youtube.playlist_items.add': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_ADD_VIDEO_TO_PLAYLIST',
    arguments: (input) => ({
      videoId: requiredString(input.videoId, 'videoId', 128),
      playlistId: requiredString(input.playlistId, 'playlistId', 128),
      position: input.position === undefined
        ? undefined
        : boundedInteger(input.position, 0, 5_000, 0),
    }),
    sanitize: projectYouTubeMutation,
  },
  'youtube.comments.create': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_POST_COMMENT',
    arguments: (input) => ({
      videoId: requiredString(input.videoId, 'videoId', 128),
      channelId: requiredString(input.channelId, 'channelId', 128),
      textOriginal: requiredContentString(input.text, 'text', 10_000),
    }),
    sanitize: projectYouTubeMutation,
  },
  'youtube.comments.reply': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_CREATE_COMMENT_REPLY',
    arguments: (input) => ({
      parentId: requiredString(input.parentId, 'parentId', 128),
      textOriginal: requiredContentString(input.text, 'text', 10_000),
    }),
    sanitize: projectYouTubeMutation,
  },
  'youtube.videos.upload': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_UPLOAD_VIDEO',
    arguments: (input) => ({
      title: requiredContentString(input.title, 'title', 100),
      description: optionalContentString(input.description, 'description', 5_000),
      categoryId: optionalString(input.categoryId, 'categoryId', 3) ?? '22',
      privacyStatus: requiredEnum(input.privacyStatus, 'privacyStatus', [
        'private', 'unlisted', 'public',
      ]),
      tags: optionalStringArray(input.tags, 'tags', 30, 500) ?? [],
      videoFilePath: requiredStagedComposioFile(input[MANAGED_ARTIFACT_ARGUMENT]),
    }),
    sanitize: projectYouTubeMutation,
  },
  'youtube.videos.update': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_UPDATE_VIDEO',
    arguments: (input) => ({
      video_id: requiredString(input.videoId, 'videoId', 128),
      title: optionalContentString(input.title, 'title', 100),
      description: optionalContentString(input.description, 'description', 5_000),
      category_id: optionalString(input.categoryId, 'categoryId', 3),
      privacy_status: optionalEnum(input.privacyStatus, 'privacyStatus', [
        'private', 'unlisted', 'public',
      ]),
      tags: optionalStringArray(input.tags, 'tags', 30, 500),
    }),
    sanitize: projectYouTubeMutation,
  },
  'youtube.thumbnails.set': {
    toolkit: 'youtube',
    tool: 'YOUTUBE_UPDATE_THUMBNAIL',
    arguments: (input) => ({
      videoId: requiredString(input.videoId, 'videoId', 128),
      thumbnailUrl: requiredPublicHttpsUrl(input.thumbnailUrl, 'thumbnailUrl'),
    }),
    sanitize: projectYouTubeMutation,
  },
  'notion.content.search': {
    toolkit: 'notion',
    tool: 'NOTION_FETCH_DATA',
    arguments: (input) => ({
      query: optionalString(input.query, 'query', 2_000),
      fetch_type: optionalEnum(input.type, 'type', ['all', 'pages', 'databases']) ?? 'all',
      page_size: boundedInteger(input.pageSize, 1, 100, 25),
      start_cursor: optionalString(input.startCursor, 'startCursor', 2_000),
    }),
    sanitize: projectNotionSearch,
  },
  'notion.pages.get': {
    toolkit: 'notion',
    tool: 'NOTION_RETRIEVE_PAGE',
    arguments: (input) => ({
      page_id: requiredString(input.pageId, 'pageId', 1_000),
    }),
    sanitize: identityResult,
  },
  'notion.pages.markdown': {
    toolkit: 'notion',
    tool: 'NOTION_GET_PAGE_MARKDOWN',
    arguments: (input) => ({
      page_id: requiredString(input.pageId, 'pageId', 1_000),
      include_transcript: input.includeTranscript === true,
    }),
    sanitize: identityResult,
  },
  'notion.databases.get': {
    toolkit: 'notion',
    tool: 'NOTION_FETCH_DATABASE',
    arguments: (input) => ({
      database_id: requiredString(input.databaseId, 'databaseId', 1_000),
    }),
    sanitize: identityResult,
  },
  'notion.databases.query': {
    toolkit: 'notion',
    tool: 'NOTION_QUERY_DATABASE',
    arguments: (input) => ({
      database_id: requiredString(input.databaseId, 'databaseId', 1_000),
      sorts: notionSorts(input.sorts),
      page_size: boundedInteger(input.pageSize, 1, 100, 50),
      start_cursor: optionalString(input.startCursor, 'startCursor', 2_000),
    }),
    sanitize: identityResult,
  },
  'notion.data_sources.query': {
    toolkit: 'notion',
    tool: 'NOTION_QUERY_DATA_SOURCE',
    arguments: (input) => ({
      data_source_id: requiredString(input.dataSourceId, 'dataSourceId', 1_000),
      page_size: boundedInteger(input.pageSize, 1, 100, 50),
      start_cursor: optionalString(input.startCursor, 'startCursor', 2_000),
      filter_properties: optionalStringArray(input.propertyIds, 'propertyIds', 100, 1_000),
    }),
    sanitize: identityResult,
  },
  'notion.pages.create': {
    toolkit: 'notion',
    tool: 'NOTION_CREATE_NOTION_PAGE',
    arguments: (input) => ({
      parent_id: requiredString(input.parentId, 'parentId', 1_000),
      title: requiredString(input.title, 'title', 2_000),
      markdown: optionalContentString(input.markdown, 'markdown', 100_000),
    }),
    sanitize: projectCreatedArtifact,
  },
  'notion.pages.update_properties': {
    toolkit: 'notion',
    tool: 'NOTION_UPDATE_ROW_DATABASE',
    arguments: (input) => ({
      row_id: requiredString(input.pageId, 'pageId', 1_000),
      delete_row: false,
      properties: notionProperties(input.properties),
    }),
    sanitize: projectCreatedArtifact,
  },
  'notion.pages.append_blocks': {
    toolkit: 'notion',
    tool: 'NOTION_ADD_MULTIPLE_PAGE_CONTENT',
    arguments: (input) => ({
      parent_block_id: requiredString(input.parentBlockId, 'parentBlockId', 1_000),
      after: optionalString(input.afterBlockId, 'afterBlockId', 1_000),
      content_blocks: notionContentBlocks(input.blocks),
    }),
    sanitize: identityResult,
  },
};

const AMBIGUOUS_WRITE_CAPABILITIES = new Set([
  'gmail.drafts.create',
  'gmail.messages.send',
  'calendar.events.create',
  'calendar.events.update',
  'calendar.events.delete',
  'drive.files.create',
  'sheets.spreadsheets.create',
  'sheets.values.update',
  'sheets.values.append',
  'sheets.rows.upsert',
  'sheets.sheets.add',
  'docs.documents.create',
  'docs.documents.create_markdown',
  'docs.documents.insert_text',
  'docs.documents.update_markdown',
  'docs.documents.update_section_markdown',
  'slides.presentations.create',
  'slides.presentations.create_markdown',
  'slides.presentations.copy_template',
  'slides.presentations.batch_update',
  'notion.pages.create',
  'notion.pages.update_properties',
  'notion.pages.append_blocks',
  'hubspot.contacts.create',
  'hubspot.contacts.update',
  'hubspot.companies.create',
  'hubspot.companies.update',
  'hubspot.deals.create',
  'hubspot.deals.update',
  'hubspot.tickets.create',
  'hubspot.tickets.update',
  'hubspot.notes.create',
  'hubspot.tasks.create',
  'hubspot.meetings.create',
  'hubspot.associations.create',
  'ads.campaigns.create_paused',
  'ads.campaigns.rename',
  'ads.campaigns.pause',
  'ads.campaigns.enable',
  'ads.budgets.create',
  'ads.budgets.update_amount',
  'ads.ad_groups.create_paused',
  'ads.ad_groups.rename',
  'ads.ad_groups.pause',
  'ads.ad_groups.enable',
  'ads.keywords.create_paused',
  'ads.keywords.pause',
  'ads.keywords.enable',
  'ads.ads.create_paused',
  'ads.ads.pause',
  'ads.ads.enable',
  'youtube.playlists.create',
  'youtube.playlists.update',
  'youtube.playlist_items.add',
  'youtube.comments.create',
  'youtube.comments.reply',
  'youtube.videos.upload',
  'youtube.videos.update',
  'youtube.thumbnails.set',
]);

const YOUTUBE_WRITE_CAPABILITIES = new Set([
  'youtube.playlists.create',
  'youtube.playlists.update',
  'youtube.playlist_items.add',
  'youtube.comments.create',
  'youtube.comments.reply',
  'youtube.videos.upload',
  'youtube.videos.update',
  'youtube.thumbnails.set',
]);

let warnedMissingAccountOwner = false;
let missingAccountOwnerWarningSink: typeof console.warn | undefined;

function definiteManagedValidationFailure(
  message: string,
  providerToolCallCount = 0,
): ManagedProviderRequestError {
  return new ManagedProviderRequestError('validation_failed', message, {
    remoteCallCount: 1 + providerToolCallCount,
    providerToolCallCount,
    capabilityToolDispatched: false,
    definiteFailure: true,
  });
}

export class ComposioManagedConnectionProvider implements ManagedConnectionProvider {
  readonly id = 'composio';
  private clientPromise: Promise<ComposioClientLike> | undefined;

  constructor(private readonly options: ComposioManagedConnectionProviderOptions) {}

  availability(input: {
    toolkit: string;
    accessLane: ManagedAccessLane;
  }): ManagedProviderAvailability {
    const missingConfiguration: ManagedProviderAvailability['missingConfiguration'] = [];
    if (!this.options.apiKey?.trim()) missingConfiguration.push('api_key_missing');
    if (!this.authConfigId(input.toolkit, input.accessLane)) {
      missingConfiguration.push('auth_config_missing');
    }
    if (input.toolkit === 'googleads' && !this.googleAdsLaneIsAvailable(input.accessLane)) {
      missingConfiguration.push('provider_prerequisite_missing');
    }
    if (input.toolkit === 'youtube' && !this.youtubeQuotaIsProductionReady()) {
      missingConfiguration.push('provider_prerequisite_missing');
    }
    return {
      status: missingConfiguration.length === 0 ? 'ready' : 'missing_configuration',
      missingConfiguration,
    };
  }

  async authorize(input: {
    principalRef: string;
    toolkit: string;
    allowedCapabilities: readonly string[];
    returnUrl?: string;
    signal?: AbortSignal;
  }): Promise<{ authorizationUrl: URL; authorizationRef: string }> {
    const apiKey = this.requireApiKey();
    const connector = requireToolkit(input.toolkit);
    const signal = boundedSignal(input.signal);
    let allocatedAuthorizationRef: string | undefined;
    try {
      const supportedCapabilities = new Set(connector.capabilities.map(({ id }) => id));
      if (input.allowedCapabilities.length === 0 ||
          input.allowedCapabilities.some((capability) => !supportedCapabilities.has(capability))) {
        throw new Error('authorization capabilities are invalid');
      }
      const access = connector.capabilities.some(({ id, accessLane }) =>
        accessLane === 'write' && input.allowedCapabilities.includes(id)) ? 'write' : 'read';
      const authConfigId = this.authConfigId(connector.toolkit, access);
      if (!authConfigId) {
        throw new Error('managed auth config is unavailable');
      }
      const client = await this.client(apiKey);
      if (!client.connectedAccounts) throw new Error('authorization is unavailable');
      const request = await client.connectedAccounts.link(
        input.principalRef,
        authConfigId,
        {
          // Reconnects and multiple Google accounts intentionally allocate a
          // fresh remote account. Runtime sessions still pin one exact account
          // reference, so this does not make tool execution ambiguous.
          allowMultiple: true,
          ...(input.returnUrl ? { callbackUrl: input.returnUrl } : {}),
        },
        { signal },
      );
      if (/^[A-Za-z0-9_.:@-]{1,256}$/.test(request.id)) {
        allocatedAuthorizationRef = request.id;
      }
      if (!request.redirectUrl || !allocatedAuthorizationRef) {
        throw new Error('authorization request is invalid');
      }
      return {
        authorizationUrl: requireHttpsUrl(request.redirectUrl, 'authorization URL'),
        authorizationRef: allocatedAuthorizationRef,
      };
    } catch (error) {
      const httpStatus = safeHttpStatus(error);
      console.error(JSON.stringify({
        event: 'chickpea.managed_connection.authorization_start_failed',
        adapterId: 'composio',
        toolkit: connector.toolkit,
        errorName: safeErrorName(error),
        ...(httpStatus ? { httpStatus } : {}),
      }));
      // Preserve the only safe handle to the newly allocated Composio account.
      // The route records and deletes it before abandoning local attempt state.
      if (allocatedAuthorizationRef) {
        throw new ManagedAuthorizationAllocatedError(allocatedAuthorizationRef);
      }
      throw new Error('Composio managed authorization could not be started');
    }
  }

  async pollAuthorization(input: {
    authorizationRef: string;
    principalRef: string;
    toolkit: string;
    signal?: AbortSignal;
  }): Promise<ManagedAuthorizationPollResult> {
    if (!/^[A-Za-z0-9_.:@-]{1,256}$/.test(input.authorizationRef) ||
        !/^[A-Za-z0-9_.:@-]{1,256}$/.test(input.principalRef)) {
      throw new Error('Composio managed authorization could not be inspected');
    }
    const connector = requireToolkit(input.toolkit);
    return this.inspectAuthorization({
      authorizationRef: input.authorizationRef,
      principalRef: input.principalRef,
      toolkit: connector.toolkit,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async discoverResources(input: {
    policy: ConnectionAccountManagedPolicy;
    resourceKey: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{
    resources: Array<{ providerRef: string; label: string }>;
    nextCursor?: string;
  }> {
    const apiKey = this.requireApiKey();
    this.validateCapabilities(input.policy);
    const connector = requireToolkit(input.policy.toolkit);
    if (!connector.resources?.some(({ key }) => key === input.resourceKey)) {
      throw new Error('Managed resource key is unsupported');
    }
    const signal = boundedSignal(input.signal);
    try {
      const client = await this.client(apiKey);
      if (input.policy.toolkit === 'google_search_console' && input.resourceKey === 'siteUrls') {
        const cursor = managedResourceCursor(input.cursor);
        if (cursor.providerCursor) throw new Error('Search Console resource cursor is invalid');
        const result = await executeComposioTool(client, input.policy, {
          toolkit: 'google_search_console',
          tool: 'GOOGLE_SEARCH_CONSOLE_LIST_SITES',
          arguments: {},
          signal,
        });
        if (result.error) throw new Error('Search Console site discovery failed');
        return managedResourcePage(searchConsoleSites(result.data), cursor);
      }
      if (input.policy.toolkit === 'google_analytics' && input.resourceKey === 'propertyIds') {
        const cursor = managedResourceCursor(input.cursor, true);
        const result = await executeComposioTool(client, input.policy, {
          toolkit: 'google_analytics',
          tool: 'GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES',
          arguments: {
            pageSize: 200,
            pageToken: cursor.providerCursor,
          },
          signal,
        });
        if (result.error) throw new Error('Analytics property discovery failed');
        const page = analyticsProperties(result.data);
        return managedResourcePage(page.resources, cursor, page.nextCursor);
      }
      if (input.policy.toolkit === 'gong' && input.resourceKey === 'workspaceIds') {
        const cursor = managedResourceCursor(input.cursor);
        if (cursor.providerCursor) throw new Error('Gong workspace cursor is invalid');
        const result = await executeComposioTool(client, input.policy, {
          toolkit: 'gong',
          tool: 'GONG_LIST_ALL_COMPANY_WORKSPACES_V2_WORKSPACES',
          arguments: {},
          signal,
        });
        if (result.error) throw new Error('Gong workspace discovery failed');
        return managedResourcePage(gongWorkspaces(result.data), cursor);
      }
      if (input.policy.toolkit === 'googleads' && input.resourceKey === 'customerIds') {
        const page = await discoverGoogleAdsClientResources(
          client,
          input.policy,
          signal,
          input.cursor,
        );
        if (page.resources.length === 0 && !page.nextCursor) {
          throw new Error('Google Ads client customer discovery returned no accounts');
        }
        return page;
      }
      if (input.policy.toolkit === 'youtube' && input.resourceKey === 'channelIds') {
        const cursor = managedResourceCursor(input.cursor);
        if (cursor.providerCursor) throw new Error('YouTube channel cursor is invalid');
        const result = await executeComposioTool(client, input.policy, {
          toolkit: 'youtube',
          tool: 'YOUTUBE_LIST_CHANNELS',
          arguments: {
            mine: true,
            part: 'id,snippet,statistics,contentDetails,status',
            maxResults: 50,
          },
          signal,
        });
        if (result.error) throw new Error('YouTube channel discovery failed');
        const resources = youtubeChannels(result.data);
        if (resources.length === 0) throw new Error('YouTube channel discovery returned no channels');
        return managedResourcePage(resources, cursor);
      }
      throw new Error('Managed resource discovery is unsupported');
    } catch {
      throw new Error('Composio managed resource discovery failed');
    }
  }

  async validate(input: {
    policy: ConnectionAccountManagedPolicy;
    signal?: AbortSignal;
  }): Promise<{
    grantSummary?: {
      items: Array<{ type: 'page' | 'database'; label: string }>;
      truncated: boolean;
    };
  } | void> {
    const apiKey = this.requireApiKey();
    this.validateCapabilities(input.policy);
    const signal = boundedSignal(input.signal);
    try {
      const account = await (
        this.options.getConnectedAccount ?? getComposioConnectedAccount
      )({
        apiKey,
        accountRef: input.policy.accountRef,
        principalRef: input.policy.principalRef,
        signal,
      });
      this.observeMissingAccountOwner(account);
      if (
        account.id !== input.policy.accountRef ||
        (account.userId !== undefined && account.userId !== input.policy.principalRef) ||
        account.status !== 'ACTIVE' ||
        account.isDisabled ||
        account.toolkit.toLowerCase() !== input.policy.toolkit.toLowerCase()
      ) {
        throw new ManagedAuthorizationExpiredError({
          remoteCallCount: 1,
          providerToolCallCount: 0,
          capabilityToolDispatched: false,
          definiteFailure: true,
        });
      }
      const capability = COMPOSIO_CAPABILITIES[input.policy.allowedCapabilities[0] ?? ''];
      if (!capability) {
        throw definiteManagedValidationFailure('connection has no supported capabilities');
      }
      try {
        requireToolkitVersion(capability.toolkit);
      } catch {
        throw definiteManagedValidationFailure('Composio toolkit version is not pinned');
      }
      if (input.policy.toolkit === 'hubspot') {
        const client = await this.client(apiKey);
        const result = await executeComposioTool(client, input.policy, {
          toolkit: 'hubspot',
          tool: 'HUBSPOT_GET_ACCOUNT_INFO',
          arguments: {},
          signal,
        });
        const portal = result.error ? {} : projectHubSpotAccount(result.data);
        if (typeof portal.portalId !== 'string') {
          throw definiteManagedValidationFailure(
            'HubSpot portal identity verification failed',
            1,
          );
        }
      }
      if (input.policy.toolkit === 'gong') {
        const client = await this.client(apiKey);
        const result = await executeComposioTool(client, input.policy, {
          toolkit: 'gong',
          tool: 'GONG_LIST_ALL_COMPANY_WORKSPACES_V2_WORKSPACES',
          arguments: {},
          signal,
        });
        const accessible = result.error ? [] : gongWorkspaces(result.data);
        if (accessible.length === 0) {
          throw definiteManagedValidationFailure('Gong workspace verification failed', 1);
        }
        const accessibleIds = new Set(accessible.map(({ providerRef }) => providerRef));
        const selected = input.policy.resourceConstraints?.workspaceIds ?? [];
        if (selected.some(({ providerRef }) => !accessibleIds.has(providerRef))) {
          throw definiteManagedValidationFailure('Gong workspace is no longer accessible', 1);
        }
      }
      if (input.policy.toolkit === 'googleads') {
        const client = await this.client(apiKey);
        const selected = input.policy.resourceConstraints?.customerIds ?? [];
        await validateGoogleAdsSelectedCustomers(client, input.policy, selected, signal);
      }
      if (input.policy.toolkit === 'youtube') {
        const client = await this.client(apiKey);
        const result = await executeComposioTool(client, input.policy, {
          toolkit: 'youtube',
          tool: 'YOUTUBE_LIST_CHANNELS',
          arguments: {
            mine: true,
            part: 'id,snippet,statistics,contentDetails,status',
            maxResults: 50,
          },
          signal,
        });
        const accessible = result.error ? [] : youtubeChannels(result.data);
        const accessibleIds = new Set(accessible.map(({ providerRef }) => providerRef));
        const selected = input.policy.resourceConstraints?.channelIds ?? [];
        if (accessible.length === 0 ||
            selected.some(({ providerRef }) => !accessibleIds.has(providerRef))) {
          throw definiteManagedValidationFailure(
            'Selected YouTube channel is no longer accessible',
            1,
          );
        }
      }
      if (input.policy.toolkit === 'notion') {
        const search = COMPOSIO_CAPABILITIES['notion.content.search'];
        if (!search) {
          throw definiteManagedValidationFailure('Notion grant verification is unavailable');
        }
        const client = await this.client(apiKey);
        const result = await executeComposioTool(client, input.policy, {
          toolkit: search.toolkit,
          tool: search.tool,
          arguments: {
            fetch_type: 'all',
            page_size: 20,
          },
          signal,
        });
        if (result.error) {
          throw definiteManagedValidationFailure('Notion grant verification failed', 1);
        }
        return { grantSummary: notionGrantSummary(result.data) };
      }
    } catch (error) {
      if (error instanceof ManagedAuthorizationExpiredError ||
          error instanceof ManagedProviderRequestError) throw error;
      throw new ManagedProviderRequestError(
        'provider_unavailable',
        'Composio managed connection health could not be verified',
        {
          remoteCallCount: 1,
          providerToolCallCount: 0,
          capabilityToolDispatched: false,
        },
      );
    }
  }

  async execute(input: ManagedConnectionExecutionInput): Promise<ManagedConnectionExecutionResult> {
    let apiKey: string;
    try {
      apiKey = this.requireApiKey();
    } catch {
      throw new ManagedProviderRequestError(
        'provider_unavailable',
        'Composio managed connections are not configured',
        { remoteCallCount: 0, providerToolCallCount: 0, capabilityToolDispatched: false },
      );
    }
    const capability = COMPOSIO_CAPABILITIES[input.capability];
    if (!capability || capability.toolkit !== input.policy.toolkit) {
      throw new ManagedProviderRequestError(
        'validation_failed',
        'Composio capability is not supported by this managed connection',
        { remoteCallCount: 0, providerToolCallCount: 0, capabilityToolDispatched: false },
      );
    }
    let executionArguments: Record<string, unknown>;
    let toolArguments: Record<string, unknown> | undefined;
    let providerVersion: string;
    let signal: AbortSignal;
    try {
      this.validateCapabilities(input.policy);
      // Local shape errors are actionable and must not be disguised as
      // provider failures or trigger a connected-account status probe.
      const connector = requireToolkit(input.policy.toolkit);
      executionArguments = injectManagedResourceArguments(
        connector,
        input.policy,
        input.arguments,
      );
      validateManagedResourceMetadata(input.policy, input.capability, executionArguments);
      toolArguments = input.capability === 'youtube.videos.upload'
        ? undefined
        : capability.arguments(executionArguments);
      providerVersion = requireToolkitVersion(capability.toolkit);
      signal = boundedSignal(input.signal);
    } catch (error) {
      if (error instanceof ManagedProviderRequestError) throw error;
      throw new ManagedProviderRequestError(
        'validation_failed',
        error instanceof Error ? error.message : 'Managed connection request is invalid',
        {
          providerTool: capability.tool,
          remoteCallCount: 0,
          providerToolCallCount: 0,
          capabilityToolDispatched: false,
        },
      );
    }
    let remoteCallCount = 0;
    let providerToolCallCount = 0;
    let capabilityToolDispatched = false;
    try {
      const client = await this.client(apiKey);
      // Validate the exact publishing identity before staging customer bytes
      // into Composio. Ambiguous Brand-channel credentials must fail without
      // the artifact leaving Chickpea's invocation sandbox.
      if (capability.toolkit === 'youtube') {
        const preflight = await validateYouTubeExecutionTarget(
          client,
          input.policy,
          input.capability,
          executionArguments,
          signal,
        );
        remoteCallCount += preflight.remoteCallCount;
        providerToolCallCount += preflight.providerToolCallCount;
      }
      if (input.capability === 'youtube.videos.upload') {
        const artifact = requireManagedArtifact(executionArguments[MANAGED_ARTIFACT_ARGUMENT]);
        const staged = await stageComposioFile({
          apiKey,
          artifact,
          tool: capability.tool,
          toolkit: capability.toolkit,
          signal,
        });
        remoteCallCount += 2;
        toolArguments = capability.arguments({
          ...executionArguments,
          [MANAGED_ARTIFACT_ARGUMENT]: staged,
        });
      }
      if (!toolArguments) throw new Error('Composio capability arguments are unavailable');
      let result: {
        data: Record<string, unknown>;
        error?: string | null | undefined;
        successful?: boolean | undefined;
        logId?: string | undefined;
      };
      if (client.tools) {
        capabilityToolDispatched = true;
        remoteCallCount += 1;
        providerToolCallCount += 1;
        result = await client.tools.execute(capability.tool, {
          userId: input.policy.principalRef,
          connectedAccountId: input.policy.accountRef,
          version: providerVersion,
          arguments: toolArguments,
        }, { signal });
      } else {
        // Test/compatibility seam for injected clients. Production clients use
        // the version-pinned direct execution path above.
        remoteCallCount += 1;
        const session = await client.sessions.create(
          input.policy.principalRef,
          sessionConfig(input.policy, capability.tool),
          { signal },
        );
        remoteCallCount += 1;
        providerToolCallCount += 1;
        capabilityToolDispatched = true;
        result = await session.execute(
          capability.tool,
          toolArguments,
          undefined,
          { signal },
        );
      }
      if (result.successful === false) {
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'Composio reported that the managed connection request did not succeed',
          {
            providerTool: capability.tool,
            providerVersion,
            remoteCallCount,
            providerToolCallCount,
            capabilityToolDispatched,
            definiteFailure: true,
            ...(result.logId ? { providerLogId: result.logId } : {}),
          },
        );
      }
      if (result.error) throw new Error('remote execution failed');
      recordExecution(input.policy, input.capability, result.logId);
      let sanitizedData = capability.sanitize(result.data, executionArguments);
      if (capability.toolkit === 'youtube' && YOUTUBE_WRITE_CAPABILITIES.has(input.capability)) {
        const verification = await verifyYouTubeWrite({
          client,
          policy: input.policy,
          capability: input.capability,
          input: executionArguments,
          mutation: result.data,
          signal,
        });
        remoteCallCount += verification.remoteCallCount;
        providerToolCallCount += verification.providerToolCallCount;
        if (!verification.verified) {
          throw new ManagedProviderRequestError(
            'ambiguous',
            'YouTube accepted the write but Chickpea could not verify the remote resource; do not retry automatically',
            {
              providerTool: verification.providerTool ?? capability.tool,
              providerVersion,
              remoteCallCount,
              providerToolCallCount,
              capabilityToolDispatched,
            },
          );
        }
        sanitizedData = {
          ...sanitizedData,
          verification: {
            verified: true,
            resourceId: verification.resourceId,
            providerTool: verification.providerTool,
            result: verification.data,
          },
        };
      }
      const quotaRemaining = capability.toolkit === 'google_analytics'
        ? analyticsQuotaRemaining(result.data)
        : undefined;
      return {
        data: sanitizedData,
        ...(result.logId ? { logId: result.logId } : {}),
        providerTool: capability.tool,
        providerVersion,
        remoteCallCount,
        providerToolCallCount,
        ...(quotaRemaining === undefined ? {} : { rateLimitRemaining: quotaRemaining }),
      };
    } catch (error) {
      if (error instanceof ManagedProviderRequestError) {
        if (error.code === 'provider_unavailable' &&
            error.metadata.capabilityToolDispatched === true &&
            error.metadata.definiteFailure !== true &&
            AMBIGUOUS_WRITE_CAPABILITIES.has(input.capability)) {
          throw ambiguousManagedWriteFailure(
            capability.tool,
            providerVersion,
            error.metadata,
          );
        }
        throw error;
      }
      if (signal.aborted && capabilityToolDispatched &&
          AMBIGUOUS_WRITE_CAPABILITIES.has(input.capability)) {
        throw new ManagedProviderRequestError('ambiguous',
          'Composio managed write timed out and may have completed; verify before retrying',
          {
            providerTool: capability.tool,
            providerVersion,
            remoteCallCount,
            providerToolCallCount,
            capabilityToolDispatched,
          },
        );
      }
      if (error instanceof ManagedAuthorizationExpiredError) throw error;
      const httpStatus = safeHttpStatus(error);
      const rateLimitRemaining = safeHeaderInteger(error, 'x-ratelimit-remaining');
      const retryAfterMs = safeRetryAfterMs(error);
      if (httpStatus === 429) {
        throw new ManagedProviderRequestError('throttled',
          'Composio rate limit reached; retry after the provider delay',
          {
            providerTool: capability.tool,
            providerVersion,
            remoteCallCount,
            providerToolCallCount,
            capabilityToolDispatched,
            httpStatus,
            ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          },
        );
      }
      if (capabilityToolDispatched && AMBIGUOUS_WRITE_CAPABILITIES.has(input.capability) &&
          (httpStatus === undefined || httpStatus >= 500)) {
        throw ambiguousManagedWriteFailure(capability.tool, providerVersion, {
          remoteCallCount,
          providerToolCallCount,
          capabilityToolDispatched,
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
        });
      }
      if (httpStatus !== undefined && httpStatus >= 500) {
        throw new ManagedProviderRequestError('provider_unavailable',
          'Composio managed connection request failed',
          {
            providerTool: capability.tool,
            providerVersion,
            remoteCallCount,
            providerToolCallCount,
            capabilityToolDispatched,
            httpStatus,
            ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
          },
        );
      }
      remoteCallCount += 1;
      if (!signal.aborted && await this.authorizationUnavailable(apiKey, input.policy, signal)) {
        throw new ManagedAuthorizationExpiredError({
          providerTool: capability.tool,
          providerVersion,
          remoteCallCount,
          providerToolCallCount,
          capabilityToolDispatched,
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
        });
      }
      throw new ManagedProviderRequestError('provider_unavailable',
        'Composio managed connection request failed',
        {
          providerTool: capability.tool,
          providerVersion,
          remoteCallCount,
          providerToolCallCount,
          capabilityToolDispatched,
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
        },
      );
    }
  }

  quotaBudget(input: {
    toolkit: string;
    bucket: string;
  }): { limit: number; timeZone: 'America/Los_Angeles' } | undefined {
    if (input.toolkit !== 'youtube' || !this.youtubeQuotaIsProductionReady()) return undefined;
    const defaults = {
      general_units: 10_000,
      search_calls: 100,
      video_insert_calls: 100,
    } as const;
    const configured = input.bucket === 'general_units'
      ? this.options.youtubeGeneralDailyQuota
      : input.bucket === 'search_calls'
      ? this.options.youtubeSearchDailyLimit
      : input.bucket === 'video_insert_calls'
      ? this.options.youtubeUploadDailyLimit
      : undefined;
    const fallback = defaults[input.bucket as keyof typeof defaults];
    if (!fallback) return undefined;
    return {
      limit: quotaLimit(configured, fallback)!,
      timeZone: 'America/Los_Angeles',
    };
  }

  async revoke(input: {
    policy: ConnectionAccountManagedPolicy;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.cleanupRemoteAccount({
      accountRef: input.policy.accountRef,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async cleanupRemoteAccount(input: {
    accountRef: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const apiKey = this.requireApiKey();
    const signal = boundedSignal(input.signal);
    try {
      await (this.options.revokeAccount ?? revokeComposioAccount)({
        apiKey,
        accountRef: input.accountRef,
        signal,
      });
    } catch {
      throw new Error('Composio managed connection could not be revoked');
    }
  }

  private validateCapabilities(policy: ConnectionAccountManagedPolicy): void {
    for (const capabilityName of policy.allowedCapabilities) {
      const capability = COMPOSIO_CAPABILITIES[capabilityName];
      if (!capability || capability.toolkit !== policy.toolkit) {
        throw new Error('Composio capability is not supported by this managed connection');
      }
    }
  }

  private requireApiKey(): string {
    const apiKey = this.options.apiKey?.trim();
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not configured');
    return apiKey;
  }

  private async authorizationUnavailable(
    apiKey: string,
    policy: ConnectionAccountManagedPolicy,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const account = await (
        this.options.getConnectedAccount ?? getComposioConnectedAccount
      )({
        apiKey,
        accountRef: policy.accountRef,
        principalRef: policy.principalRef,
        signal,
      });
      this.observeMissingAccountOwner(account);
      return account.id !== policy.accountRef ||
        (account.userId !== undefined && account.userId !== policy.principalRef) ||
        account.status !== 'ACTIVE' ||
        account.isDisabled ||
        account.toolkit.toLowerCase() !== policy.toolkit.toLowerCase();
    } catch (error) {
      if (error instanceof ManagedAuthorizationExpiredError) return true;
      // A failed status check may be a transient Composio outage or a bad
      // project key. Do not mislabel the user's Google grant in that case.
      return false;
    }
  }

  private authConfigId(
    toolkit: string,
    access: ManagedAccessLane,
  ): string | undefined {
    const value = this.options.authConfigIds?.[toolkit]?.[access]?.trim();
    return isComposioAuthConfigId(value) ? value : undefined;
  }

  private googleAdsLaneIsAvailable(accessLane: ManagedAccessLane): boolean {
    const accessLevel = this.options.googleAdsAccessLevel?.trim().toLowerCase();
    const permissibleUse = this.options.googleAdsPermissibleUse?.trim().toLowerCase();
    // Standard auth configs use Composio's managed Google Ads app, so there is
    // no operator-owned developer-token tier for Chickpea to assert. Explorer
    // also covers every operation in Chickpea's curated surface; Google blocks
    // its restricted account, user, planning, and billing methods upstream and
    // Chickpea does not expose those methods in the first place.
    if (!accessLevel && !permissibleUse) return true;
    if (accessLevel === 'explorer') return true;
    if (!['basic', 'standard'].includes(accessLevel ?? '')) return false;
    return accessLane === 'read'
      ? ['reporting', 'ad_management'].includes(permissibleUse ?? '')
      : permissibleUse === 'ad_management';
  }

  private youtubeQuotaIsProductionReady(): boolean {
    const defaults = [10_000, 100, 100] as const;
    const limits = [
      quotaLimit(this.options.youtubeGeneralDailyQuota, defaults[0]),
      quotaLimit(this.options.youtubeSearchDailyLimit, defaults[1]),
      quotaLimit(this.options.youtubeUploadDailyLimit, defaults[2]),
    ];
    if (limits.some((limit) => limit === undefined)) return false;
    const raised = limits.some((limit, index) => limit! > defaults[index]!);
    return !raised || this.options.youtubeQuotaAuditApproved?.trim().toLowerCase() === 'true';
  }

  private client(apiKey: string): Promise<ComposioClientLike> {
    // Default provider registries are request-scoped. Sharing construction only
    // within this instance avoids carrying SDK I/O across Worker requests.
    if (!this.clientPromise) {
      const createClient = this.options.createClient ?? createComposioClient;
      const attempt = Promise.resolve().then(() => createClient({ apiKey }));
      this.clientPromise = attempt;
      void attempt.catch(() => {
        if (this.clientPromise === attempt) this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  private observeMissingAccountOwner(account: ComposioConnectedAccount): void {
    if (account.userId !== undefined ||
        warnedMissingAccountOwner && missingAccountOwnerWarningSink === console.warn) return;
    warnedMissingAccountOwner = true;
    missingAccountOwnerWarningSink = console.warn;
    console.warn(JSON.stringify({
      event: 'chickpea.managed_connection.account_owner_unavailable',
      adapterId: 'composio',
      toolkit: account.toolkit,
    }));
  }

  private async inspectAuthorization(input: {
    authorizationRef: string;
    principalRef: string;
    toolkit: string;
    signal?: AbortSignal;
  }): Promise<ManagedAuthorizationPollResult> {
    let account: ComposioConnectedAccount;
    try {
      account = await (
        this.options.getConnectedAccount ?? getComposioConnectedAccount
      )({
        apiKey: this.requireApiKey(),
        accountRef: input.authorizationRef,
        principalRef: input.principalRef,
        signal: boundedSignal(input.signal),
      });
    } catch (error) {
      if (error instanceof ManagedAuthorizationExpiredError) {
        return { status: 'terminal', reason: 'expired' };
      }
      if (error instanceof ManagedProviderRequestError) throw error;
      throw new ManagedProviderRequestError(
        'provider_unavailable',
        'Composio managed authorization could not be inspected',
        {
          remoteCallCount: 1,
          providerToolCallCount: 0,
          capabilityToolDispatched: false,
          definiteFailure: false,
        },
      );
    }
    this.observeMissingAccountOwner(account);
    if (account.id !== input.authorizationRef || account.toolkit !== input.toolkit ||
        account.userId !== undefined && account.userId !== input.principalRef) {
      return { status: 'terminal', reason: 'failed' };
    }
    if (account.isDisabled) return { status: 'terminal', reason: 'disabled' };
    const status = account.status.toUpperCase();
    if (status === 'ACTIVE') {
      return {
        status: 'active',
        accountRef: account.id,
        toolkit: account.toolkit,
      };
    }
    if (status === 'INITIALIZING' || status === 'INITIATED') return { status: 'pending' };
    if (status === 'EXPIRED') return { status: 'terminal', reason: 'expired' };
    if (status === 'REVOKED') return { status: 'terminal', reason: 'revoked' };
    if (status === 'INACTIVE') return { status: 'terminal', reason: 'inactive' };
    return { status: 'terminal', reason: 'failed' };
  }
}

export type ManagedAuthorizationPollResult =
  | { status: 'pending' }
  | { status: 'active'; accountRef: string; toolkit: string }
  | {
      status: 'terminal';
      reason: 'disabled' | 'expired' | 'failed' | 'inactive' | 'revoked';
    };

function ambiguousManagedWriteFailure(
  providerTool: string,
  providerVersion: string,
  metadata: ManagedProviderRequestError['metadata'],
): ManagedProviderRequestError {
  const { definiteFailure: _definiteFailure, ...safeMetadata } = metadata;
  return new ManagedProviderRequestError(
    'ambiguous',
    'Composio managed write may have completed; verify the remote state before retrying',
    {
      ...safeMetadata,
      providerTool,
      providerVersion,
      capabilityToolDispatched: true,
    },
  );
}

async function executeComposioTool(
  client: ComposioClientLike,
  policy: ConnectionAccountManagedPolicy,
  input: {
    toolkit: string;
    tool: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  },
): Promise<{
  data: Record<string, unknown>;
  error?: string | null | undefined;
  successful?: boolean | undefined;
  logId?: string | undefined;
}> {
  const version = requireToolkitVersion(input.toolkit);
  let result: {
    data: Record<string, unknown>;
    error?: string | null | undefined;
    successful?: boolean | undefined;
    logId?: string | undefined;
  };
  if (client.tools) {
    result = await client.tools.execute(input.tool, {
      userId: policy.principalRef,
      connectedAccountId: policy.accountRef,
      version,
      arguments: input.arguments,
    }, { signal: input.signal });
  } else {
    const session = await client.sessions.create(
      policy.principalRef,
      sessionConfig(policy, input.tool),
      { signal: input.signal },
    );
    result = await session.execute(input.tool, input.arguments, undefined, { signal: input.signal });
  }
  return result.successful === false && !result.error
    ? { ...result, error: 'remote execution failed' }
    : result;
}

async function validateYouTubeExecutionTarget(
  client: ComposioClientLike,
  policy: ConnectionAccountManagedPolicy,
  capability: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ remoteCallCount: number; providerToolCallCount: number }> {
  const channelId = requiredString(input.channelId, 'channelId', 128);
  if ([
    'youtube.captions.list',
    'youtube.comments.create',
    'youtube.videos.update',
    'youtube.thumbnails.set',
  ].includes(capability)) {
    const result = await executeComposioTool(client, policy, {
      toolkit: 'youtube',
      tool: 'YOUTUBE_GET_VIDEO_DETAILS_BATCH',
      arguments: {
        id: [requiredString(input.videoId, 'videoId', 128)],
        parts: ['id', 'snippet'],
      },
      signal,
    });
    if (result.error || !youtubeVideosBelongToChannel(result.data, channelId)) {
      throw youtubeTargetValidationError(
        'YouTube video is not owned by the selected channel',
        client,
        1,
        'YOUTUBE_GET_VIDEO_DETAILS_BATCH',
      );
    }
    if (capability === 'youtube.captions.list') {
      return composioAuxiliaryCallCounts(client, 1);
    }
    const actor = await validateUnambiguousYouTubeActor(client, policy, channelId, signal);
    return addAuxiliaryCallCounts(composioAuxiliaryCallCounts(client, 1), actor);
  }
  if ([
    'youtube.playlists.update',
    'youtube.playlist_items.add',
    'youtube.playlist_items.list',
  ].includes(capability)) {
    const playlistId = requiredString(input.playlistId, 'playlistId', 128);
    let pageToken: string | undefined;
    let calls = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await executeComposioTool(client, policy, {
        toolkit: 'youtube',
        tool: 'YOUTUBE_LIST_USER_PLAYLISTS',
        arguments: {
          part: 'id,snippet',
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        },
        signal,
      });
      calls += 1;
      if (result.error) break;
      if (youtubePlaylistBelongsToChannel(result.data, playlistId, channelId)) {
        const ownership = composioAuxiliaryCallCounts(client, calls);
        if (capability === 'youtube.playlist_items.list') return ownership;
        const actor = await validateUnambiguousYouTubeActor(
          client, policy, channelId, signal,
        );
        return addAuxiliaryCallCounts(ownership, actor);
      }
      const next = youtubeNextPageToken(result.data);
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    throw youtubeTargetValidationError(
      'YouTube playlist is not owned by the selected channel',
      client,
      calls,
      'YOUTUBE_LIST_USER_PLAYLISTS',
    );
  }
  if ([
    'youtube.playlists.create',
    'youtube.comments.reply',
    'youtube.videos.upload',
  ].includes(capability)) {
    return validateUnambiguousYouTubeActor(client, policy, channelId, signal);
  }
  return { remoteCallCount: 0, providerToolCallCount: 0 };
}

async function validateUnambiguousYouTubeActor(
  client: ComposioClientLike,
  policy: ConnectionAccountManagedPolicy,
  channelId: string,
  signal: AbortSignal,
): Promise<{ remoteCallCount: number; providerToolCallCount: number }> {
  const result = await executeComposioTool(client, policy, {
    toolkit: 'youtube',
    tool: 'YOUTUBE_LIST_CHANNELS',
    arguments: {
      mine: true,
      part: 'id,snippet',
      maxResults: 50,
    },
    signal,
  });
  const channels = result.error ? [] : youtubeChannels(result.data);
  if (channels.length !== 1 || channels[0]?.providerRef !== channelId) {
    throw youtubeTargetValidationError(
      'YouTube write identity is ambiguous; reconnect the exact Brand channel account',
      client,
      1,
      'YOUTUBE_LIST_CHANNELS',
    );
  }
  return composioAuxiliaryCallCounts(client, 1);
}

function youtubeTargetValidationError(
  message: string,
  client: ComposioClientLike,
  calls: number,
  providerTool: string,
): ManagedProviderRequestError {
  const counts = composioAuxiliaryCallCounts(client, calls);
  return new ManagedProviderRequestError('validation_failed', message, {
    providerTool,
    providerVersion: requireToolkitVersion('youtube'),
    ...counts,
    capabilityToolDispatched: false,
  });
}

function composioAuxiliaryCallCounts(
  client: ComposioClientLike,
  providerToolCallCount: number,
): { remoteCallCount: number; providerToolCallCount: number } {
  return {
    remoteCallCount: providerToolCallCount * (client.tools ? 1 : 2),
    providerToolCallCount,
  };
}

function addAuxiliaryCallCounts(
  left: { remoteCallCount: number; providerToolCallCount: number },
  right: { remoteCallCount: number; providerToolCallCount: number },
): { remoteCallCount: number; providerToolCallCount: number } {
  return {
    remoteCallCount: left.remoteCallCount + right.remoteCallCount,
    providerToolCallCount: left.providerToolCallCount + right.providerToolCallCount,
  };
}

interface YouTubeWriteVerification {
  verified: boolean;
  resourceId?: string;
  providerTool?: string;
  data?: Record<string, unknown>;
  remoteCallCount: number;
  providerToolCallCount: number;
}

async function verifyYouTubeWrite(input: {
  client: ComposioClientLike;
  policy: ConnectionAccountManagedPolicy;
  capability: string;
  input: Record<string, unknown>;
  mutation: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<YouTubeWriteVerification> {
  const counts = { remoteCallCount: 0, providerToolCallCount: 0 };
  const execute = async (
    tool: string,
    arguments_: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>; error?: string | null | undefined } | undefined> => {
    const callCounts = composioAuxiliaryCallCounts(input.client, 1);
    counts.remoteCallCount += callCounts.remoteCallCount;
    counts.providerToolCallCount += callCounts.providerToolCallCount;
    try {
      return await executeComposioTool(input.client, input.policy, {
        toolkit: 'youtube', tool, arguments: arguments_, signal: input.signal,
      });
    } catch {
      return undefined;
    }
  };
  const base = (providerTool: string, resourceId?: string) => ({
    ...counts,
    providerTool,
    ...(resourceId ? { resourceId } : {}),
  });
  const channelId = requiredString(input.input.channelId, 'channelId', 128);

  if ([
    'youtube.videos.upload',
    'youtube.videos.update',
    'youtube.thumbnails.set',
  ].includes(input.capability)) {
    const providerTool = 'YOUTUBE_GET_VIDEO_DETAILS_BATCH';
    const resourceId = input.capability === 'youtube.videos.upload'
      ? youtubeMutationResourceId(input.mutation)
      : requiredString(input.input.videoId, 'videoId', 128);
    if (!resourceId) return { verified: false, ...base(providerTool) };
    const result = await execute(providerTool, {
      id: [resourceId],
      parts: ['id', 'snippet', 'status'],
    });
    const verified = Boolean(
      result && !result.error && youtubeVideosBelongToChannel(result.data, channelId),
    );
    return {
      verified,
      ...base(providerTool, resourceId),
      ...(verified && result ? { data: projectYouTubeResult(result.data) } : {}),
    };
  }

  if (['youtube.playlists.create', 'youtube.playlists.update'].includes(input.capability)) {
    const providerTool = 'YOUTUBE_LIST_USER_PLAYLISTS';
    const resourceId = input.capability === 'youtube.playlists.create'
      ? youtubeMutationResourceId(input.mutation)
      : requiredString(input.input.playlistId, 'playlistId', 128);
    if (!resourceId) return { verified: false, ...base(providerTool) };
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await execute(providerTool, {
        part: 'id,snippet,status',
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      });
      if (!result || result.error) break;
      if (youtubePlaylistBelongsToChannel(result.data, resourceId, channelId)) {
        return {
          verified: true,
          ...base(providerTool, resourceId),
          data: projectYouTubeResult(result.data),
        };
      }
      const next = youtubeNextPageToken(result.data);
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    return { verified: false, ...base(providerTool, resourceId) };
  }

  if (input.capability === 'youtube.playlist_items.add') {
    const providerTool = 'YOUTUBE_LIST_PLAYLIST_ITEMS';
    const playlistId = requiredString(input.input.playlistId, 'playlistId', 128);
    const videoId = requiredString(input.input.videoId, 'videoId', 128);
    const result = await execute(providerTool, {
      playlistId,
      videoId,
      part: 'id,snippet,contentDetails,status',
      maxResults: 50,
    });
    const verified = Boolean(
      result && !result.error && youtubePlaylistContainsVideo(result.data, playlistId, videoId),
    );
    return {
      verified,
      ...base(providerTool, youtubeMutationResourceId(input.mutation)),
      ...(verified && result ? { data: projectYouTubeResult(result.data) } : {}),
    };
  }

  if (['youtube.comments.create', 'youtube.comments.reply'].includes(input.capability)) {
    const providerTool = 'YOUTUBE_LIST_COMMENTS';
    const resourceId = youtubeMutationResourceId(input.mutation);
    if (!resourceId) return { verified: false, ...base(providerTool) };
    const result = await execute(providerTool, {
      id: resourceId,
      part: 'id,snippet',
      textFormat: 'plainText',
    });
    const verified = Boolean(
      result && !result.error && youtubeItems(result.data)
        .some((item) => youtubeResourceId(item) === resourceId),
    );
    return {
      verified,
      ...base(providerTool, resourceId),
      ...(verified && result ? { data: projectYouTubeResult(result.data) } : {}),
    };
  }

  return { verified: false, ...counts };
}

async function stageComposioFile(input: {
  apiKey: string;
  artifact: ManagedConnectionArtifact;
  tool: string;
  toolkit: string;
  signal: AbortSignal;
}): Promise<{ name: string; mimetype: string; s3key: string }> {
  const digest = [...md5(input.artifact.bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const request = await fetch('https://backend.composio.dev/api/v3.1/files/upload/request', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
    },
    body: JSON.stringify({
      filename: input.artifact.name,
      mimetype: input.artifact.mimeType,
      md5: digest,
      tool_slug: input.tool,
      toolkit_slug: input.toolkit,
    }),
    signal: input.signal,
  });
  if (!request.ok) throw httpError('Composio file staging request failed', request);
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error('Composio file staging response was invalid');
  const key = body.key;
  const signedUrl = body.new_presigned_url;
  const metadata = body.metadata;
  if (typeof key !== 'string' || !key.trim() || key.length > 2_000 ||
      typeof signedUrl !== 'string' || !isRecord(metadata) ||
      !['s3', 'azure_blob_storage'].includes(String(metadata.storage_backend))) {
    throw new Error('Composio file staging response was invalid');
  }
  const uploadUrl = approvedComposioUploadUrl(signedUrl);
  const headers: Record<string, string> = { 'content-type': input.artifact.mimeType };
  if (metadata.storage_backend === 'azure_blob_storage') headers['x-ms-blob-type'] = 'BlockBlob';
  const bytes = new Uint8Array(input.artifact.bytes.byteLength);
  bytes.set(input.artifact.bytes);
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers,
    body: bytes,
    signal: input.signal,
  });
  if (!upload.ok) throw httpError('Composio file staging upload failed', upload);
  return { name: input.artifact.name, mimetype: input.artifact.mimeType, s3key: key };
}

function requireManagedArtifact(value: unknown): ManagedConnectionArtifact {
  if (!isRecord(value) || typeof value.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,255}$/.test(value.name) ||
      typeof value.mimeType !== 'string' ||
      !['video/mp4', 'video/webm', 'video/quicktime'].includes(value.mimeType) ||
      !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 12 ||
      value.bytes.byteLength > 8 * 1024 * 1024 ||
      typeof value.workspaceId !== 'string' || !value.workspaceId ||
      typeof value.agentId !== 'string' || !value.agentId ||
      value.retention !== 'invocation') {
    throw new Error('Managed connection artifact is invalid');
  }
  return value as unknown as ManagedConnectionArtifact;
}

function requiredStagedComposioFile(value: unknown): {
  name: string; mimetype: string; s3key: string;
} {
  if (!isRecord(value) || typeof value.name !== 'string' ||
      typeof value.mimetype !== 'string' || typeof value.s3key !== 'string' ||
      !value.name || value.name.length > 256 || !value.mimetype || value.mimetype.length > 128 ||
      !value.s3key || value.s3key.length > 2_000) {
    throw new Error('Staged Composio file is invalid');
  }
  return { name: value.name, mimetype: value.mimetype, s3key: value.s3key };
}

function approvedComposioUploadUrl(value: string): URL {
  const url = requireHttpsUrl(value, 'Composio upload URL');
  const host = url.hostname.toLowerCase();
  if (!(host === 'storage.composio.dev' || host.endsWith('.composio.dev') ||
        host.endsWith('.amazonaws.com') || host.endsWith('.blob.core.windows.net'))) {
    throw new Error('Composio upload URL host is not approved');
  }
  return url;
}

function httpError(message: string, response: Response): Error {
  return Object.assign(new Error(message), { status: response.status, headers: response.headers });
}

async function discoverGoogleAdsClientResources(
  client: ComposioClientLike,
  policy: ConnectionAccountManagedPolicy,
  signal: AbortSignal,
  cursorValue?: string,
): Promise<{
  resources: Array<{ providerRef: string; label: string; currencyCode?: string }>;
  nextCursor?: string;
}> {
  const rootsResult = await executeComposioTool(client, policy, {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
    arguments: {},
    signal,
  });
  if (rootsResult.error) throw new Error('Google Ads accessible customer discovery failed');
  // Accessible-customer ordering is not a provider cursor contract. Sort it
  // and bind our cursor to the complete set so reordering is harmless while
  // additions/removals fail closed instead of silently skipping a customer.
  const rootIds = googleAdsAccessibleCustomerIds(rootsResult.data).sort();
  if (rootIds.length > 2_000) {
    console.warn(JSON.stringify({
      event: 'chickpea.managed_connection.google_ads_root_limit_exceeded',
      adapterId: 'composio',
      toolkit: 'googleads',
    }));
    throw new Error('Google Ads accessible customer root limit exceeded');
  }
  const cursor = parseGoogleAdsDiscoveryCursor(cursorValue);
  const rootsVersion = googleAdsRootSetVersion(rootIds);
  if (cursor && cursor.rootsVersion !== rootsVersion) {
    throw new Error('Google Ads customer cursor is stale');
  }
  const requiresCurrency = policy.allowedCapabilities.some((capability) =>
    capability === 'ads.budgets.create' || capability === 'ads.budgets.update_amount'
  );
  let rootIndex = cursor
    ? rootIds.indexOf(cursor.rootId)
    : 0;
  if (rootIndex < 0) throw new Error('Google Ads customer cursor is stale');
  let pageToken = cursor?.pageToken;
  let offset = cursor?.offset ?? 0;
  let rootIsManager = cursor?.managerRoot === true || Boolean(pageToken) || offset > 0;
  const resources: Array<{ providerRef: string; label: string; currencyCode?: string }> = [];
  const seen = new Set<string>();
  let providerCalls = 1;
  const nextPage = (): {
    resources: Array<{ providerRef: string; label: string; currencyCode?: string }>;
    nextCursor?: string;
  } => {
    const rootId = rootIds[rootIndex];
    return {
      resources,
      ...(rootId ? {
        nextCursor: serializeGoogleAdsDiscoveryCursor({
          rootId,
          rootsVersion,
          offset,
          ...(pageToken ? { pageToken } : {}),
          ...(rootIsManager ? { managerRoot: true as const } : {}),
        }),
      } : {}),
    };
  };
  while (rootIndex < rootIds.length) {
    if (providerCalls >= 25) return nextPage();
    const rootId = rootIds[rootIndex]!;
    if (!rootIsManager) {
      const identityResult = await executeComposioTool(client, policy, {
        toolkit: 'googleads',
        tool: 'GOOGLEADS_SEARCH_STREAM_GAQL',
        arguments: {
          customer_id: rootId,
          query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, ' +
            'customer.time_zone, customer.manager, customer.status, customer.test_account ' +
            'FROM customer LIMIT 1',
          summary_row_setting: 'NO_SUMMARY_ROW',
        },
        signal,
      });
      providerCalls += 1;
      if (identityResult.error) throw new Error('Google Ads customer identity discovery failed');
      const identities = googleAdsCustomerResources(identityResult.data);
      const root = identities.find(({ providerRef }) => providerRef === rootId) ?? identities[0];
      if (root && !root.manager) {
        if (pageToken || offset !== 0) throw new Error('Google Ads customer cursor is invalid');
        if (!seen.has(root.providerRef) && (!requiresCurrency || root.currencyCode)) {
          seen.add(root.providerRef);
          resources.push({
            providerRef: root.providerRef,
            label: root.label,
            ...(root.currencyCode ? { currencyCode: root.currencyCode } : {}),
          });
        }
        rootIndex += 1;
        pageToken = undefined;
        offset = 0;
        rootIsManager = false;
        if (resources.length >= MANAGED_RESOURCE_PAGE_SIZE) return nextPage();
        continue;
      }
      rootIsManager = true;
    }
    if (providerCalls >= 25) return nextPage();
    const childrenResult = await executeComposioTool(client, policy, {
      toolkit: 'googleads',
      tool: 'GOOGLEADS_LIST_SUB_ACCOUNTS',
      arguments: {
        customer_id: rootId,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      signal,
    });
    providerCalls += 1;
    if (childrenResult.error) throw new Error('Google Ads client customer discovery failed');
    const children = googleAdsCustomerResources(childrenResult.data)
      .filter(({ manager }) => !manager);
    if (offset > children.length) throw new Error('Google Ads customer cursor is invalid');
    let consumed = 0;
    for (const child of children.slice(offset)) {
      consumed += 1;
      if (!seen.has(child.providerRef) && (!requiresCurrency || child.currencyCode)) {
        seen.add(child.providerRef);
        resources.push({
          providerRef: child.providerRef,
          label: child.label,
          ...(child.currencyCode ? { currencyCode: child.currencyCode } : {}),
        });
      }
      if (resources.length >= MANAGED_RESOURCE_PAGE_SIZE) {
        offset += consumed;
        return nextPage();
      }
    }
    const next = googleAdsNextPageToken(childrenResult.data);
    if (next && next !== pageToken) {
      pageToken = next;
      offset = 0;
    } else {
      rootIndex += 1;
      pageToken = undefined;
      offset = 0;
      rootIsManager = false;
    }
  }
  return { resources };
}

interface GoogleAdsDiscoveryCursor {
  rootId: string;
  rootsVersion: string;
  pageToken?: string;
  offset: number;
  managerRoot?: true;
}

function parseGoogleAdsDiscoveryCursor(value: string | undefined): GoogleAdsDiscoveryCursor | undefined {
  if (!value) return undefined;
  if (!value.startsWith('ga:') || value.length > 2_000) {
    throw new Error('Google Ads customer cursor is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value.slice(3)));
  } catch {
    throw new Error('Google Ads customer cursor is invalid');
  }
  if (!isRecord(parsed) || !/^\d{1,20}$/.test(String(parsed.rootId ?? '')) ||
      !/^[a-f0-9]{32}$/.test(String(parsed.rootsVersion ?? '')) ||
      !Number.isInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > 2_000 ||
      parsed.pageToken !== undefined && (
        typeof parsed.pageToken !== 'string' || !parsed.pageToken || parsed.pageToken.length > 1_000
      ) || parsed.managerRoot !== undefined && parsed.managerRoot !== true) {
    throw new Error('Google Ads customer cursor is invalid');
  }
  return {
    rootId: String(parsed.rootId),
    rootsVersion: String(parsed.rootsVersion),
    offset: Number(parsed.offset),
    ...(typeof parsed.pageToken === 'string' ? { pageToken: parsed.pageToken } : {}),
    ...(parsed.managerRoot === true ? { managerRoot: true as const } : {}),
  };
}

function serializeGoogleAdsDiscoveryCursor(cursor: GoogleAdsDiscoveryCursor): string {
  return `ga:${encodeURIComponent(JSON.stringify(cursor))}`;
}

function googleAdsRootSetVersion(rootIds: readonly string[]): string {
  return [...md5(new TextEncoder().encode(rootIds.join('\n')))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function validateGoogleAdsSelectedCustomers(
  client: ComposioClientLike,
  policy: ConnectionAccountManagedPolicy,
  selected: Array<{ providerRef: string; currencyCode?: string }>,
  signal: AbortSignal,
): Promise<void> {
  const requiresCurrency = policy.allowedCapabilities.some((capability) =>
    capability === 'ads.budgets.create' || capability === 'ads.budgets.update_amount'
  );
  for (let offset = 0; offset < selected.length; offset += 8) {
    await Promise.all(selected.slice(offset, offset + 8).map(async (selection) => {
      const { providerRef } = selection;
      const result = await executeComposioTool(client, policy, {
        toolkit: 'googleads',
        tool: 'GOOGLEADS_SEARCH_STREAM_GAQL',
        arguments: {
          customer_id: providerRef,
          query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, ' +
            'customer.time_zone, customer.manager, customer.status, customer.test_account ' +
            'FROM customer LIMIT 1',
          summary_row_setting: 'NO_SUMMARY_ROW',
        },
        signal,
      });
      const customer = result.error
        ? undefined
        : googleAdsCustomerResources(result.data)
          .find((candidate) => candidate.providerRef === providerRef && !candidate.manager);
      if (!customer || requiresCurrency && (
        !selection.currencyCode || customer.currencyCode !== selection.currencyCode
      )) {
        throw definiteManagedValidationFailure(
          'Google Ads client customer is no longer accessible',
          1,
        );
      }
    }));
  }
}

function googleAdsAccessibleCustomerIds(data: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  collectGoogleAdsCustomerIds(data, ids, 0);
  return [...ids];
}

function collectGoogleAdsCustomerIds(
  value: unknown,
  ids: Set<string>,
  depth: number,
): void {
  if (depth > 5 || ids.size >= 2_001) return;
  if (typeof value === 'string') {
    const match = /^(?:customers\/)?(\d{1,20})$/.exec(value.trim());
    if (match?.[1]) ids.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectGoogleAdsCustomerIds(entry, ids, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (/resource.?names?|customers?|customer.?ids?/i.test(key)) {
      collectGoogleAdsCustomerIds(entry, ids, depth + 1);
    } else if (depth < 2 && (key === 'data' || key === 'results' || key === 'items')) {
      collectGoogleAdsCustomerIds(entry, ids, depth + 1);
    }
  }
}

function googleAdsCustomerResources(data: Record<string, unknown>): Array<{
  providerRef: string;
  label: string;
  manager: boolean;
  currencyCode?: string;
}> {
  const records: Record<string, unknown>[] = [];
  collectGoogleAdsCustomerRecords(data, records, 0);
  const seen = new Set<string>();
  return records.flatMap((record) => {
    const rawId = firstString(record, [
      'id', 'customerId', 'customer_id', 'clientCustomer', 'client_customer',
      'resourceName', 'resource_name',
    ]);
    const match = rawId && /(?:^|customers\/)(\d{1,20})$/.exec(rawId.replaceAll('-', ''));
    const providerRef = match?.[1];
    if (!providerRef || seen.has(providerRef)) return [];
    seen.add(providerRef);
    const name = firstString(record, ['descriptiveName', 'descriptive_name', 'name']);
    const rawCurrency = firstString(record, ['currencyCode', 'currency_code']);
    const currencyCode = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency)
      ? rawCurrency
      : undefined;
    const status = firstString(record, ['status']);
    const manager = record.manager === true || record.isManager === true || record.is_manager === true;
    const test = record.testAccount === true || record.test_account === true;
    const parts = [name || `Google Ads ${providerRef}`, providerRef];
    if (currencyCode) parts.push(currencyCode);
    if (status && /^[A-Z_]{2,40}$/i.test(status)) parts.push(status.toUpperCase());
    if (test) parts.push('TEST');
    return [{
      providerRef,
      label: parts.join(' · ').slice(0, 240),
      manager,
      ...(currencyCode ? { currencyCode } : {}),
    }];
  });
}

function collectGoogleAdsCustomerRecords(
  value: unknown,
  records: Record<string, unknown>[],
  depth: number,
): void {
  if (depth > 6 || records.length >= 2_001) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectGoogleAdsCustomerRecords(entry, records, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  const customer = firstRecord(value, ['customer', 'customerClient', 'customer_client']);
  if (customer) records.push(customer);
  if (firstString(value, [
    'customerId', 'customer_id', 'clientCustomer', 'client_customer',
    'resourceName', 'resource_name',
  ])) records.push(value);
  for (const key of ['data', 'results', 'items', 'customers', 'customerClients', 'customer_clients']) {
    if (key in value) collectGoogleAdsCustomerRecords(value[key], records, depth + 1);
  }
}

function googleAdsNextPageToken(data: Record<string, unknown>): string | undefined {
  const source = isRecord(data.data) ? data.data : data;
  const token = firstString(source, ['nextPageToken', 'next_page_token', 'nextCursor']);
  return token && token.length <= 2_000 ? token : undefined;
}

export async function createComposioClient(
  input: { apiKey: string },
): Promise<ComposioClientLike> {
  const { Composio } = await import('@composio/core');
  const client = new Composio({
    apiKey: input.apiKey,
    allowTracking: false,
    sensitiveFileUploadProtection: true,
  });
  return {
    authConfigs: {
      list: (query, requestOptions) => client.authConfigs.list(query, requestOptions),
      create: (toolkit, options, requestOptions) =>
        client.authConfigs.create(toolkit, options, requestOptions),
      get: (id, requestOptions) => client.authConfigs.get(id, requestOptions),
    },
    connectedAccounts: {
      link: (userId, authConfigId, options, requestOptions) =>
        client.connectedAccounts.link(userId, authConfigId, options, requestOptions),
      get: (id, requestOptions) => client.connectedAccounts.get(id, requestOptions),
    },
    sessions: {
      create: (userId, config, requestOptions) =>
        client.sessions.create(userId, config, requestOptions),
    },
    tools: {
      execute: (tool, body, requestOptions) => client.tools.execute(
        tool,
        body,
        requestOptions,
      ),
    },
  };
}

async function getComposioConnectedAccount(input: {
  apiKey: string;
  accountRef: string;
  principalRef: string;
  signal: AbortSignal;
}): Promise<ComposioConnectedAccount> {
  let remoteCallCount = 0;
  const requestAccounts = async (filterByPrincipal: boolean): Promise<unknown[]> => {
    const url = new URL('https://backend.composio.dev/api/v3.1/connected_accounts');
    url.searchParams.append('connected_account_ids', input.accountRef);
    if (filterByPrincipal) url.searchParams.append('user_ids', input.principalRef);
    url.searchParams.set('limit', '1');
    const response = await fetch(url, {
      headers: { 'x-api-key': input.apiKey },
      signal: input.signal,
    });
    remoteCallCount += 1;
    if (!response.ok) {
      throw new ManagedProviderRequestError(
        'provider_unavailable',
        'Composio connected account health could not be checked',
        {
          remoteCallCount,
          providerToolCallCount: 0,
          capabilityToolDispatched: false,
          httpStatus: response.status,
          definiteFailure: false,
        },
      );
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new Error('Composio connected account response was invalid');
    }
    return body.items;
  };

  const filtered = await requestAccounts(true);
  let account = filtered.find((item) => isRecord(item) && item.id === input.accountRef);
  const matchedPrincipalFilter = account !== undefined;
  if (account === undefined) {
    const unfiltered = await requestAccounts(false);
    account = unfiltered.find((item) => isRecord(item) && item.id === input.accountRef);
  }
  if (account === undefined) {
    throw new ManagedAuthorizationExpiredError({
      remoteCallCount,
      providerToolCallCount: 0,
      capabilityToolDispatched: false,
      definiteFailure: true,
    });
  }
  if (!matchedPrincipalFilter && isRecord(account) && account.user_id === undefined) {
    console.error(JSON.stringify({
      event: 'chickpea.managed_connection.account_owner_verification_unavailable',
      adapterId: 'composio',
    }));
    throw new ManagedProviderRequestError(
      'provider_unavailable',
      'Composio connected account ownership could not be verified',
      {
        remoteCallCount,
        providerToolCallCount: 0,
        capabilityToolDispatched: false,
        definiteFailure: false,
      },
    );
  }
  if (
    !isRecord(account) ||
    typeof account.id !== 'string' ||
    typeof account.status !== 'string' ||
    typeof account.is_disabled !== 'boolean' ||
    ('user_id' in account && typeof account.user_id !== 'string') ||
    !isRecord(account.toolkit) ||
    typeof account.toolkit.slug !== 'string' ||
    !/^[A-Za-z0-9_.:@-]{1,256}$/.test(account.id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(account.toolkit.slug)
  ) {
    throw new Error('Composio connected account response was invalid');
  }
  return {
    id: account.id,
    status: account.status,
    isDisabled: account.is_disabled,
    toolkit: account.toolkit.slug.toLowerCase(),
    ...(typeof account.user_id === 'string' ? { userId: account.user_id } : {}),
  };
}

/**
 * Inspect one exact connected account through the ownership-filtered REST API.
 * Reconciliation shares this path with runtime validation so it never relies
 * on SDK response fields that omit the remote account owner.
 */
export async function inspectComposioConnectedAccount(input: {
  apiKey: string;
  accountRef: string;
  principalRef: string;
  toolkit: string;
  signal: AbortSignal;
}): Promise<'match' | 'missing' | 'mismatch' | 'transient'> {
  let account: ComposioConnectedAccount;
  try {
    account = await getComposioConnectedAccount(input);
  } catch (error) {
    if (error instanceof ManagedAuthorizationExpiredError) return 'missing';
    return 'transient';
  }
  if (account.id !== input.accountRef || account.toolkit !== input.toolkit.toLowerCase() ||
      account.userId !== undefined && account.userId !== input.principalRef) {
    return 'mismatch';
  }
  if (account.isDisabled) return 'missing';
  const status = account.status.toUpperCase();
  if (status === 'ACTIVE') return 'match';
  if (status === 'INITIALIZING' || status === 'INITIATED') return 'transient';
  return 'missing';
}

async function revokeComposioAccount(input: {
  apiKey: string;
  accountRef: string;
  signal: AbortSignal;
}): Promise<void> {
  const accountId = encodeURIComponent(input.accountRef);
  // Delete only this Composio account. Google revocation is grant-wide for a
  // user/OAuth-client pair: a live canary proved that revoke_on_delete=true on
  // one duplicate Calendar account immediately invalidates its sibling. Since
  // Composio does not expose a stable non-secret upstream identity for every
  // Google toolkit, Chickpea cannot decide whether a sibling shares the grant.
  const response = await fetch(
    `https://backend.composio.dev/api/v3.1/connected_accounts/${accountId}?revoke_on_delete=false`,
    {
      method: 'DELETE',
      headers: { 'x-api-key': input.apiKey },
      signal: input.signal,
    },
  );
  if (response.status === 404) return;
  if (response.ok) {
    const body: unknown = await response.json();
    if (!isRecord(body) || body.success !== true) {
      throw new Error('Composio connected account cleanup response was invalid');
    }
    console.info(JSON.stringify({
      event: 'chickpea.managed_connection.remote_account_deleted',
      adapterId: 'composio',
      accountRef: input.accountRef,
    }));
    return;
  }
  throw new Error(`Composio connected account cleanup failed with HTTP ${response.status}`);
}

function sessionConfig(
  policy: ConnectionAccountManagedPolicy,
  tool: string,
): Record<string, unknown> {
  return {
    toolkits: [policy.toolkit],
    tools: { [policy.toolkit]: { enable: [tool] } },
    connectedAccounts: { [policy.toolkit]: policy.accountRef },
    manageConnections: false,
    sessionPreset: 'direct_tools',
    sandbox: { enable: false },
  };
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(name) ? name : 'UnknownError';
}

function safeHttpStatus(error: unknown): number | undefined {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && isRecord(current) && !visited.has(current); depth += 1) {
    visited.add(current);
    for (const value of [current.status, current.statusCode]) {
      if (Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599) {
        return Number(value);
      }
    }
    current = current.cause;
  }
  return undefined;
}

function safeHeaderInteger(error: unknown, name: string): number | undefined {
  const value = safeHeader(error, name);
  if (!value || !/^\d{1,12}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function safeRetryAfterMs(error: unknown): number | undefined {
  const seconds = safeHeaderInteger(error, 'retry-after');
  return seconds === undefined ? undefined : Math.min(seconds * 1_000, 86_400_000);
}

function safeHeader(error: unknown, name: string): string | undefined {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && isRecord(current) && !visited.has(current); depth += 1) {
    visited.add(current);
    const headers = current.headers;
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (isRecord(headers)) {
      const value = headers[name] ?? headers[name.toLowerCase()];
      if (typeof value === 'string' && value.length <= 128) return value;
    }
    current = current.cause;
  }
  return undefined;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${name} is invalid`);
  return normalized;
}

function analyticsDateRange(input: Record<string, unknown>): Record<string, string> {
  return {
    startDate: requiredString(input.startDate, 'startDate', 10),
    endDate: requiredString(input.endDate, 'endDate', 10),
  };
}

function analyticsNamedFields(
  value: unknown,
  name: string,
  maxItems: number,
  required = false,
): Array<{ name: string }> | undefined {
  if (value === undefined && !required) return undefined;
  const values = requiredStringArray(value, name, maxItems, 128);
  return values.map((field) => ({ name: field }));
}

function analyticsPivotArguments(input: Record<string, unknown>): Record<string, unknown> {
  const rowDimensions = requiredStringArray(input.rowDimensions, 'rowDimensions', 3, 128);
  const columnDimensions = input.columnDimensions === undefined
    ? []
    : requiredStringArray(input.columnDimensions, 'columnDimensions', 2, 128);
  const dimensions = [...rowDimensions, ...columnDimensions];
  const pivots: Record<string, unknown>[] = [{
    fieldNames: rowDimensions,
    limit: boundedInteger(input.rowLimit, 1, 1_000, 100),
    offset: boundedInteger(input.offset, 0, 100_000, 0),
  }];
  if (columnDimensions.length > 0) {
    pivots.push({
      fieldNames: columnDimensions,
      limit: boundedInteger(input.columnLimit, 1, 100, 20),
    });
  }
  return {
    property: requiredString(input.property, 'property', 1_000),
    dateRanges: [analyticsDateRange(input)],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: analyticsNamedFields(input.metrics, 'metrics', 5, true),
    pivots,
    returnPropertyQuota: input.returnPropertyQuota === true,
  };
}

function analyticsFunnelArguments(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 10) {
    throw new Error('steps are invalid');
  }
  const steps = input.steps.map((step) => {
    if (!isRecord(step)) throw new Error('funnel step is invalid');
    return {
      name: requiredString(step.name, 'step name', 80),
      isDirectlyFollowedBy: false,
      filterExpression: {
        funnelEventFilter: {
          eventName: requiredString(step.eventName, 'eventName', 40),
        },
      },
    };
  });
  const breakdown = optionalString(input.breakdownDimension, 'breakdownDimension', 128);
  return {
    property: requiredString(input.property, 'property', 1_000),
    dateRanges: [analyticsDateRange(input)],
    funnel: { isOpenFunnel: input.openFunnel === true, steps },
    ...(breakdown ? { funnelBreakdown: { breakdownDimension: { name: breakdown } } } : {}),
    limit: boundedInteger(input.limit, 1, 1_000, 100),
    returnPropertyQuota: input.returnPropertyQuota === true,
  };
}

function analyticsQuotaRemaining(data: Record<string, unknown>): number | undefined {
  const quota = isRecord(data.propertyQuota)
    ? data.propertyQuota
    : isRecord(data.property_quota) ? data.property_quota : undefined;
  if (!quota) return undefined;
  const remaining: number[] = [];
  for (const value of Object.values(quota)) {
    if (!isRecord(value)) continue;
    const candidate = value.remaining;
    if (Number.isInteger(candidate) && Number(candidate) >= 0) remaining.push(Number(candidate));
  }
  return remaining.length ? Math.min(...remaining) : undefined;
}

type HubSpotObjectType = keyof typeof HUBSPOT_OBJECT_PROPERTIES;

function hubSpotCreateCapability(
  objectType: HubSpotObjectType,
  fields: Readonly<Record<string, string>>,
): ComposioCapability {
  return {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_CREATE_CRM_OBJECT_WITH_PROPERTIES',
    arguments: (input) => ({
      objectType,
      properties: hubSpotWriteProperties(input, fields, false),
      associations: [],
    }),
    sanitize: (data) => projectHubSpotRecord(data, objectType),
  };
}

function hubSpotUpdateCapability(
  objectType: HubSpotObjectType,
  fields: Readonly<Record<string, string>>,
): ComposioCapability {
  return {
    toolkit: 'hubspot',
    tool: 'HUBSPOT_PARTIALLY_UPDATE_CRM_OBJECT_BY_ID',
    arguments: (input) => ({
      objectType,
      objectId: requiredString(input.objectId, 'objectId', 256),
      properties: hubSpotWriteProperties(input, fields, true),
    }),
    sanitize: (data) => projectHubSpotRecord(data, objectType),
  };
}

function hubSpotSearchArguments(input: Record<string, unknown>): Record<string, unknown> {
  const objectType = hubSpotObjectType(input.objectType);
  let filterGroups: Array<{ filters: Array<Record<string, string>> }> | undefined;
  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters) || input.filters.length > 6) {
      throw new Error('filters are invalid');
    }
    filterGroups = [{
      filters: input.filters.map((filter) => {
        if (!isRecord(filter)) throw new Error('filter is invalid');
        const propertyName = hubSpotReadProperty(objectType, filter.property);
        const operator = optionalEnum(filter.operator, 'operator', [
          'EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN',
          'NOT_CONTAINS_TOKEN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY',
        ]);
        if (!operator) throw new Error('filter operator is invalid');
        const value = optionalString(filter.value, 'filter value', 2_000);
        const valueFree = operator === 'HAS_PROPERTY' || operator === 'NOT_HAS_PROPERTY';
        if (valueFree !== (value === undefined)) throw new Error('filter value is invalid');
        return { propertyName, operator, ...(value ? { value } : {}) };
      }),
    }];
  }
  let sorts: Array<{ propertyName: string; direction: string }> | undefined;
  if (input.sort !== undefined) {
    if (!isRecord(input.sort)) throw new Error('sort is invalid');
    const propertyName = hubSpotReadProperty(objectType, input.sort.property);
    const direction = optionalEnum(input.sort.direction, 'direction', ['ascending', 'descending']);
    if (!direction) throw new Error('sort direction is invalid');
    sorts = [{ propertyName, direction: direction === 'ascending' ? 'ASCENDING' : 'DESCENDING' }];
  }
  const after = optionalString(input.after, 'after', 4);
  if (after && (!/^\d{1,4}$/.test(after) || Number(after) >= 10_000)) {
    throw new Error('after is invalid');
  }
  return {
    objectType,
    query: optionalString(input.query, 'query', 2_000),
    filterGroups,
    sorts,
    properties: hubSpotReadProperties(objectType, input.properties),
    after,
    limit: boundedInteger(input.limit, 1, 100, 25),
  };
}

function hubSpotObjectType(value: unknown): HubSpotObjectType {
  if (typeof value !== 'string' || !HUBSPOT_OBJECT_TYPES.includes(value as HubSpotObjectType)) {
    throw new Error('HubSpot object type is invalid');
  }
  return value as HubSpotObjectType;
}

function requiredHubSpotAssociationType(value: unknown, name: string): string {
  const normalized = requiredString(value, name, 32);
  if (!['contacts', 'companies', 'deals', 'tickets'].includes(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requiredHubSpotPipelineType(value: unknown): string {
  const normalized = requiredString(value, 'objectType', 32);
  if (normalized !== 'deals' && normalized !== 'tickets') {
    throw new Error('objectType is invalid');
  }
  return normalized;
}

function requiredHubSpotAssociationCategory(value: unknown): string {
  const category = optionalEnum(value, 'associationCategory', [
    'HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED',
  ]);
  if (!category) throw new Error('associationCategory is invalid');
  return category;
}

function hubSpotAssociationObjectTypes(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) throw new Error(`${name} is invalid`);
  return value.map((entry) => requiredHubSpotAssociationType(entry, name));
}

function hubSpotReadProperties(
  objectType: HubSpotObjectType,
  value: unknown,
): string[] {
  if (value === undefined) return [...HUBSPOT_OBJECT_PROPERTIES[objectType]];
  if (!Array.isArray(value) || value.length > 20 || value.length < 1) {
    throw new Error('properties are invalid');
  }
  return value.map((entry) => hubSpotReadProperty(objectType, entry));
}

function hubSpotReadProperty(objectType: HubSpotObjectType, value: unknown): string {
  const property = requiredString(value, 'property', 128);
  if (!HUBSPOT_OBJECT_PROPERTIES[objectType].includes(property)) {
    throw new Error('HubSpot property is not allowlisted');
  }
  return property;
}

function hubSpotWriteProperties(
  input: Record<string, unknown>,
  fields: Readonly<Record<string, string>>,
  allowObjectId: boolean,
): Record<string, string> {
  const allowedInput = new Set([
    ...Object.keys(fields),
    ...(allowObjectId ? ['objectId'] : []),
  ]);
  if (Object.keys(input).some((key) => !allowedInput.has(key))) {
    throw new Error('HubSpot capability arguments are invalid');
  }
  const properties: Record<string, string> = {};
  for (const [localName, providerName] of Object.entries(fields)) {
    const value = input[localName];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      if (!value.trim() || value.length > 65_536) throw new Error(`${localName} is invalid`);
      properties[providerName] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      properties[providerName] = String(value);
      continue;
    }
    throw new Error(`${localName} is invalid`);
  }
  if (Object.keys(properties).length === 0) throw new Error('HubSpot properties are required');
  return properties;
}

function projectHubSpotAccount(data: Record<string, unknown>): Record<string, unknown> {
  const source = hubSpotPayload(data);
  const hubId = source.hubId ?? source.hub_id ?? source.portalId ?? source.portal_id;
  const portalId = typeof hubId === 'string' && /^\d{1,32}$/.test(hubId)
    ? hubId
    : Number.isSafeInteger(hubId) && Number(hubId) > 0 ? String(hubId) : undefined;
  const email = firstString(source, ['email', 'userEmail', 'user_email']);
  const userId = source.userId ?? source.user_id;
  return {
    ...(portalId ? { portalId } : {}),
    ...(email && email.length <= 320 ? { email } : {}),
    ...(typeof userId === 'string' && userId.length <= 256 || Number.isSafeInteger(userId)
      ? { userId: String(userId) }
      : {}),
  };
}

function projectHubSpotPage(
  data: Record<string, unknown>,
  objectType: HubSpotObjectType,
  requestedProperties?: unknown,
): Record<string, unknown> {
  const source = hubSpotPayload(data);
  const results = firstArray(source, ['results', 'items'])
    .flatMap((entry) => isRecord(entry)
      ? [projectHubSpotRecord(entry, objectType, requestedProperties)]
      : []);
  const paging = isRecord(source.paging) ? source.paging : undefined;
  const next = paging && isRecord(paging.next) ? paging.next : undefined;
  const nextCursor = next ? firstString(next, ['after', 'cursor']) : undefined;
  const total = Number.isSafeInteger(source.total) && Number(source.total) >= 0
    ? Number(source.total)
    : undefined;
  return {
    objectType,
    results,
    ...(nextCursor && nextCursor.length <= 256 ? { nextCursor } : {}),
    ...(total === undefined ? {} : { total }),
  };
}

function projectHubSpotRecord(
  data: Record<string, unknown>,
  objectType: HubSpotObjectType,
  requestedProperties?: unknown,
): Record<string, unknown> {
  const source = hubSpotPayload(data);
  const propertiesSource = isRecord(source.properties) ? source.properties : {};
  const properties: Record<string, string | number | boolean | null> = {};
  const projectedProperties = requestedProperties === undefined
    ? HUBSPOT_OBJECT_PROPERTIES[objectType]
    : hubSpotReadProperties(objectType, requestedProperties);
  for (const name of projectedProperties) {
    const value = propertiesSource[name];
    if (value === null || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value) ||
        typeof value === 'string' && value.length <= 65_536) {
      properties[name] = value;
    }
  }
  const id = firstString(source, ['id', 'objectId', 'object_id']);
  const createdAt = firstString(source, ['createdAt', 'created_at']);
  const updatedAt = firstString(source, ['updatedAt', 'updated_at']);
  return {
    objectType,
    ...(id && id.length <= 256 ? { id } : {}),
    ...(hubSpotDisplayName(objectType, properties) ? {
      displayName: hubSpotDisplayName(objectType, properties),
    } : {}),
    properties,
    ...(createdAt && createdAt.length <= 128 ? { createdAt } : {}),
    ...(updatedAt && updatedAt.length <= 128 ? { updatedAt } : {}),
    ...(typeof source.archived === 'boolean' ? { archived: source.archived } : {}),
  };
}

function hubSpotDisplayName(
  objectType: HubSpotObjectType,
  properties: Record<string, string | number | boolean | null>,
): string | undefined {
  const text = (name: string) => typeof properties[name] === 'string'
    ? String(properties[name]).trim()
    : '';
  const candidate = objectType === 'contacts'
    ? [text('firstname'), text('lastname')].filter(Boolean).join(' ') || text('email')
    : objectType === 'companies' ? text('name') || text('domain')
    : objectType === 'deals' ? text('dealname')
    : objectType === 'tickets' ? text('subject')
    : objectType === 'notes' ? text('hs_note_body').slice(0, 160)
    : objectType === 'tasks' ? text('hs_task_subject')
    : objectType === 'meetings' ? text('hs_meeting_title')
    : text('hs_call_title');
  return candidate ? candidate.slice(0, 240) : undefined;
}

function projectHubSpotOwners(data: Record<string, unknown>): Record<string, unknown> {
  const source = hubSpotPayload(data);
  const results = firstArray(source, ['results', 'items']).flatMap((owner) => {
    if (!isRecord(owner)) return [];
    const id = firstString(owner, ['id', 'ownerId', 'owner_id']);
    if (!id || id.length > 256) return [];
    const firstName = firstString(owner, ['firstName', 'first_name']);
    const lastName = firstString(owner, ['lastName', 'last_name']);
    const email = firstString(owner, ['email']);
    const userId = owner.userId ?? owner.user_id;
    return [{
      id,
      ...(firstName && firstName.length <= 240 ? { firstName } : {}),
      ...(lastName && lastName.length <= 240 ? { lastName } : {}),
      ...(email && email.length <= 320 ? { email } : {}),
      ...(typeof userId === 'string' && userId.length <= 256 || Number.isSafeInteger(userId)
        ? { userId: String(userId) }
        : {}),
      ...(typeof owner.archived === 'boolean' ? { archived: owner.archived } : {}),
    }];
  });
  return { results, ...hubSpotPaging(source) };
}

function projectHubSpotPipelines(data: Record<string, unknown>): Record<string, unknown> {
  const source = hubSpotPayload(data);
  const results = firstArray(source, ['results', 'items']).flatMap((pipeline) => {
    if (!isRecord(pipeline)) return [];
    const id = firstString(pipeline, ['id']);
    const label = firstString(pipeline, ['label', 'name']);
    if (!id || !label || id.length > 256 || label.length > 240) return [];
    const stages = firstArray(pipeline, ['stages']).flatMap((stage) => {
      if (!isRecord(stage)) return [];
      const stageId = firstString(stage, ['id']);
      const stageLabel = firstString(stage, ['label', 'name']);
      if (!stageId || !stageLabel || stageId.length > 256 || stageLabel.length > 240) return [];
      return [{
        id: stageId,
        label: stageLabel,
        ...(Number.isInteger(stage.displayOrder) ? { displayOrder: Number(stage.displayOrder) } : {}),
        ...(typeof stage.archived === 'boolean' ? { archived: stage.archived } : {}),
      }];
    });
    return [{
      id,
      label,
      stages,
      ...(Number.isInteger(pipeline.displayOrder)
        ? { displayOrder: Number(pipeline.displayOrder) }
        : {}),
      ...(typeof pipeline.archived === 'boolean' ? { archived: pipeline.archived } : {}),
    }];
  });
  return { results };
}

function projectHubSpotAssociations(data: Record<string, unknown>): Record<string, unknown> {
  const source = hubSpotPayload(data);
  const results = firstArray(source, ['results', 'items', 'associations']).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = firstString(entry, ['id', 'toObjectId', 'to_object_id']);
    if (!id || id.length > 256) return [];
    return [{ id }];
  });
  return { results, ...hubSpotPaging(source) };
}

function projectHubSpotAssociationTypes(data: Record<string, unknown>): Record<string, unknown> {
  const source = hubSpotPayload(data);
  const results = firstArray(source, ['results', 'items', 'labels']).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const rawTypeId = entry.typeId ?? entry.associationTypeId ?? entry.type_id;
    const typeId = Number.isSafeInteger(rawTypeId) && Number(rawTypeId) > 0
      ? Number(rawTypeId)
      : undefined;
    const category = firstString(entry, ['category', 'associationCategory']);
    const label = firstString(entry, ['label', 'name']);
    if (!typeId || !category || ![
      'HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED',
    ].includes(category)) return [];
    return [{ typeId, category, ...(label && label.length <= 240 ? { label } : {}) }];
  });
  return { results };
}

function hubSpotPaging(source: Record<string, unknown>): Record<string, string> {
  const paging = isRecord(source.paging) ? source.paging : undefined;
  const next = paging && isRecord(paging.next) ? paging.next : undefined;
  const nextCursor = next ? firstString(next, ['after', 'cursor']) : undefined;
  return nextCursor && nextCursor.length <= 256 ? { nextCursor } : {};
}

function hubSpotPayload(data: Record<string, unknown>): Record<string, unknown> {
  return isRecord(data.data) ? data.data : data;
}

function gongWorkspaces(data: Record<string, unknown>): Array<{
  providerRef: string;
  label: string;
}> {
  const source = gongPayload(data);
  const entries = firstArray(source, ['workspaces', 'records', 'results', 'items']);
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const providerRef = firstString(entry, ['id', 'workspaceId', 'workspace_id']);
    const name = firstString(entry, ['name', 'workspaceName', 'workspace_name']);
    if (!providerRef || !/^\d{1,20}$/.test(providerRef) || seen.has(providerRef)) return [];
    seen.add(providerRef);
    return [{ providerRef, label: (name || `Gong workspace ${providerRef}`).slice(0, 240) }];
  });
}

function projectGongWorkspaces(
  data: Record<string, unknown>,
  selectedWorkspaceId: string,
  workspaceHandle: string,
): Record<string, unknown> {
  const workspace = gongWorkspaces(data).find(({ providerRef }) =>
    providerRef === selectedWorkspaceId);
  if (!workspace) throw new Error('Selected Gong workspace is no longer accessible');
  return { workspaces: [{ handle: workspaceHandle, label: workspace.label }] };
}

function projectGongUsers(data: Record<string, unknown>): Record<string, unknown> {
  const source = gongPayload(data);
  const users = firstArray(source, ['users', 'records', 'results', 'items']).slice(0, 100)
    .flatMap((user) => {
      if (!isRecord(user)) return [];
      const id = firstString(user, ['id', 'userId', 'user_id']);
      if (!id || !/^\d{1,20}$/.test(id)) return [];
      const firstName = firstString(user, ['firstName', 'first_name']);
      const lastName = firstString(user, ['lastName', 'last_name']);
      const email = firstString(user, ['email']);
      const title = firstString(user, ['title', 'jobTitle', 'job_title']);
      return [{
        id,
        ...(firstName && firstName.length <= 240 ? { firstName } : {}),
        ...(lastName && lastName.length <= 240 ? { lastName } : {}),
        ...(email && email.length <= 320 ? { email } : {}),
        ...(title && title.length <= 240 ? { title } : {}),
        ...(typeof user.active === 'boolean' ? { active: user.active } : {}),
      }];
    });
  return { users, ...gongPaging(source) };
}

function projectGongCalls(
  data: Record<string, unknown>,
  selectedWorkspaceId: string,
  requireWorkspace: boolean,
): Record<string, unknown> {
  const source = gongPayload(data);
  const calls = firstArray(source, ['calls', 'records', 'results', 'items']).slice(0, 100)
    .flatMap((call) => {
      if (!isRecord(call)) return [];
      try {
        return [projectGongCall(call, selectedWorkspaceId, requireWorkspace)];
      } catch {
        return [];
      }
    });
  return { calls, ...gongPaging(source) };
}

function projectGongCall(
  data: Record<string, unknown>,
  selectedWorkspaceId: string,
  requireWorkspace: boolean,
): Record<string, unknown> {
  const payload = gongPayload(data);
  const source = firstRecord(payload, ['call', 'record', 'result']) ?? payload;
  const id = firstString(source, ['id', 'callId', 'call_id']);
  if (!id || !/^\d{1,20}$/.test(id)) throw new Error('Gong call response is invalid');
  const workspaceId = firstString(source, ['workspaceId', 'workspace_id']);
  if (workspaceId && workspaceId !== selectedWorkspaceId || requireWorkspace && !workspaceId) {
    throw new Error('Gong call does not belong to the selected workspace');
  }
  const title = firstString(source, ['title', 'name']);
  const startedAt = firstString(source, ['started', 'startedAt', 'started_at', 'scheduled']);
  const endedAt = firstString(source, ['ended', 'endedAt', 'ended_at']);
  const direction = firstString(source, ['direction']);
  const system = firstString(source, ['system', 'media']);
  const duration = source.duration ?? source.durationMs ?? source.duration_ms;
  return {
    id,
    ...(title && title.length <= 2_000 ? { title } : {}),
    ...(startedAt && startedAt.length <= 128 ? { startedAt } : {}),
    ...(endedAt && endedAt.length <= 128 ? { endedAt } : {}),
    ...(direction && direction.length <= 80 ? { direction } : {}),
    ...(system && system.length <= 120 ? { system } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
      ? { duration }
      : {}),
  };
}

function projectGongTranscript(
  data: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const source = gongPayload(data);
  const callId = requiredGongId(input.callId, 'callId');
  const maxSegments = boundedInteger(input.maxSegments, 1, 100, 50);
  const maxCharacters = boundedInteger(input.maxCharacters, 1_000, 100_000, 50_000);
  const transcriptRoots = firstArray(source, [
    'callTranscripts', 'call_transcripts', 'transcripts', 'records', 'results',
  ]);
  const matching = transcriptRoots.find((entry) => isRecord(entry) &&
    firstString(entry, ['callId', 'call_id', 'id']) === callId);
  const root: unknown = matching ?? (transcriptRoots.length === 1 ? transcriptRoots[0] : source);
  const rawSegments: Array<Record<string, unknown>> = [];
  collectGongTranscriptSegments(root, rawSegments, 0, 1_000);
  const segments: Array<Record<string, unknown>> = [];
  let characters = 0;
  let truncated = false;
  for (const raw of rawSegments) {
    if (segments.length >= maxSegments || characters >= maxCharacters) {
      truncated = true;
      break;
    }
    const text = firstString(raw, ['text', 'sentence', 'content']);
    if (!text) continue;
    const remaining = maxCharacters - characters;
    const safeText = text.slice(0, Math.min(remaining, 4_000));
    if (safeText.length < text.length) truncated = true;
    characters += safeText.length;
    const speakerId = firstString(raw, ['speakerId', 'speaker_id']);
    const speakerName = firstString(raw, ['speakerName', 'speaker_name', 'speaker']);
    const start = raw.start ?? raw.startTime ?? raw.start_time;
    const end = raw.end ?? raw.endTime ?? raw.end_time;
    segments.push({
      text: safeText,
      ...(speakerId && speakerId.length <= 256 ? { speakerId } : {}),
      ...(speakerName && speakerName.length <= 240 ? { speakerName } : {}),
      ...(typeof start === 'number' && Number.isFinite(start) ? { start } : {}),
      ...(typeof end === 'number' && Number.isFinite(end) ? { end } : {}),
    });
  }
  if (rawSegments.length > segments.length) truncated = true;
  return {
    callId,
    segments,
    characterCount: characters,
    truncated,
    ...gongPaging(source),
  };
}

function collectGongTranscriptSegments(
  value: unknown,
  output: Array<Record<string, unknown>>,
  depth: number,
  maximum: number,
): void {
  if (depth > 5 || output.length >= maximum) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectGongTranscriptSegments(entry, output, depth + 1, maximum);
    return;
  }
  if (!isRecord(value)) return;
  if (firstString(value, ['text', 'sentence', 'content'])) {
    output.push(value);
    return;
  }
  for (const key of ['transcript', 'segments', 'sentences', 'monologues', 'content']) {
    if (key in value) collectGongTranscriptSegments(value[key], output, depth + 1, maximum);
  }
}

function projectGongMetricPage(data: Record<string, unknown>): Record<string, unknown> {
  const source = gongPayload(data);
  const entries = firstArray(source, [
    'records', 'results', 'items', 'metrics', 'scorecards', 'activityScorecards',
    'tasks', 'trackers', 'callOutcomes', 'call_outcomes',
  ]).slice(0, 100);
  return {
    items: entries.flatMap((entry) => {
      const projected = projectGongSafeValue(entry, 0);
      return isRecord(projected) ? [projected] : [];
    }),
    ...gongPaging(source),
  };
}

function projectGongSafeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => projectGongSafeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    if (/password|secret|api.?key|access.?token|refresh.?token/i.test(key)) continue;
    const safe = projectGongSafeValue(entry, depth + 1);
    if (safe !== undefined) projected[key] = safe;
  }
  return projected;
}

type GoogleAdsReportResource =
  | 'customer'
  | 'campaign'
  | 'ad_group'
  | 'ad_group_ad'
  | 'keyword_view'
  | 'campaign_budget';

const GOOGLE_ADS_METRICS = {
  impressions: 'metrics.impressions',
  clicks: 'metrics.clicks',
  costMicros: 'metrics.cost_micros',
  conversions: 'metrics.conversions',
  conversionValue: 'metrics.conversions_value',
  ctr: 'metrics.ctr',
  averageCpc: 'metrics.average_cpc',
  averageCpm: 'metrics.average_cpm',
} as const;

function googleAdsReportCapability(resource: GoogleAdsReportResource): ComposioCapability {
  return {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_SEARCH_STREAM_GAQL',
    arguments: (input) => ({
      customer_id: requiredGoogleAdsId(input.customerId, 'customerId'),
      query: googleAdsReportQuery(resource, input),
      summary_row_setting: 'NO_SUMMARY_ROW',
    }),
    sanitize: projectGoogleAdsResult,
  };
}

function googleAdsReportQuery(
  resource: GoogleAdsReportResource,
  input: Record<string, unknown>,
): string {
  if (resource === 'customer') {
    return 'SELECT customer.id, customer.descriptive_name, customer.currency_code, ' +
      'customer.time_zone, customer.manager, customer.status, customer.test_account ' +
      'FROM customer LIMIT 1';
  }
  if (resource === 'campaign_budget') {
    const limit = boundedInteger(input.limit, 1, 500, 100);
    return 'SELECT campaign_budget.id, campaign_budget.name, campaign_budget.status, ' +
      'campaign_budget.amount_micros, campaign_budget.total_amount_micros, ' +
      'campaign_budget.delivery_method, campaign_budget.period, campaign_budget.type, ' +
      'campaign_budget.explicitly_shared, campaign_budget.reference_count ' +
      `FROM campaign_budget WHERE campaign_budget.status != 'REMOVED' LIMIT ${limit}`;
  }
  const baseFields: Record<Exclude<GoogleAdsReportResource, 'customer' | 'campaign_budget'>, string[]> = {
    campaign: [
      'campaign.id', 'campaign.name', 'campaign.status',
      'campaign.advertising_channel_type', 'campaign.campaign_budget',
    ],
    ad_group: [
      'campaign.id', 'campaign.name', 'ad_group.id', 'ad_group.name',
      'ad_group.status', 'ad_group.type',
    ],
    ad_group_ad: [
      'campaign.id', 'campaign.name', 'ad_group.id', 'ad_group.name',
      'ad_group_ad.ad.id', 'ad_group_ad.status', 'ad_group_ad.ad.type',
      'ad_group_ad.ad.final_urls',
    ],
    keyword_view: [
      'campaign.id', 'campaign.name', 'ad_group.id', 'ad_group.name',
      'ad_group_criterion.criterion_id', 'ad_group_criterion.status',
      'ad_group_criterion.negative', 'ad_group_criterion.keyword.text',
      'ad_group_criterion.keyword.match_type', 'ad_group_criterion.cpc_bid_micros',
    ],
  };
  const metricKeys = optionalEnumArray(
    input.metrics,
    'metrics',
    Object.keys(GOOGLE_ADS_METRICS) as Array<keyof typeof GOOGLE_ADS_METRICS>,
    8,
  ) ?? ['impressions', 'clicks', 'costMicros', 'conversions'];
  const orderKey = optionalEnum(
    input.orderBy,
    'orderBy',
    Object.keys(GOOGLE_ADS_METRICS) as Array<keyof typeof GOOGLE_ADS_METRICS>,
  );
  if (orderKey && !metricKeys.includes(orderKey)) metricKeys.push(orderKey);
  const metrics = metricKeys.map((key) => GOOGLE_ADS_METRICS[key]);
  const startDate = requiredGoogleAdsDate(input.startDate, 'startDate');
  const endDate = requiredGoogleAdsDate(input.endDate, 'endDate');
  const status = optionalEnum(input.status, 'status', ['ENABLED', 'PAUSED']);
  const statusField = resource === 'campaign'
    ? 'campaign.status'
    : resource === 'ad_group'
    ? 'ad_group.status'
    : resource === 'ad_group_ad'
    ? 'ad_group_ad.status'
    : 'ad_group_criterion.status';
  const orderDirection = optionalEnum(input.orderDirection, 'orderDirection', ['ASC', 'DESC']) ?? 'DESC';
  const limit = boundedInteger(input.limit, 1, 500, 100);
  const where = [
    `segments.date BETWEEN '${startDate}' AND '${endDate}'`,
    `${statusField} != 'REMOVED'`,
    ...(status ? [`${statusField} = '${status}'`] : []),
  ];
  return `SELECT ${[...baseFields[resource], ...metrics].join(', ')} ` +
    `FROM ${resource} WHERE ${where.join(' AND ')} ` +
    `${orderKey ? `ORDER BY ${GOOGLE_ADS_METRICS[orderKey]} ${orderDirection} ` : ''}` +
    `LIMIT ${limit}`;
}

function googleAdsCampaignUpdate(
  field: 'name' | 'status',
  fixedValue?: string,
): ComposioCapability {
  // Composio googleads 20260721_00 intentionally exposes asymmetric mutate
  // envelopes: campaigns require operation_type and omit update_mask, while
  // ad groups infer both the operation and changed fields from `update`.
  return {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_CAMPAIGNS',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      const value = fixedValue ?? requiredString(input.name, 'name', 128);
      return googleAdsMutationArguments(customerId, [{
        operation_type: 'update',
        update: {
          resource_name: googleAdsResourceName(
            customerId, 'campaigns', input.campaignId, 'campaignId',
          ),
          [field]: value,
        },
      }]);
    },
    sanitize: projectGoogleAdsMutation,
  };
}

function googleAdsAdGroupUpdate(
  field: 'name' | 'status',
  fixedValue?: string,
): ComposioCapability {
  return {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_AD_GROUPS',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      const value = fixedValue ?? requiredString(input.name, 'name', 128);
      return googleAdsMutationArguments(customerId, [{ update: {
        resource_name: googleAdsResourceName(
          customerId, 'adGroups', input.adGroupId, 'adGroupId',
        ),
        [field]: value,
      } }]);
    },
    sanitize: projectGoogleAdsMutation,
  };
}

function googleAdsKeywordUpdate(status: 'PAUSED' | 'ENABLED'): ComposioCapability {
  return {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_AD_GROUP_CRITERIA',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      const adGroupId = requiredGoogleAdsId(input.adGroupId, 'adGroupId');
      const criterionId = requiredGoogleAdsId(input.criterionId, 'criterionId');
      return googleAdsMutationArguments(customerId, [{
        update: {
          resource_name: `customers/${customerId}/adGroupCriteria/${adGroupId}~${criterionId}`,
          status,
        },
        update_mask: 'status',
      }]);
    },
    sanitize: projectGoogleAdsMutation,
  };
}

function googleAdsAdUpdate(status: 'PAUSED' | 'ENABLED'): ComposioCapability {
  return {
    toolkit: 'googleads',
    tool: 'GOOGLEADS_MUTATE_AD_GROUP_ADS',
    arguments: (input) => {
      const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
      const adGroupId = requiredGoogleAdsId(input.adGroupId, 'adGroupId');
      const adId = requiredGoogleAdsId(input.adId, 'adId');
      return googleAdsMutationArguments(customerId, [{
        update: {
          resource_name: `customers/${customerId}/adGroupAds/${adGroupId}~${adId}`,
          status,
        },
        update_mask: 'status',
      }]);
    },
    sanitize: projectGoogleAdsMutation,
  };
}

function googleAdsMutationArguments(
  customerId: string,
  operations: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    customer_id: customerId,
    operations,
    validate_only: false,
    partial_failure: false,
  };
}

function googleAdsResourceName(
  customerId: string,
  collection: 'campaigns' | 'campaignBudgets' | 'adGroups',
  value: unknown,
  name: string,
): string {
  return `customers/${customerId}/${collection}/${requiredGoogleAdsId(value, name)}`;
}

function requiredGoogleAdsId(value: unknown, name: string): string {
  const id = requiredString(value, name, 20).replaceAll('-', '').replaceAll(' ', '');
  if (!/^\d{1,20}$/.test(id)) throw new Error(`${name} is invalid`);
  return id;
}

function requiredGoogleAdsAmount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10_000_000_000_000) {
    throw new Error('amountMicros is invalid');
  }
  return Number(value);
}

function requiredGoogleAdsDate(value: unknown, name: string): string {
  const date = requiredString(value, name, 10);
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== date) throw new Error(`${name} is invalid`);
  return date;
}

function requiredCurrencyCode(value: unknown): string {
  const code = requiredString(value, 'currencyCode', 3);
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('currencyCode is invalid');
  return code;
}

function requiredEnum<T extends string>(
  value: unknown,
  name: string,
  values: readonly T[],
): T {
  const candidate = optionalEnum(value, name, values);
  if (!candidate) throw new Error(`${name} is invalid`);
  return candidate;
}

function requiredUrlArray(value: unknown, name: string, maximum: number): string[] {
  const urls = requiredStringArray(value, name, maximum, 2_000);
  for (const entry of urls) {
    const url = new URL(entry);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${name} is invalid`);
    }
  }
  return urls;
}

function googleAdsTextAssets(
  value: unknown,
  name: string,
  maximum: number,
  maxLength: number,
): Array<{ text: string }> {
  return requiredStringArray(value, name, maximum, maxLength).map((text) => ({ text }));
}

function projectGoogleAdsResult(data: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(data.data) ? data.data : data;
  const projected = projectGoogleAdsSafeValue(source, 0);
  return isRecord(projected) ? projected : { items: [] };
}

function projectGoogleAdsSafeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((entry) => projectGoogleAdsSafeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 80)) {
    if (/password|secret|api.?key|access.?token|refresh.?token|developer.?token/i.test(key)) {
      continue;
    }
    const safe = projectGoogleAdsSafeValue(entry, depth + 1);
    if (safe !== undefined) projected[key] = safe;
  }
  return projected;
}

function projectGoogleAdsMutation(data: Record<string, unknown>): Record<string, unknown> {
  const projected = projectGoogleAdsResult(data);
  return { successful: data.successful !== false, result: projected };
}

function projectYouTubeResult(data: Record<string, unknown>): Record<string, unknown> {
  return projectGoogleAdsResult(data);
}

function projectYouTubeMutation(data: Record<string, unknown>): Record<string, unknown> {
  return { successful: data.successful !== false, result: projectYouTubeResult(data) };
}

function youtubeChannels(data: Record<string, unknown>): Array<{
  providerRef: string;
  label: string;
}> {
  const seen = new Set<string>();
  return youtubeItems(data).flatMap((item) => {
    const providerRef = youtubeResourceId(item);
    if (!providerRef || seen.has(providerRef)) return [];
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    const title = firstString(snippet, ['title', 'customUrl', 'custom_url']);
    seen.add(providerRef);
    return [{
      providerRef,
      label: (title ? `${title} · ${providerRef}` : `YouTube channel ${providerRef}`).slice(0, 240),
    }];
  });
}

function projectSelectedYouTubeVideos(
  data: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  const items = youtubeItems(data);
  if (items.length === 0 || !youtubeVideosBelongToChannel(data, channelId)) {
    throw new Error('YouTube video is not owned by the selected channel');
  }
  return projectYouTubeResult(data);
}

function projectSelectedYouTubePlaylists(
  data: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  const items = youtubeItems(data).filter((item) => youtubeItemChannelId(item) === channelId);
  const projected = projectGoogleAdsSafeValue({
    items,
    ...(youtubeNextPageToken(data) ? { nextPageToken: youtubeNextPageToken(data) } : {}),
  }, 0);
  return isRecord(projected) ? projected : { items: [] };
}

function youtubeVideosBelongToChannel(data: Record<string, unknown>, channelId: string): boolean {
  const items = youtubeItems(data);
  return items.length > 0 && items.every((item) => youtubeItemChannelId(item) === channelId);
}

function youtubePlaylistBelongsToChannel(
  data: Record<string, unknown>,
  playlistId: string,
  channelId: string,
): boolean {
  return youtubeItems(data).some((item) =>
    youtubeResourceId(item) === playlistId && youtubeItemChannelId(item) === channelId);
}

function youtubePlaylistContainsVideo(
  data: Record<string, unknown>,
  playlistId: string,
  videoId: string,
): boolean {
  return youtubeItems(data).some((item) => {
    const snippet = isRecord(item.snippet) ? item.snippet : undefined;
    const contentDetails = isRecord(item.contentDetails) ? item.contentDetails : undefined;
    const resourceId = snippet && isRecord(snippet.resourceId) ? snippet.resourceId : undefined;
    return firstString(snippet ?? {}, ['playlistId', 'playlist_id']) === playlistId &&
      (firstString(resourceId ?? {}, ['videoId', 'video_id']) === videoId ||
        firstString(contentDetails ?? {}, ['videoId', 'video_id']) === videoId);
  });
}

function youtubeItems(data: Record<string, unknown>): Record<string, unknown>[] {
  const source = isRecord(data.data) ? data.data : data;
  return firstArray(source, ['items', 'channels', 'videos', 'playlists', 'results'])
    .flatMap((item) => isRecord(item) ? [item] : []);
}

function youtubeResourceId(item: Record<string, unknown>): string | undefined {
  if (typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id)) return item.id;
  if (!isRecord(item.id)) return undefined;
  return firstString(item.id, ['channelId', 'videoId', 'playlistId']);
}

function youtubeMutationResourceId(data: Record<string, unknown>): string | undefined {
  const source = isRecord(data.data) ? data.data : data;
  const direct = youtubeResourceId(source);
  if (direct) return direct;
  for (const key of ['item', 'playlist', 'playlistItem', 'video', 'comment', 'resource', 'result']) {
    const nested = source[key];
    if (!isRecord(nested)) continue;
    const value = youtubeResourceId(nested);
    if (value) return value;
  }
  return youtubeItems(source).map(youtubeResourceId).find(Boolean);
}

function youtubeItemChannelId(item: Record<string, unknown>): string | undefined {
  const snippet = isRecord(item.snippet) ? item.snippet : undefined;
  const value = snippet
    ? firstString(snippet, ['channelId', 'channel_id'])
    : firstString(item, ['channelId', 'channel_id']);
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function youtubeNextPageToken(data: Record<string, unknown>): string | undefined {
  const source = isRecord(data.data) ? data.data : data;
  const token = firstString(source, ['nextPageToken', 'next_page_token']);
  return token && token.length <= 2_000 ? token : undefined;
}

function gongPaging(source: Record<string, unknown>): Record<string, string> {
  const records = isRecord(source.records) ? source.records : undefined;
  const paging = isRecord(source.paging) ? source.paging : undefined;
  const next = paging && isRecord(paging.next) ? paging.next : undefined;
  const cursor = firstString(source, ['cursor', 'nextCursor', 'next_cursor']) ??
    (records ? firstString(records, ['cursor', 'nextCursor', 'next_cursor']) : undefined) ??
    (next ? firstString(next, ['cursor', 'after']) : undefined);
  return cursor && cursor.length <= 2_000 ? { nextCursor: cursor } : {};
}

function gongPayload(data: Record<string, unknown>): Record<string, unknown> {
  return isRecord(data.data) ? data.data : data;
}

function requiredGongId(value: unknown, name: string): string {
  const id = requiredString(value, name, 20);
  if (!/^\d{1,20}$/.test(id)) throw new Error(`${name} is invalid`);
  return id;
}

function optionalGongIds(value: unknown, name: string, maxItems: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} is invalid`);
  const ids = value.map((entry) => requiredGongId(entry, name));
  return ids.length ? ids : undefined;
}

function requiredEnumArray<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  maxItems: number,
): T[] {
  const result = optionalEnumArray(value, name, allowed, maxItems);
  if (!result?.length) throw new Error(`${name} is invalid`);
  return result;
}

function optionalEnumArray<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  maxItems: number,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} is invalid`);
  const result = value.map((entry) => {
    const candidate = optionalEnum(entry, name, allowed);
    if (!candidate) throw new Error(`${name} is invalid`);
    return candidate;
  });
  return result.length ? result : undefined;
}

function firstRecord(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) if (isRecord(source[key])) return source[key] as Record<string, unknown>;
  return undefined;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, name, maxLength);
}

function requiredContentString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalContentString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null ||
      typeof value === 'string' && !value.trim()) return undefined;
  return requiredContentString(value, name, maxLength);
}

function optionalStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxItemLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} is invalid`);
  const normalized = value.map((entry) => requiredString(entry, name, maxItemLength));
  return normalized.length > 0 ? normalized : undefined;
}

function requiredStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  const normalized = optionalStringArray(value, name, maxItems, maxItemLength);
  if (!normalized?.length) throw new Error(`${name} is invalid`);
  return normalized;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, minimum, maximum, minimum);
}

function requiredCellMatrix(value: unknown): Array<Array<string | number | boolean | null>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw new Error('cell values are invalid');
  }
  const rows = value.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 100) {
      throw new Error('cell values are invalid');
    }
    return row.map((cell) => {
      if (cell === null || typeof cell === 'boolean' ||
          typeof cell === 'number' && Number.isFinite(cell) ||
          typeof cell === 'string' && cell.length <= 10_000) return cell;
      throw new Error('cell values are invalid');
    });
  });
  if (JSON.stringify(rows).length > 100_000) throw new Error('cell values are invalid');
  return rows;
}

function notionSorts(value: unknown): Array<{
  property_name: string;
  ascending: boolean;
}> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new Error('Notion sorts are invalid');
  return value.map((sort) => {
    if (!isRecord(sort) || typeof sort.ascending !== 'boolean') {
      throw new Error('Notion sort is invalid');
    }
    return {
      property_name: requiredString(sort.propertyName, 'propertyName', 2_000),
      ascending: sort.ascending,
    };
  });
}

function notionProperties(value: unknown): Array<{
  name: string;
  type: string;
  value: string;
}> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
      JSON.stringify(value).length > 100_000) {
    throw new Error('Notion properties are invalid');
  }
  const allowedTypes = [
    'title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'checkbox',
    'url', 'email', 'phone_number', 'status',
  ] as const;
  return value.map((property) => {
    if (!isRecord(property)) throw new Error('Notion property is invalid');
    const type = optionalEnum(property.type, 'type', allowedTypes);
    if (!type) throw new Error('Notion property type is invalid');
    return {
      name: requiredString(property.name, 'name', 2_000),
      type,
      value: requiredContentString(property.value, 'value', 10_000),
    };
  });
}

function notionContentBlocks(value: unknown): Array<{
  content_block: Record<string, unknown>;
}> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
      JSON.stringify(value).length > 100_000) {
    throw new Error('Notion content blocks are invalid');
  }
  const textTypes = [
    'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
    'numbered_list_item', 'to_do', 'toggle', 'callout', 'quote',
  ] as const;
  return value.map((block) => {
    if (!isRecord(block)) throw new Error('Notion content block is invalid');
    if (block.type === 'divider') {
      return { content_block: { block_property: 'divider' } };
    }
    const type = optionalEnum(block.type, 'type', textTypes);
    if (!type) throw new Error('Notion content block type is invalid');
    return {
      content_block: {
        block_property: type,
        content: requiredContentString(block.content, 'content', 2_000),
      },
    };
  });
}

function slidesRequests(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25 ||
      JSON.stringify(value).length > 100_000) {
    throw new Error('slide operations are invalid');
  }
  return value.map((operation) => {
    if (!isRecord(operation) || typeof operation.kind !== 'string') {
      throw new Error('slide operation is invalid');
    }
    if (operation.kind === 'replace_all_text') {
      return {
        replaceAllText: {
          containsText: {
            text: requiredString(operation.findText, 'findText', 2_000),
            matchCase: operation.matchCase === true,
          },
          replaceText: requiredContentString(operation.replaceText, 'replaceText', 20_000),
        },
      };
    }
    if (operation.kind === 'insert_text') {
      return {
        insertText: {
          objectId: requiredString(operation.objectId, 'objectId', 1_000),
          text: requiredContentString(operation.text, 'text', 100_000),
          insertionIndex: optionalInteger(operation.insertionIndex, 0, 10_000_000),
        },
      };
    }
    if (operation.kind === 'create_slide') {
      const layout = optionalEnum(operation.layout, 'layout', [
        'BLANK', 'CAPTION_ONLY', 'MAIN_POINT', 'ONE_COLUMN_TEXT', 'SECTION_HEADER',
        'SECTION_TITLE_AND_DESCRIPTION', 'TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS',
        'TITLE_ONLY', 'BIG_NUMBER',
      ]);
      return {
        createSlide: {
          objectId: optionalString(operation.slideId, 'slideId', 1_000),
          insertionIndex: optionalInteger(operation.insertionIndex, 0, 10_000),
          ...(layout ? { slideLayoutReference: { predefinedLayout: layout } } : {}),
        },
      };
    }
    throw new Error('slide operation is unsupported');
  });
}

function optionalEnum<T extends string>(
  value: unknown,
  name: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${name} is invalid`);
  return value as T;
}

function quotaLimit(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d{1,10}$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_000_000_000
    ? parsed
    : undefined;
}

function requireToolkit(value: string): ManagedConnectorDefinition {
  const connector = MANAGED_CONNECTOR_CATALOG.connector(value);
  if (!connector) {
    throw new Error('Composio toolkit is unsupported');
  }
  return connector;
}

function injectManagedResourceArguments(
  connector: ManagedConnectorDefinition,
  policy: ConnectionAccountManagedPolicy,
  arguments_: Record<string, unknown>,
): Record<string, unknown> {
  if (!connector.resources?.length) return arguments_;
  const output = { ...arguments_ };
  for (const resource of connector.resources) {
    if (resource.providerArgument in output) {
      throw new Error(`${resource.providerArgument} is provider-controlled`);
    }
    const handle = output[resource.localArgument];
    if (typeof handle !== 'string') {
      if (resource.required) throw new Error(`${resource.localArgument} is required`);
      continue;
    }
    const selected = policy.resourceConstraints?.[resource.key]?.find(
      (candidate) => candidate.handle === handle,
    );
    if (!selected) throw new Error('Managed connection resource is not selected');
    output[resource.providerArgument] = selected.providerRef;
  }
  return output;
}

function validateManagedResourceMetadata(
  policy: ConnectionAccountManagedPolicy,
  capability: string,
  input: Record<string, unknown>,
): void {
  if (policy.toolkit !== 'googleads' ||
      !['ads.budgets.create', 'ads.budgets.update_amount'].includes(capability)) return;
  const customerId = requiredGoogleAdsId(input.customerId, 'customerId');
  const currencyCode = requiredCurrencyCode(input.currencyCode);
  const selected = policy.resourceConstraints?.customerIds?.find(
    ({ providerRef }) => providerRef === customerId,
  );
  if (!selected || selected.currencyCode !== currencyCode) {
    throw new Error('currencyCode does not match the selected Google Ads account');
  }
}

const MANAGED_RESOURCE_PAGE_SIZE = 250;
const MANAGED_RESOURCE_CURSOR_PREFIX = 'mr:';

interface ManagedResourceCursor {
  providerCursor?: string;
  offset: number;
}

function managedResourceCursor(
  value: string | undefined,
  acceptLegacyProviderCursor = false,
): ManagedResourceCursor {
  if (!value) return { offset: 0 };
  if (!value.startsWith(MANAGED_RESOURCE_CURSOR_PREFIX)) {
    if (acceptLegacyProviderCursor && value.length <= 2_000) {
      return { providerCursor: value, offset: 0 };
    }
    throw new Error('Managed resource cursor is invalid');
  }
  const match = /^mr:(\d{1,4}):(.*)$/.exec(value);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error('Managed resource cursor is invalid');
  }
  const offset = Number(match[1]);
  const providerCursor = decodeURIComponent(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_000 ||
      offset % MANAGED_RESOURCE_PAGE_SIZE !== 0 || providerCursor.length > 2_000) {
    throw new Error('Managed resource cursor is invalid');
  }
  return { offset, ...(providerCursor ? { providerCursor } : {}) };
}

function managedResourcePage(
  resources: Array<{ providerRef: string; label: string }>,
  cursor: ManagedResourceCursor,
  nextProviderCursor?: string,
): {
  resources: Array<{ providerRef: string; label: string }>;
  nextCursor?: string;
} {
  const page = resources.slice(cursor.offset, cursor.offset + MANAGED_RESOURCE_PAGE_SIZE);
  const nextOffset = cursor.offset + MANAGED_RESOURCE_PAGE_SIZE;
  const nextCursor = nextOffset < resources.length
    ? `${MANAGED_RESOURCE_CURSOR_PREFIX}${nextOffset}:` +
      encodeURIComponent(cursor.providerCursor ?? '')
    : nextProviderCursor
      ? `${MANAGED_RESOURCE_CURSOR_PREFIX}0:${encodeURIComponent(nextProviderCursor)}`
      : undefined;
  return {
    resources: page,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function searchConsoleSites(data: Record<string, unknown>): Array<{
  providerRef: string;
  label: string;
}> {
  const entries = firstArray(data, ['siteEntry', 'siteEntries', 'sites']);
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const providerRef = firstString(entry, ['siteUrl', 'site_url']);
    if (!providerRef || providerRef.length > 2_000 || seen.has(providerRef)) return [];
    seen.add(providerRef);
    const permission = firstString(entry, ['permissionLevel', 'permission_level']);
    return [{
      providerRef,
      label: (permission ? `${providerRef} (${permission})` : providerRef).slice(0, 240),
    }];
  });
}

function analyticsProperties(data: Record<string, unknown>): {
  resources: Array<{ providerRef: string; label: string }>;
  nextCursor?: string;
} {
  const summaries = firstArray(data, [
    'accountSummaries', 'account_summaries', 'items',
  ]);
  const resources: Array<{ providerRef: string; label: string }> = [];
  const seen = new Set<string>();
  for (const summary of summaries) {
    if (!isRecord(summary)) continue;
    const accountLabel = firstString(summary, ['displayName', 'display_name', 'name']);
    for (const property of firstArray(summary, ['propertySummaries', 'property_summaries', 'properties'])) {
      if (!isRecord(property)) continue;
      const providerRef = firstString(property, ['property', 'name']);
      if (!providerRef || !/^properties\/\d{1,32}$/.test(providerRef) || seen.has(providerRef)) {
        continue;
      }
      seen.add(providerRef);
      const displayName = firstString(property, ['displayName', 'display_name']) ?? providerRef;
      const label = accountLabel && accountLabel !== summary.name
        ? `${displayName} — ${accountLabel}`
        : displayName;
      resources.push({ providerRef, label: label.slice(0, 240) });
    }
  }
  const nextCursor = firstString(data, ['nextPageToken', 'next_page_token', 'nextCursor']);
  return {
    resources,
    ...(nextCursor && nextCursor.length <= 2_000 ? { nextCursor } : {}),
  };
}

function firstArray(source: Record<string, unknown>, keys: readonly string[]): unknown[] {
  for (const key of keys) if (Array.isArray(source[key])) return source[key] as unknown[];
  return [];
}

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function requireToolkitVersion(toolkit: string): string {
  const version = composioToolkitVersion(toolkit);
  if (!version) throw new Error('Composio toolkit version is not pinned');
  return version;
}

function requireHttpsUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} is invalid`);
  return url;
}

function requiredPublicHttpsUrl(value: unknown, name: string): string {
  const raw = requiredString(value, name, 2_000);
  const url = requireHttpsUrl(raw, name);
  const host = url.hostname.toLowerCase();
  // Domains may resolve to public IPv6 normally, but literal IPv6 targets are
  // unnecessary for thumbnails and easy to disguise with mapped/private forms.
  const ipv6Literal = host.startsWith('[') && host.endsWith(']');
  if (url.port && url.port !== '443' || ipv6Literal ||
      host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0' ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error(`${name} must be a public HTTPS URL`);
  }
  return url.toString();
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error('numeric capability argument is invalid');
  }
  return Number(value);
}

function identityResult(data: Record<string, unknown>): Record<string, unknown> {
  return data;
}

function projectWorkspaceSearch(data: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ['next_page_token', 'nextPageToken', 'resultSizeEstimate']) {
    copyPrimitive(data, output, key);
  }
  for (const collection of ['spreadsheets', 'documents', 'files', 'items']) {
    if (!Array.isArray(data[collection])) continue;
    output.items = data[collection].slice(0, 100).flatMap((item) =>
      isRecord(item) ? [projectArtifactSummary(item)] : []);
    break;
  }
  return Object.keys(output).length > 0 ? output : projectCreatedArtifact(data);
}

function projectArtifactSummary(source: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of [
    'id', 'spreadsheetId', 'documentId', 'presentationId', 'name', 'title', 'mimeType',
    'createdTime', 'modifiedTime', 'webViewLink', 'web_view_link', 'display_url', 'starred',
    'trashed', 'shared',
  ]) copyPrimitive(source, output, key);
  return output;
}

function projectCreatedArtifact(data: Record<string, unknown>): Record<string, unknown> {
  const output = projectArtifactSummary(data);
  for (const key of [
    'url', 'uri', 'downloadUrl', 'download_url', 'contentUrl', 'content_url', 'filename',
    'fileName', 'thumbnailUrl', 'contentSize', 'mime_type', 'revisionId',
  ]) copyPrimitive(data, output, key);
  return Object.keys(output).length > 0 ? output : data;
}

function projectExportArtifact(data: Record<string, unknown>): Record<string, unknown> {
  return projectCreatedArtifact(data);
}

function projectSpreadsheetMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  copyPrimitive(data, output, 'spreadsheetId');
  if (isRecord(data.properties)) {
    output.properties = projectKeys(data.properties, ['title', 'locale', 'timeZone']);
  }
  if (Array.isArray(data.sheets)) {
    output.sheets = data.sheets.slice(0, 256).flatMap((sheet) => {
      if (!isRecord(sheet) || !isRecord(sheet.properties)) return [];
      const properties = projectKeys(sheet.properties, [
        'sheetId', 'title', 'index', 'sheetType', 'hidden',
      ]);
      if (isRecord(sheet.properties.gridProperties)) {
        properties.gridProperties = projectKeys(sheet.properties.gridProperties, [
          'rowCount', 'columnCount', 'frozenRowCount', 'frozenColumnCount',
        ]);
      }
      return [{ properties }];
    });
  }
  return Object.keys(output).length > 0 ? output : projectCreatedArtifact(data);
}

function projectDocumentStructure(data: Record<string, unknown>): Record<string, unknown> {
  return data;
}

function projectPresentation(data: Record<string, unknown>): Record<string, unknown> {
  return data;
}

function projectPresentationPage(data: Record<string, unknown>): Record<string, unknown> {
  return data;
}

function projectNotionSearch(data: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(data.data) ? data.data : data;
  const output: Record<string, unknown> = {};
  for (const key of ['next_cursor', 'has_more', 'type']) copyPrimitive(source, output, key);
  for (const collection of ['results', 'items', 'pages', 'databases']) {
    if (!Array.isArray(source[collection])) continue;
    output.items = source[collection].slice(0, 100).flatMap((item) => {
      if (!isRecord(item)) return [];
      const projected = projectKeys(item, [
        'id', 'object', 'url', 'created_time', 'last_edited_time', 'archived', 'in_trash',
      ]);
      const title = notionTitle(item);
      if (title) projected.title = title;
      return [projected];
    });
    break;
  }
  return output;
}

function notionGrantSummary(data: Record<string, unknown>): {
  items: Array<{ type: 'page' | 'database'; label: string }>;
  truncated: boolean;
} {
  const projected = projectNotionSearch(data);
  const sourceItems = Array.isArray(projected.items) ? projected.items : [];
  const items = sourceItems.slice(0, 20).flatMap((item) => {
    if (!isRecord(item)) return [];
    const type = item.object === 'database' ? 'database' as const : 'page' as const;
    const title = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim().slice(0, 240)
      : `Untitled Notion ${type}`;
    return [{ type, label: title }];
  });
  return {
    items,
    truncated: sourceItems.length > items.length || projected.has_more === true,
  };
}

function notionTitle(source: Record<string, unknown>): string | undefined {
  if (typeof source.title === 'string' && source.title.trim()) return source.title.trim();
  const direct = richTextTitle(source.title);
  if (direct) return direct;
  if (!isRecord(source.properties)) return undefined;
  for (const property of Object.values(source.properties)) {
    if (!isRecord(property) || property.type !== 'title') continue;
    const title = richTextTitle(property.title);
    if (title) return title;
  }
  return undefined;
}

function richTextTitle(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const title = value.slice(0, 20).flatMap((part) =>
    isRecord(part) && typeof part.plain_text === 'string' ? [part.plain_text] : []).join('');
  return title.trim() ? title.slice(0, 2_000) : undefined;
}

function projectKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) copyPrimitive(source, output, key);
  return output;
}

function copyPrimitive(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) target[key] = value;
}

function projectGmailSearchMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  copyString(data, output, 'nextPageToken');
  copyFiniteNumber(data, output, 'resultSizeEstimate');
  if (Array.isArray(data.messages)) {
    output.messages = data.messages.flatMap((message) => {
      if (!isRecord(message)) return [];
      const projected: Record<string, unknown> = {};
      copyString(message, projected, 'display_url');
      copyStringArray(message, projected, 'labelIds');
      copyString(message, projected, 'messageId');
      copyString(message, projected, 'messageTimestamp');
      copyString(message, projected, 'sender');
      copyString(message, projected, 'subject');
      copyString(message, projected, 'threadId');
      copyString(message, projected, 'to');
      return [projected];
    });
  }
  return output;
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === 'string') target[key] = source[key];
}

function copyFiniteNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === 'number' && Number.isFinite(source[key])) {
    target[key] = source[key];
  }
}

function copyStringArray(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function recordExecution(
  policy: ConnectionAccountManagedPolicy,
  capability: string,
  logId: string | undefined,
): void {
  console.log(JSON.stringify({
    event: 'chickpea.managed_connection.execute',
    adapterId: policy.adapterId,
    toolkit: policy.toolkit,
    capability,
    ...(logId ? { providerLogId: logId } : {}),
  }));
}
