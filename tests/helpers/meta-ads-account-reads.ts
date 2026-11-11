// Synthetic input schemas for Meta's account-wide reads, shaped from Meta's
// one-line tool descriptions. The docs name no arguments, so every name below
// is a guess that the Amber probe checks against Meta's live listing. `filters`
// are the ID-shaped filters each description mentions, which Chickpea never
// lets a call send.
const text = { type: 'string' };
const count = { type: 'integer' };
const list = { type: 'array', items: text };

export const META_ACCOUNT_READS: ReadonlyArray<{
  name: string;
  filters: Readonly<Record<string, unknown>>;
  other: Readonly<Record<string, unknown>>;
}> = [
  {
    name: 'ads_account_get_activity_logs',
    filters: { object_id: text, user_id: text },
    other: { category: text, cursor: text, limit: count, since: text, until: text },
  },
  { name: 'ads_get_errors', filters: { entity_ids: list }, other: { limit: count } },
  { name: 'ads_get_creatives', filters: {}, other: { cursor: text, fields: list, limit: count } },
  { name: 'ads_get_ad_account_custom_audiences', filters: {}, other: { cursor: text, limit: count, subtype: text } },
  { name: 'ads_get_customconversions', filters: {}, other: { cursor: text, limit: count } },
];

export const META_ACCOUNT_READ_NAMES = META_ACCOUNT_READS.map(({ name }) => name);

/** Every property of a read's synthetic schema, before `extra`. */
export function metaAccountReadProperties(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const read = META_ACCOUNT_READS.find((entry) => entry.name === name);
  if (!read) throw new Error(`No synthetic schema for ${name}.`);
  return {
    ad_account_id: text,
    advertiser_request: text,
    client_conversation_id: { type: ['string', 'null'] },
    ...read.filters,
    ...read.other,
    ...extra,
  };
}

export function metaAccountReadSchema(
  name: string,
  options: { extra?: Record<string, unknown>; required?: string[] } = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties: metaAccountReadProperties(name, options.extra),
    required: options.required ?? ['ad_account_id'],
  };
}
