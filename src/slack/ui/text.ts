/**
 * Text helpers the surface renderers share. Model- or user-supplied text is
 * escaped and clamped for display; ids are matched, never clamped.
 */

import { escapeSlackControlCharacters, neutralizeSlackMrkdwnHandles } from '../message-format.ts';

/** Model- or user-supplied text shown in mrkdwn: no markup and no pings. */
export function escapeMrkdwn(text: string): string {
  return neutralizeSlackMrkdwnHandles(escapeSlackControlCharacters(text));
}

/** Display text only is ever clamped; ids and values are refused instead. */
export function clampDisplay(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function plain(text: string, max = 75): { type: 'plain_text'; text: string; emoji: true } {
  return { type: 'plain_text', text: clampDisplay(text, max), emoji: true };
}

export function mrkdwn(text: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text };
}

const UTC_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** A timestamp Slack renders in the reader's zone, with a UTC fallback. */
export function slackTime(at: number): string {
  return `<!date^${Math.floor(at / 1000)}^{time}|${utcTime(at)}>`;
}

/** A day Slack renders in the reader's zone ("Nov 7, 2026"), with a UTC fallback. */
export function slackDate(at: number): string {
  return `<!date^${Math.floor(at / 1000)}^{date_short}|${UTC_DATE.format(at)}>`;
}

/** A day and time Slack renders in the reader's zone ("tomorrow at 5:00 PM"), with utcDateTime as its fallback. */
export function slackDateTime(at: number): string {
  return `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${utcDateTime(at)}>`;
}

/** The same instant where Slack does not format dates: "Nov 4, 2026 at 00:00 UTC". */
export function utcDateTime(at: number): string {
  return `${UTC_DATE.format(at)} at ${utcTime(at)}`;
}

function utcTime(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

export const SLACK_USER_ID = /^[UW][A-Z0-9]{2,30}$/;
export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
