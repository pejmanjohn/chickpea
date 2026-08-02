const EXPLICIT_RECURRENCE =
  /\b(?:every|each|hourly|daily|weekly|monthly|weekdays?|weekends?|cron)\b/i;
const ONE_TIME_SCHEDULE =
  /\b(?:today|tomorrow|tonight|once|(?:this|next)\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|in\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:minutes?|hours?|days?)|on\s+\d{4}-\d{2}-\d{2}|(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|at\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)))\b/i;

export function isRoutineIntentCandidate(rawText: string, resolvedBotUserId?: string): boolean {
  const text = stripLeadingBotMention(rawText, resolvedBotUserId).trim();
  if (!text || /^!routines?\b/i.test(text)) return false;
  const recurrence = EXPLICIT_RECURRENCE.test(text) || /\b(?:scheduled?|routine)\b/i.test(text);
  const workAction = /\b(?:create|add|set\s*up|schedule|change|edit|update|run|post|send|summari[sz]e|triage|check|watch|monitor|remind|report)\b/i;
  const managementAction = /\b(?:show|pause|resume|enable|disable|run|clone|copy|delete|remove|edit|change|update)\b/i;
  const namedWork = /\b(?:routine|scheduled\s+(?:job|work)|rollup|digest|summary|report|monitor|reminder|check)\b/i;
  const quotedName = /["“][^"”]{1,200}["”]/.test(text);
  return ((recurrence || ONE_TIME_SCHEDULE.test(text)) && workAction.test(text)) ||
    (managementAction.test(text) && (namedWork.test(text) || quotedName));
}

export function routineIntentNeedsDefaultTimezone(rawText: string): boolean {
  const text = stripLeadingBotMention(rawText, undefined).trim();
  return EXPLICIT_RECURRENCE.test(text) || ONE_TIME_SCHEDULE.test(text);
}

function stripLeadingBotMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) return text.replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '');
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*(?:<@${escaped}>\\s*)+`, 'i'), '');
}
