import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';

const EmptySchema = v.strictObject({});

const GmailSearchSchema = v.strictObject({
  query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000)),
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))),
  includeBody: v.optional(v.boolean()),
});

const GmailDraftSchema = v.strictObject({
  recipientEmail: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(1_000)),
  subject: v.pipe(
    v.string(), v.minLength(1), v.maxLength(2_000),
    v.check((value) => Boolean(value.trim()), 'Subject must not be blank'),
  ),
  body: v.pipe(
    v.string(), v.minLength(1), v.maxLength(100_000),
    v.check((value) => Boolean(value.trim()), 'Body must not be blank'),
  ),
  isHtml: v.optional(v.boolean()),
});

const EmailArraySchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.email(), v.maxLength(1_000))),
  v.maxLength(50),
);

const GmailSendSchema = v.pipe(
  v.strictObject({
    recipientEmail: v.optional(v.pipe(v.string(), v.trim(), v.email(), v.maxLength(1_000))),
    extraRecipients: v.optional(EmailArraySchema),
    cc: v.optional(EmailArraySchema),
    bcc: v.optional(EmailArraySchema),
    subject: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
    body: v.optional(v.pipe(v.string(), v.maxLength(100_000))),
    isHtml: v.optional(v.boolean()),
  }),
  v.check((input) => Boolean(
    input.recipientEmail || input.extraRecipients?.length || input.cc?.length || input.bcc?.length,
  ), 'At least one recipient is required'),
  v.check((input) => Boolean(input.subject?.trim() || input.body?.trim()), 'A subject or body is required'),
);

const CalendarListSchema = v.strictObject({
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(250))),
  pageToken: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000))),
});

const CalendarEventsListSchema = v.strictObject({
  calendarId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000))),
  query: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000))),
  timeMin: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  timeMax: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  timeZone: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  pageToken: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000))),
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(250))),
  singleEvents: v.optional(v.boolean()),
  showDeleted: v.optional(v.boolean()),
});

const CalendarSendUpdatesSchema = v.optional(v.picklist(['all', 'externalOnly', 'none']));

const CalendarEventCreateSchema = v.strictObject({
  calendarId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000))),
  summary: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000))),
  description: v.optional(v.pipe(v.string(), v.maxLength(20_000))),
  location: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000))),
  startDateTime: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
  endDateTime: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  timeZone: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  attendees: v.optional(v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.email(), v.maxLength(1_000))),
    v.maxLength(100),
  )),
  sendUpdates: CalendarSendUpdatesSchema,
  createMeetingRoom: v.optional(v.boolean()),
});

const CalendarEventUpdateSchema = v.pipe(
  v.strictObject({
    calendarId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000))),
    eventId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
    summary: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
    description: v.optional(v.pipe(v.string(), v.maxLength(20_000))),
    location: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
    startDateTime: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
    endDateTime: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
    timeZone: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
    attendees: v.optional(v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.email(), v.maxLength(1_000))),
      v.maxLength(100),
    )),
    sendUpdates: CalendarSendUpdatesSchema,
  }),
  v.check((input) => Object.keys(input).some(
    (key) => !['calendarId', 'eventId', 'sendUpdates'].includes(key),
  ), 'At least one event field must change'),
);

const CalendarEventDeleteSchema = v.strictObject({
  calendarId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000))),
  eventId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  sendUpdates: CalendarSendUpdatesSchema,
});

const DriveSearchSchema = v.strictObject({
  query: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000))),
  folderId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000))),
  pageSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  pageToken: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000))),
  corpora: v.optional(v.picklist(['user', 'drive', 'domain', 'allDrives'])),
  driveId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000))),
});

const DriveFileSchema = v.strictObject({
  fileId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
});

const DriveReadSchema = v.strictObject({
  fileId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  mimeType: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256))),
});

const DriveCreateSchema = v.strictObject({
  fileName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  textContent: v.pipe(
    v.string(), v.minLength(1), v.maxLength(100_000),
    v.check((value) => Boolean(value.trim()), 'Text content must not be blank'),
  ),
  mimeType: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256))),
});

const DEFAULT_RESULT_LIMIT = 256 * 1024;

export const MANAGED_GOOGLE_WORKSPACE_CONNECTORS: readonly ManagedConnectorDefinition[] = [
  {
    id: 'gmail',
    toolkit: 'gmail',
    providerId: 'google',
    label: 'Gmail',
    description: 'Search mail, create drafts, and send messages.',
    securityDescription: 'Google sign-in opens through Composio. Chickpea stores only the connected-account reference and this Agent\'s capability ceiling, not Google refresh tokens or a Google OAuth client secret.',
    capabilities: [
      {
        id: 'gmail.profile.read', connectorToolkit: 'gmail', accessLane: 'read', effect: 'read',
        toolName: 'gmail_get_profile',
        description: 'Read the email address and mailbox totals for the selected Gmail account.',
        input: EmptySchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
      },
      {
        id: 'gmail.messages.search', connectorToolkit: 'gmail', accessLane: 'read', effect: 'read',
        toolName: 'gmail_search_messages',
        description: 'Search the selected Gmail account with Gmail query syntax. Message bodies are omitted unless includeBody is true.',
        input: GmailSearchSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
      },
      {
        id: 'gmail.drafts.create', connectorToolkit: 'gmail', accessLane: 'write',
        effect: 'reversible_write', toolName: 'gmail_create_draft',
        description: 'Create, but never send, an email draft in the selected Gmail account.',
        input: GmailDraftSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
        sideEffectLabel: 'create email draft',
      },
      {
        id: 'gmail.messages.send', connectorToolkit: 'gmail', accessLane: 'write',
        effect: 'external_publish', toolName: 'gmail_send_message',
        description: 'Send an email immediately from the selected Gmail account. Confirm recipients and content before calling.',
        input: GmailSendSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
        sideEffectLabel: 'send email',
      },
    ],
  },
  {
    id: 'google-calendar',
    toolkit: 'googlecalendar',
    providerId: 'google',
    label: 'Google Calendar',
    description: 'Read and manage calendars and events.',
    securityDescription: 'Google sign-in opens through Composio. Chickpea stores only the connected-account reference and this Agent\'s capability ceiling, not Google refresh tokens or a Google OAuth client secret.',
    capabilities: [
      {
        id: 'calendar.calendars.list', connectorToolkit: 'googlecalendar', accessLane: 'read',
        effect: 'read', toolName: 'google_calendar_list_calendars',
        description: 'List calendars accessible to the selected Google Calendar account.',
        input: CalendarListSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
      },
      {
        id: 'calendar.events.list', connectorToolkit: 'googlecalendar', accessLane: 'read',
        effect: 'read', toolName: 'google_calendar_list_events',
        description: 'List or search events on a Google Calendar. Use RFC3339 timestamps with explicit offsets for local-day ranges.',
        input: CalendarEventsListSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
      },
      {
        id: 'calendar.events.create', connectorToolkit: 'googlecalendar', accessLane: 'write',
        effect: 'reversible_write', toolName: 'google_calendar_create_event',
        description: 'Create a Google Calendar event. No conflict check is performed; confirm event details and attendees first. Set createMeetingRoom to true only when the user requested a Google Meet room.',
        input: CalendarEventCreateSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
        sideEffectLabel: 'create calendar event',
      },
      {
        id: 'calendar.events.update', connectorToolkit: 'googlecalendar', accessLane: 'write',
        effect: 'reversible_write', toolName: 'google_calendar_update_event',
        description: 'Patch an existing Google Calendar event identified by its API event ID.',
        input: CalendarEventUpdateSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
        sideEffectLabel: 'update calendar event',
      },
      {
        id: 'calendar.events.delete', connectorToolkit: 'googlecalendar', accessLane: 'write',
        effect: 'destructive', toolName: 'google_calendar_delete_event',
        description: 'Delete a Google Calendar event identified by its API event ID. Confirm the exact event and recurrence scope first.',
        input: CalendarEventDeleteSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
        sideEffectLabel: 'delete calendar event',
      },
    ],
  },
  {
    id: 'google-drive',
    toolkit: 'googledrive',
    providerId: 'google',
    label: 'Google Drive',
    description: 'Search, read, and create Drive files.',
    securityDescription: 'Google sign-in opens through Composio. Chickpea stores only the connected-account reference and this Agent\'s capability ceiling, not Google refresh tokens or a Google OAuth client secret.',
    capabilities: [
      {
        id: 'drive.files.search', connectorToolkit: 'googledrive', accessLane: 'read',
        effect: 'read', toolName: 'google_drive_search_files',
        description: 'Search files and folders in My Drive and accessible shared drives.',
        input: DriveSearchSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
      },
      {
        id: 'drive.files.metadata', connectorToolkit: 'googledrive', accessLane: 'read',
        effect: 'read', toolName: 'google_drive_get_file_metadata',
        description: 'Read bounded metadata for one Google Drive file by its opaque file ID.',
        input: DriveFileSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
      },
      {
        id: 'drive.files.read', connectorToolkit: 'googledrive', accessLane: 'read',
        effect: 'read', toolName: 'google_drive_read_file',
        description: 'Read or export one Google Drive file by ID. Results above Chickpea\'s managed-result limit are rejected.',
        input: DriveReadSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
      },
      {
        id: 'drive.files.create', connectorToolkit: 'googledrive', accessLane: 'write',
        effect: 'reversible_write', toolName: 'google_drive_create_text_file',
        description: 'Create a private text-backed file in the connected account\'s Google Drive root.',
        input: DriveCreateSchema, maxResultBytes: DEFAULT_RESULT_LIMIT,
        sideEffectLabel: 'create Drive file',
      },
    ],
  },
] as const;
