import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const ResourceHandle = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/));
const YouTubeId = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_-]{1,128}$/));
const Cursor = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));
const Timestamp = v.pipe(v.string(), v.trim(), v.isoTimestamp());
const Title = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));
const Description = v.pipe(v.string(), v.maxLength(5_000));
const Comment = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10_000));
const Privacy = v.picklist(['private', 'unlisted', 'public']);
const ArtifactPath = v.pipe(
  v.string(),
  v.regex(/^\/workspace\/(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/),
);
const VideoMimeType = v.picklist(['video/mp4', 'video/webm', 'video/quicktime']);

const ChannelSchema = v.strictObject({ channelHandle: ResourceHandle });
const ActivitiesSchema = v.pipe(v.strictObject({
  channelHandle: ResourceHandle,
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
  pageToken: v.optional(Cursor),
  publishedAfter: v.optional(Timestamp),
  publishedBefore: v.optional(Timestamp),
}), v.check((input) => boundedTimestampRange(input.publishedAfter, input.publishedBefore, 31),
  'YouTube activity range must be valid and no longer than 31 days'));
const ChannelVideosSchema = v.strictObject({
  channelHandle: ResourceHandle,
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
  pageToken: v.optional(Cursor),
});
const VideosSchema = v.strictObject({
  channelHandle: ResourceHandle,
  videoIds: v.pipe(v.array(YouTubeId), v.minLength(1), v.maxLength(50)),
});
const VideoSchema = v.strictObject({ channelHandle: ResourceHandle, videoId: YouTubeId });
const CommentsSchema = v.strictObject({
  channelHandle: ResourceHandle,
  parentId: YouTubeId,
});
const PlaylistsSchema = v.strictObject({
  channelHandle: ResourceHandle,
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
  pageToken: v.optional(Cursor),
});
const PlaylistItemsSchema = v.strictObject({
  channelHandle: ResourceHandle,
  playlistId: YouTubeId,
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
  pageToken: v.optional(Cursor),
});
const SearchSchema = v.pipe(v.strictObject({
  channelHandle: ResourceHandle,
  query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  type: v.optional(v.picklist(['channel', 'playlist', 'video'])),
  order: v.optional(v.picklist(['date', 'rating', 'relevance', 'title', 'videoCount', 'viewCount'])),
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25))),
  pageToken: v.optional(Cursor),
  publishedAfter: v.optional(Timestamp),
  publishedBefore: v.optional(Timestamp),
}), v.check((input) => boundedTimestampRange(input.publishedAfter, input.publishedBefore, 366),
  'YouTube search range must be valid and no longer than 366 days'));
const PlaylistCreateSchema = v.strictObject({
  channelHandle: ResourceHandle,
  title: Title,
  description: v.optional(Description),
  privacyStatus: Privacy,
});
const PlaylistUpdateSchema = v.strictObject({
  channelHandle: ResourceHandle,
  playlistId: YouTubeId,
  title: Title,
  description: v.optional(Description),
  privacyStatus: Privacy,
});
const PlaylistItemCreateSchema = v.strictObject({
  channelHandle: ResourceHandle,
  playlistId: YouTubeId,
  videoId: YouTubeId,
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5_000))),
});
const CommentCreateSchema = v.strictObject({
  channelHandle: ResourceHandle,
  videoId: YouTubeId,
  text: Comment,
});
const CommentReplySchema = v.strictObject({
  channelHandle: ResourceHandle,
  parentId: YouTubeId,
  text: Comment,
});
const VideoUploadSchema = v.strictObject({
  channelHandle: ResourceHandle,
  artifactPath: ArtifactPath,
  mimeType: VideoMimeType,
  title: Title,
  description: v.optional(Description),
  categoryId: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/))),
  privacyStatus: Privacy,
  tags: v.optional(v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))),
    v.maxLength(30),
  )),
});
const VideoUpdateSchema = v.strictObject({
  channelHandle: ResourceHandle,
  videoId: YouTubeId,
  title: v.optional(Title),
  description: v.optional(Description),
  categoryId: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/))),
  privacyStatus: v.optional(Privacy),
  tags: v.optional(v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))),
    v.maxLength(30),
  )),
});
const ThumbnailSchema = v.strictObject({
  channelHandle: ResourceHandle,
  videoId: YouTubeId,
  thumbnailUrl: v.pipe(v.string(), v.url(), v.maxLength(2_000)),
});

export const MANAGED_YOUTUBE_CONNECTORS: readonly ManagedConnectorDefinition[] = [{
  id: 'youtube-managed',
  toolkit: 'youtube',
  providerId: 'google',
  label: 'YouTube',
  description: 'Analyze and manage explicitly selected YouTube channels.',
  securityDescription:
    'Google sign-in opens through Composio. An Admin must select an authorized channel before Agents receive tools. Chickpea confines video uploads to frozen workspace artifacts, reserves provider-wide quota before dispatch, and requires confirmation for publication. Delete, account administration, permissions, bulk moderation, and raw API tools are absent.',
  resources: [{
    key: 'channelIds',
    label: 'YouTube channels',
    required: true,
    multiple: true,
    localArgument: 'channelHandle',
    providerArgument: 'channelId',
  }],
  capabilities: [
    read('youtube.channels.get', 'youtube_get_channel', 'Read identity and statistics for one selected channel.', ChannelSchema, 1),
    read('youtube.activities.list', 'youtube_list_channel_activities', 'List a bounded page of activities from one selected channel.', ActivitiesSchema, 1),
    read('youtube.videos.list', 'youtube_list_channel_videos', 'List a bounded page of videos owned by one selected channel.', ChannelVideosSchema, 1),
    read('youtube.videos.get', 'youtube_get_video_details', 'Read details for up to 50 videos owned by one selected channel.', VideosSchema, 1),
    read('youtube.captions.list', 'youtube_list_caption_tracks', 'List caption metadata for one video owned by the selected channel; caption content is not returned.', VideoSchema, 51),
    read('youtube.comments.list_replies', 'youtube_list_comment_replies', 'List a bounded page of replies for one comment.', CommentsSchema, 1),
    read('youtube.playlists.list', 'youtube_list_channel_playlists', 'List a bounded page of playlists owned by one selected channel.', PlaylistsSchema, 1),
    read('youtube.playlist_items.list', 'youtube_list_playlist_items', 'List a bounded page of items from a playlist owned by one selected channel.', PlaylistItemsSchema, 11),
    {
      ...read('youtube.search.public', 'youtube_search_public', 'Search public YouTube data. Results do not grant management authority over another channel.', SearchSchema, 1),
      quota: [{ bucket: 'search_calls', units: 1 }],
    },
    write('youtube.playlists.create', 'youtube_create_playlist', 'Create a playlist on the selected channel.', PlaylistCreateSchema, 'external_publish', 'create a YouTube playlist with the specified visibility', 61),
    write('youtube.playlists.update', 'youtube_update_playlist', 'Update one playlist owned by the selected channel.', PlaylistUpdateSchema, 'external_publish', 'update a YouTube playlist and its visibility', 71),
    write('youtube.playlist_items.add', 'youtube_add_video_to_playlist', 'Add one public or selected-channel video to a playlist owned by the selected channel.', PlaylistItemCreateSchema, 'external_publish', 'publish a YouTube playlist item', 62),
    write('youtube.comments.create', 'youtube_create_comment', 'Publish one comment as the selected connected channel.', CommentCreateSchema, 'external_publish', 'publish a YouTube comment', 53),
    write('youtube.comments.reply', 'youtube_reply_to_comment', 'Publish one reply as the selected connected channel.', CommentReplySchema, 'external_publish', 'publish a YouTube comment reply', 52),
    {
      ...write('youtube.videos.upload', 'youtube_upload_video', 'Upload one bounded frozen workspace video to the selected channel.', VideoUploadSchema, 'external_publish', 'upload a YouTube video with the specified visibility', 1),
      quota: [
        { bucket: 'video_insert_calls', units: 1 },
        { bucket: 'general_units', units: 2 },
      ],
      artifact: {
        argument: 'artifactPath',
        mimeTypeArgument: 'mimeType',
        maxBytes: 8 * 1024 * 1024,
        allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
      },
    },
    write('youtube.videos.update', 'youtube_update_video', 'Update metadata or visibility for one video owned by the selected channel.', VideoUpdateSchema, 'external_publish', 'update YouTube video metadata or visibility', 53),
    write('youtube.thumbnails.set', 'youtube_set_thumbnail', 'Set a reviewed HTTPS thumbnail URL on one video owned by the selected channel.', ThumbnailSchema, 'external_publish', 'publish a YouTube video thumbnail', 53),
  ],
}] as const;

function read(
  id: string,
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
  quotaUnits: number,
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id, connectorToolkit: 'youtube', accessLane: 'read', effect: 'read', toolName,
    description, input, maxResultBytes: DEFAULT_RESULT_LIMIT,
    quota: [{ bucket: 'general_units', units: quotaUnits }],
  };
}

function write(
  id: string,
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
  effect: 'reversible_write' | 'external_publish',
  sideEffectLabel: string,
  quotaUnits: number,
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id, connectorToolkit: 'youtube', accessLane: 'write', effect, toolName,
    description, input, maxResultBytes: DEFAULT_RESULT_LIMIT, sideEffectLabel,
    quota: [{ bucket: 'general_units', units: quotaUnits }],
  };
}

function boundedTimestampRange(
  start: string | undefined,
  end: string | undefined,
  maxDays: number,
): boolean {
  if (!start || !end) return true;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs &&
    (endMs - startMs) / 86_400_000 <= maxDays;
}
