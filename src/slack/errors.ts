import { SlackTransportError } from './transport/types.ts';

/**
 * Slack's machine error code for a thrown delivery failure: the transport
 * error's own code, or the `data.error` the Slack SDK attaches to a Web API
 * rejection. Content-free by construction, so callers can classify a failure
 * without carrying message text into logs or receipts.
 */
export function slackPlatformErrorCode(error: unknown): string | undefined {
  if (error instanceof SlackTransportError) return error.code;
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' ? code : undefined;
}
