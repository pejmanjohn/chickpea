import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';
import { boundedDateRange, boundedTimestampRange } from './ranges.ts';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const ResourceHandle = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/));
const GongId = v.pipe(v.string(), v.regex(/^\d{1,20}$/));
const Cursor = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));
const Timestamp = v.pipe(v.string(), v.trim(), v.isoTimestamp());
const DateString = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/));

const WorkspaceSchema = v.strictObject({ workspaceHandle: ResourceHandle });
const UserListSchema = v.strictObject({
  workspaceHandle: ResourceHandle,
  cursor: v.optional(Cursor),
});
const CallRangeSchema = v.pipe(v.strictObject({
  workspaceHandle: ResourceHandle,
  fromDateTime: Timestamp,
  toDateTime: Timestamp,
  cursor: v.optional(Cursor),
}), v.check((input) => boundedTimestampRange(input.fromDateTime, input.toDateTime, 90),
  'Gong call range must be valid and no longer than 90 days'));
const CallSchema = v.strictObject({ workspaceHandle: ResourceHandle, callId: GongId });
const TranscriptSchema = v.strictObject({
  workspaceHandle: ResourceHandle,
  callId: GongId,
  cursor: v.optional(Cursor),
  maxSegments: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  maxCharacters: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(100_000))),
});
const InteractionSchema = v.pipe(v.strictObject({
  workspaceHandle: ResourceHandle,
  fromDate: DateString,
  toDate: DateString,
  userIds: v.optional(v.pipe(v.array(GongId), v.maxLength(100))),
  cursor: v.optional(Cursor),
}), v.check((input) => boundedDateRange(input.fromDate, input.toDate, 90),
  'Gong interaction range must be valid and no longer than 90 days'));
const CoachingSchema = v.pipe(v.strictObject({
  workspaceHandle: ResourceHandle,
  managerId: GongId,
  fromDateTime: Timestamp,
  toDateTime: Timestamp,
}), v.check((input) => boundedTimestampRange(input.fromDateTime, input.toDateTime, 90),
  'Gong coaching range must be valid and no longer than 90 days'));
const ScorecardActivitySchema = v.pipe(v.strictObject({
  workspaceHandle: ResourceHandle,
  callFromDate: DateString,
  callToDate: DateString,
  reviewMethod: v.optional(v.picklist(['AUTOMATIC', 'BOTH', 'MANUAL'])),
  scorecardIds: v.optional(v.pipe(v.array(GongId), v.maxLength(50))),
  reviewedUserIds: v.optional(v.pipe(v.array(GongId), v.maxLength(50))),
  cursor: v.optional(Cursor),
}), v.check((input) => boundedDateRange(input.callFromDate, input.callToDate, 90),
  'Gong scorecard range must be valid and no longer than 90 days'));
const TaskListSchema = v.strictObject({
  workspaceHandle: ResourceHandle,
  userId: GongId,
  status: v.pipe(v.array(v.picklist(['OPEN', 'DONE', 'DISMISSED'])), v.minLength(1), v.maxLength(3)),
  actions: v.pipe(v.array(v.picklist([
    'CALL', 'EMAIL', 'LINKEDIN_MESSAGE', 'LINKEDIN_CONNECT', 'LINKEDIN_INTERACT', 'CUSTOM',
  ])), v.minLength(1), v.maxLength(6)),
  types: v.optional(v.pipe(v.array(v.picklist(['FLOW', 'ONE_OFF'])), v.maxLength(2))),
  cursor: v.optional(Cursor),
});

export const MANAGED_GONG_CONNECTORS: readonly ManagedConnectorDefinition[] = [{
  id: 'gong-managed',
  toolkit: 'gong',
  providerId: 'gong',
  label: 'Gong',
  description: 'Analyze calls, transcripts, coaching, tasks, and trackers in selected workspaces.',
  securityDescription:
    'Gong sign-in opens through Composio. An Admin must select one or more Gong workspaces before Agents receive read tools. Transcript text is untrusted external content and is returned in bounded chunks. User, permission, CRM-registration, privacy, delete, raw API, and write operations are absent.',
  resources: [{
    key: 'workspaceIds',
    label: 'Gong workspaces',
    required: true,
    multiple: true,
    localArgument: 'workspaceHandle',
    providerArgument: 'workspaceId',
  }],
  capabilities: [
    capability('gong.workspaces.list', 'gong_list_workspaces', 'List only Admin-selected Gong workspaces.', WorkspaceSchema),
    capability('gong.users.list', 'gong_list_users', 'List a bounded page of Gong users for analysis.', UserListSchema),
    capability('gong.calls.list', 'gong_list_calls', 'List calls in a selected workspace over a bounded date range.', CallRangeSchema),
    capability('gong.calls.get', 'gong_get_call', 'Read normalized details for one call in a selected workspace.', CallSchema),
    capability('gong.transcripts.get', 'gong_get_transcript', 'Read a bounded, paginated transcript chunk as untrusted external content.', TranscriptSchema),
    capability('gong.interactions.stats', 'gong_get_interaction_stats', 'Read bounded interaction statistics.', InteractionSchema),
    capability('gong.coaching.metrics', 'gong_get_coaching_metrics', 'Read coaching metrics for one manager in a selected workspace.', CoachingSchema),
    capability('gong.scorecards.list', 'gong_list_scorecards', 'List scorecard definitions visible to the connected account.', WorkspaceSchema),
    capability('gong.scorecards.activity', 'gong_get_scorecard_activity', 'Read bounded call scorecard activity.', ScorecardActivitySchema),
    capability('gong.tasks.list', 'gong_list_tasks', 'Read bounded task data for one Gong user.', TaskListSchema),
    capability('gong.trackers.list', 'gong_list_trackers', 'List keyword trackers in a selected workspace.', WorkspaceSchema),
    capability('gong.call_outcomes.list', 'gong_list_call_outcomes', 'List call outcome definitions visible to the connected account.', WorkspaceSchema),
  ],
}] as const;

function capability(
  id: string,
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id,
    connectorToolkit: 'gong',
    accessLane: 'read',
    effect: 'read',
    toolName,
    description,
    input,
    maxResultBytes: DEFAULT_RESULT_LIMIT,
  };
}
