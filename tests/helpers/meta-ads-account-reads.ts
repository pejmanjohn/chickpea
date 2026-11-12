// Meta's account-wide reads with the property names its live tools/list gave
// on 2026-11-11. Discovery stores the names and the account field's flags, not
// definitions, so the other types and required lists are stand-ins. `filters`
// are the arguments Chickpea never lets a call send: each read's ID-shaped
// filters and, on a reviewed read, Meta's November correlation fields.
const text = { type: 'string' };
const count = { type: 'integer' };
const list = { type: 'array', items: text };

const novemberCorrelation = { advertiser_job: text, after_answer_offer_report: text, scheduled_task_run: text };
const correlation = {
  ...novemberCorrelation,
  advertiser_request: text,
  client_conversation_id: { type: ['string', 'null'] },
};

export interface MetaLiveRead {
  name: string;
  properties: Readonly<Record<string, unknown>>;
  required: readonly string[];
  filters: readonly string[];
}

export const META_ACCOUNT_READS: readonly MetaLiveRead[] = [
  {
    name: 'ads_get_ad_account_custom_audiences',
    properties: { ad_account_id: text, ...correlation, cursor: text, limit: count, subtype_filter: text },
    required: ['ad_account_id'],
    filters: Object.keys(novemberCorrelation),
  },
  {
    name: 'ads_get_customconversions',
    properties: { ad_account_id: text, ...correlation, cursor: text, dataset_id: text, limit: count },
    required: ['ad_account_id'],
    filters: ['dataset_id', ...Object.keys(novemberCorrelation)],
  },
];

export const META_ACCOUNT_READ_NAMES = META_ACCOUNT_READS.map(({ name }) => name);

/**
 * Held back from the reviewed contract, though its live shape is account-scoped
 * like the reads above: on 2026-11-12 the model step after its result failed
 * twice on Amber.
 */
export const META_HELD_READ: MetaLiveRead = {
  name: 'ads_account_get_activity_logs',
  properties: {
    ad_account_id: text, ...correlation, end_time: text, event_category: text, limit: count,
    object_id: text, start_time: text, user_id: text,
  },
  required: ['ad_account_id'],
  filters: ['object_id', 'user_id'],
};

/**
 * Reads left for batch 2, which checks who owns the IDs they take. Creatives
 * makes the account optional and takes creative IDs; errors takes entity IDs
 * and no account.
 */
export const META_DEFERRED_READS: readonly MetaLiveRead[] = [
  {
    name: 'ads_get_creatives',
    properties: { ad_account_id: text, ...correlation, creative_ids: list, cursor: text, fields: list, limit: count },
    required: [],
    filters: [],
  },
  {
    name: 'ads_get_errors',
    properties: { ...correlation, entity_ids: list, limit: count },
    required: [],
    filters: [],
  },
];

function liveRead(name: string): MetaLiveRead {
  const read = [...META_ACCOUNT_READS, META_HELD_READ, ...META_DEFERRED_READS].find((entry) => entry.name === name);
  if (!read) throw new Error(`No live shape for ${name}.`);
  return read;
}

/** A read's live input schema, with `extra` properties added and `required` replaced when given. */
export function metaAccountReadSchema(
  name: string,
  options: { extra?: Record<string, unknown>; required?: string[] } = {},
): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  const read = liveRead(name);
  return {
    type: 'object',
    properties: { ...read.properties, ...options.extra },
    required: options.required ?? [...read.required],
  };
}
