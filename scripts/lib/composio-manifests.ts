import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  COMPOSIO_MANIFEST_LIMITS,
  COMPOSIO_MANIFESTS,
  HELD_COMPOSIO_MANIFESTS,
  parseComposioManifest,
  type ComposioManifest,
  type ComposioManifestAuth,
  type ComposioManifestCapability,
  type ManifestInputSchema,
  type ManifestObjectSchema,
} from '../../src/connections/catalog/composio-manifests.ts';
import type { ManagedEffectClass } from '../../src/connections/catalog/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST_DIRECTORY = path.join(ROOT, 'src', 'connections', 'catalog', 'manifests');
export const SNAPSHOT_DIRECTORY = path.join(MANIFEST_DIRECTORY, 'snapshots');

export interface ComposioSnapshotTool {
  slug: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  deprecated: boolean;
  input: unknown;
}

export interface ComposioSnapshot {
  toolkit: {
    slug: string;
    name: string;
    version: string;
    description: string;
    managedAuthSchemes: string[];
    authModes: Array<{ mode: string; fields: string[] }>;
    currentUserEndpoint: string | null;
  };
  tools: ComposioSnapshotTool[];
}

export interface DraftReport {
  toolkit: string;
  version: string;
  validationCapability: string;
  read: string[];
  write: Array<{ tool: string; effect: ManagedEffectClass }>;
  excluded: Array<{ tool: string; reason: string }>;
  withheldArguments: Array<{ tool: string; arguments: Record<string, string> }>;
  preconditions: Array<{ tool: string; argument: string }>;
  /** Write tools without `destructiveHint` that the irreversibility lint made destructive. */
  irreversible: Array<{ tool: string; verb: string }>;
}

const HINTS = ['readOnlyHint', 'createHint', 'updateHint', 'destructiveHint'] as const;

const words = (text: string) => text.trim().split(/\s+/);

/**
 * A create or update hint does not make these reversible; the lint reclassifies
 * them as destructive. Delete synonyms and one-way actions such as submit,
 * approve, rotate, and deploy all count.
 */
const IRREVERSIBLE_VERBS = new Set(words(`
  archive cancel clear delete destroy detach discard drop empty erase expire merge purge remove revoke
  terminate transfer trash truncate unlink void wipe
  approve decline deploy execute finalize overwrite regenerate reject reset rotate submit
`));
/** Also adjectives ("an empty board", "clear text"), so in a tool name they count only as its first word. */
const LEADING_ONLY_VERBS = new Set(['clear', 'empty']);

const READ_LINT_LEADING_VERBS = new Set([...words(`
  ACKNOWLEDGE ACTIVATE ADD APPEND APPLY ASSIGN ATTACH BAN BLOCK BOOK BUY CHARGE CLONE CLOSE CONNECT
  CONVERT COPY CREATE DEACTIVATE DISABLE DISCONNECT DUPLICATE EDIT ENABLE ENQUEUE FOLLOW FORWARD GRANT
  IMPORT INSERT INSTALL INVITE INVOKE JOIN KICK LEAVE LIKE LINK LOCK MARK MODIFY MOVE MUTE PATCH PAUSE
  PAY PIN PING POST PUBLISH PURCHASE PUT REFUND REGISTER RENAME REOPEN REPLACE REPLY RESOLVE RESTART
  RESTORE RESUME ROLLBACK SCHEDULE SEND SET SHARE SNOOZE START STAR STOP SUBSCRIBE SUSPEND SYNC TAG
  TRIGGER UNARCHIVE UNASSIGN UNBAN UNBLOCK UNFOLLOW UNINSTALL UNLIKE UNLOCK UNMUTE UNPIN UNPUBLISH
  UNSTAR UNSUBSCRIBE UNTAG UNTRASH UPDATE UPLOAD UPSERT VOTE
`), ...[...IRREVERSIBLE_VERBS].map((verb) => verb.toUpperCase())]);
const READ_LINT_MARKERS = /(?:^|_)(ARCHIVE|DELETE|DELETED|MARK|PURGE|REMOVE|REMOVED|SEND|SENT|TRASH)(?:_|$)/;
/** Not "execute": "Executes a SOQL query…" opens Salesforce, Google Ads, and Mixpanel query reads. */
const READ_LINT_DESCRIPTION_VERBS = new Set([...words(`
  add append assign attach block charge close create disable edit enable forward grant import insert
  invite mark modify move pay ping publish purchase refund rename reply schedule send share start stop
  subscribe trigger unsubscribe update upload upsert
`), ...[...IRREVERSIBLE_VERBS].filter((verb) => verb !== 'execute')]);

const REVIEW_REQUIRED_EFFECTS = new Set<ManagedEffectClass>([
  'destructive', 'administrative', 'spend_or_budget', 'external_publish',
]);
const ADMINISTRATIVE = /(?:^|_)(ADMIN|ADMINS|AGENT|AGENTS|API_KEY|API_KEYS|AUDIT|CREDENTIAL|CREDENTIALS|GROUP|GROUPS|INTEGRATION|INTEGRATIONS|MEMBER|MEMBERS|MEMBERSHIP|MEMBERSHIPS|ORGANIZATION|ORGANIZATIONS|PASSWORD|PASSWORDS|PERMISSION|PERMISSIONS|POLICIES|POLICY|ROLE|ROLES|SCIM|SECRET|SECRETS|SETTING|SETTINGS|SLA|SSO|TEAM|TEAMS|TOKEN|TOKENS|USER|USERS|WEBHOOK|WEBHOOKS|WORKSPACE|WORKSPACES)(?:_|$)/;
const SPEND = /(?:^|_)(BID|BIDS|BILL|BILLING|BILLS|BUDGET|BUDGETS|BUY|CHARGE|CHARGES|CHECKOUT|INVOICE|INVOICES|ORDER|ORDERS|PAY|PAYMENT|PAYMENTS|PAYOUT|PAYOUTS|PURCHASE|REFUND|REFUNDS|SUBSCRIPTION|SUBSCRIPTIONS|TRANSFER|TRANSFERS)(?:_|$)/;
const PUBLISH = /(?:^|_)(BROADCAST|COMMENT|COMMENTS|EMAIL|EMAILS|FORWARD|INVITE|MESSAGE|MESSAGES|NOTIFY|OUTBOUND|POST|PUBLISH|REPLY|SEND|SHARE)(?:_|$)/;

/**
 * Who can see, follow, or act on a record. Company domains count, because
 * Freshdesk joins new contacts to a company by domain, which widens ticket
 * visibility. Webhooks and callbacks hand record data to an outside URL.
 */
const ACCESS_TOKENS = new Set(words(`
  acl admin admins agent agents assignee assignees callback collaborator collaborators domain domains
  follower followers group groups guest guests member members org orgs organization organizations
  owner owners private public responder role roles subscriber subscribers team teams user users
  watcher watchers webhook webhooks
`));
const ACCESS_TEXT = /permission|visib|privacy|invit|selfjoin|viewall|share|membership/;
const ACCESS_DESCRIPTION = /\b(?:permissions?|visibility|visible to|public|private|publication|publish\w*|who can|invit\w*|membership)\b/i;
/** "Required for application-level permissions" names the caller's OAuth grant, not who can see the record. */
const GRANT_TYPE_PHRASE = /\b(?:application|app|delegated)(?:[- ](?:level|only))?\s+permissions?\b/gi;
/** A conflict option such as `replace`, or a boolean `overwrite`, lets a write replace an existing item. */
const OVERWRITE = /^(?:overwrite|replace)$/i;
const CONTAINER_TOKENS = new Set(words(`
  account board company folder organization parent product project space team workspace
`));
/**
 * Withheld on create too. A Freshdesk ticket's company shows it to that
 * company's contacts who can view all its tickets, and its product picks the
 * mailbox replies come from. No ID on a create names the record itself, so a
 * required one is withheld as well and the tool needs review.
 */
const AUDIENCE_CONTAINER_TOKENS = new Set(['company', 'product']);
/**
 * An email address on any write, create included, is a place mail can go. A
 * ticket's requester receives every reply, so a free requester email on
 * create-ticket would undo a reply bound to the requester.
 */
const RECIPIENT_TOKENS = new Set(words(`
  attendee attendees bcc cc email emails participant participants recipient recipients
`));
/** `to_emails`, `from_email`, and `to` address a message; `applicable_to` does not. */
const ADDRESS_LEADING_TOKENS = new Set(['from', 'to']);
const IDENTITY_TOKENS = new Set(words(`
  external facebook instagram linkedin login mobile password phone requester twitter username
`));

const WITHHELD_ACCESS = 'changes sharing, visibility, permissions, membership, or who acts';
const WITHHELD_MOVE = 'moves the record to another container';
const WITHHELD_AUDIENCE = 'puts the record under a company or product, which can widen who sees it or change its sending mailbox';
const WITHHELD_COPY = 'copies content from another record, URL, or file';
const WITHHELD_RECIPIENT = 'names an address a message goes to or comes from';
const WITHHELD_IDENTITY = 'changes who the record belongs to or how a person is identified';
const WITHHELD_OVERWRITE = 'can replace an existing item';

/** A tool with both hints counts as a create. `other` is a delete, whose IDs name the record itself. */
type WriteKind = 'create' | 'update' | 'other';

function writeKind(tags: readonly string[]): WriteKind {
  if (tags.includes('createHint')) return 'create';
  return tags.includes('updateHint') ? 'update' : 'other';
}

/**
 * Writes run without a per-call confirmation, so a write tool's schema is the
 * gate. These rules withhold arguments that widen access, copy from another
 * record, address a message to someone, place a new record under a company or
 * product, or, on update, move a record out of its container or change who it
 * belongs to.
 */
function withheldArgumentReason(
  name: string,
  schema: unknown,
  required: boolean,
  kind: WriteKind,
): string | undefined {
  const tokens = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const compact = tokens.join('');
  const description = isPlainObject(schema) && typeof schema.description === 'string' ? schema.description : '';
  if (tokens.some((token) => ACCESS_TOKENS.has(token)) || ACCESS_TEXT.test(compact) ||
      ACCESS_DESCRIPTION.test(description.replace(GRANT_TYPE_PHRASE, ''))) return WITHHELD_ACCESS;
  if (tokens.includes('overwrite') ||
      enumValues(schema).some((value) => typeof value === 'string' && OVERWRITE.test(value))) {
    return WITHHELD_OVERWRITE;
  }
  if ((tokens.length > 1 && tokens.at(-1) === 'source') || tokens[0]?.startsWith('file')) return WITHHELD_COPY;
  if (tokens.some((token) => RECIPIENT_TOKENS.has(token) || token.startsWith('notify')) ||
      ADDRESS_LEADING_TOKENS.has(tokens[0] ?? '') || compact.includes('replyto')) return WITHHELD_RECIPIENT;
  const identifier = tokens[0] === 'id' || tokens.at(-1) === 'id' || tokens.at(-1) === 'ids';
  // A required container ID on update usually names the record itself (company_id on update-company).
  if (kind === 'update' && !required && identifier && tokens.some((token) => CONTAINER_TOKENS.has(token))) {
    return WITHHELD_MOVE;
  }
  if (kind === 'create' && identifier && tokens.some((token) => AUDIENCE_CONTAINER_TOKENS.has(token))) {
    return WITHHELD_AUDIENCE;
  }
  if (kind === 'update' && tokens.some((token) => IDENTITY_TOKENS.has(token))) return WITHHELD_IDENTITY;
  return undefined;
}

export function readLaneLintHit(name: string, description: string): string | undefined {
  const leading = name.split('_')[0] ?? '';
  if (READ_LINT_LEADING_VERBS.has(leading)) return leading;
  return READ_LINT_MARKERS.exec(name)?.[1] ?? leadingDescriptionVerb(description, READ_LINT_DESCRIPTION_VERBS);
}

/** A name token can mark a state as well as an action: `SET_BOOKING_CANCELLED`, `MARK_TABLE_DROPPED`. */
function irreversibleVerb(name: string, description: string): string | undefined {
  return name.split('_').find((token, index) => {
    const verb = baseVerb(token, IRREVERSIBLE_VERBS, true);
    return verb !== undefined && (index === 0 || !LEADING_ONLY_VERBS.has(verb));
  }) ?? leadingDescriptionVerb(description, IRREVERSIBLE_VERBS);
}

/** Reads "Deletes…" and, past a leading adverb, "Permanently deletes…". */
function leadingDescriptionVerb(description: string, verbs: ReadonlySet<string>): string | undefined {
  const text = description.trim()
    .replace(/^(?:tool|action|endpoint|api)\s+(?:to|that|which)\s+/i, '')
    .replace(/^(?:this|the)\s+(?:tool|action|endpoint)\s+/i, '')
    .replace(/^(?:use this to|used to|allows you to|lets you|helps you)\s+/i, '');
  const [, first, second] = /^([A-Za-z]+)(?:\s+([A-Za-z]+))?/.exec(text) ?? [];
  if (!first) return undefined;
  return baseVerb(first, verbs, false) ??
    (second && /ly$/i.test(first) ? baseVerb(second, verbs, false) : undefined);
}

/**
 * The verb in `verbs` that `word` inflects: "deletes", "empties", and, with
 * `participles`, "archived", "cancelled", and "emptied". Descriptions skip
 * participles, which open with an adjective ("Archived boards…").
 */
function baseVerb(word: string, verbs: ReadonlySet<string>, participles: boolean): string | undefined {
  const lower = word.toLowerCase();
  const candidates = [lower, lower.replace(/s$/, ''), lower.replace(/es$/, ''), lower.replace(/ies$/, 'y')];
  if (participles) {
    candidates.push(lower.replace(/d$/, ''), lower.replace(/ed$/, ''), lower.replace(/ied$/, 'y'),
      lower.replace(/([^aeiou])\1ed$/, '$1'));
  }
  return candidates.find((candidate) => verbs.has(candidate));
}

function writeEffect(name: string): ManagedEffectClass {
  if (ADMINISTRATIVE.test(name)) return 'administrative';
  if (SPEND.test(name)) return 'spend_or_budget';
  if (PUBLISH.test(name)) return 'external_publish';
  return 'reversible_write';
}

type Classification =
  | { lane: 'read'; effect: 'read' }
  | { lane: 'write'; effect: ManagedEffectClass; irreversible?: string }
  | { excluded: string };

function classify(tool: ComposioSnapshotTool, name: string): Classification {
  if (tool.deprecated) return { excluded: 'deprecated' };
  const hints = HINTS.filter((hint) => tool.tags.includes(hint));
  if (hints.length === 0) return { excluded: 'no read or write hint' };
  if (hints.includes('readOnlyHint')) {
    if (hints.length > 1) return { excluded: 'conflicting hints' };
    const hit = readLaneLintHit(name, tool.description);
    return hit ? { excluded: `read lint hit "${hit}"; never reclassified` } : { lane: 'read', effect: 'read' };
  }
  if (hints.includes('destructiveHint')) return { lane: 'write', effect: 'destructive' };
  const irreversible = irreversibleVerb(name, tool.description);
  return irreversible
    ? { lane: 'write', effect: 'destructive', irreversible }
    : { lane: 'write', effect: writeEffect(name) };
}

type Derived<T> = { schema: T } | { unsupported: string };

interface DeriveContext {
  /** Withhold access, move, and copy arguments; only write tools set this. */
  write?: WriteKind;
  /** Argument paths a reviewer kept despite a withholding rule. */
  allow: ReadonlySet<string>;
  withheld: Record<string, string>;
  allowedKept: string[];
}

export function deriveInputSchema(
  raw: unknown,
  options: { write?: WriteKind; allow?: ReadonlySet<string> } = {},
): { schema: ManifestObjectSchema; withheld: Record<string, string>; allowedKept: string[] } | { error: string } {
  const context: DeriveContext = { ...options, allow: options.allow ?? new Set(), withheld: {}, allowedKept: [] };
  const derived = deriveNode(raw, 0, '', context, true);
  if ('unsupported' in derived) return { error: derived.unsupported };
  if (!('type' in derived.schema) || derived.schema.type !== 'object') return { error: 'input is not an object' };
  return { schema: derived.schema, withheld: context.withheld, allowedKept: context.allowedKept };
}

function deriveNode(
  raw: unknown,
  depth: number,
  where: string,
  context: DeriveContext,
  root = false,
): Derived<ManifestInputSchema> {
  if (depth > COMPOSIO_MANIFEST_LIMITS.depth) return { unsupported: `${where || 'input'} nests too deeply` };
  if (!isPlainObject(raw)) return { unsupported: `${where || 'input'} has no schema` };
  if (raw.file_uploadable === true) return { unsupported: `${where} is a file upload` };
  const description = boundedText(raw.description, COMPOSIO_MANIFEST_LIMITS.descriptionLength);
  const variants = Array.isArray(raw.anyOf) ? raw.anyOf
    : Array.isArray(raw.type) ? raw.type.map((type) => ({ ...raw, type })) : undefined;
  if (variants) {
    const present = variants.filter((variant) => !isPlainObject(variant) || variant.type !== 'null');
    if (present.length === 1) {
      const inner = isPlainObject(present[0]) ? present[0] : {};
      return deriveNode({ ...inner, description: inner.description ?? raw.description }, depth, where, context);
    }
    const branches = present.map((variant) =>
      isPlainObject(variant) && typeof variant.type === 'string' &&
        ['string', 'integer', 'number', 'boolean'].includes(variant.type)
        ? deriveNode({ ...variant, description: undefined }, depth, where, context)
        : { unsupported: `${where} mixes structured types` } as const);
    const failed = branches.find((branch) => 'unsupported' in branch);
    if (failed || branches.length === 0) return failed ?? { unsupported: `${where} has no usable type` };
    return {
      schema: withDescription({ anyOf: branches.map((branch) => (branch as { schema: ManifestInputSchema }).schema) }, description),
    };
  }
  switch (raw.type) {
    case 'string': {
      const maxLength = Math.min(positiveInteger(raw.maxLength) ?? Infinity, COMPOSIO_MANIFEST_LIMITS.stringLength);
      const minLength = positiveInteger(raw.minLength);
      const values = Array.isArray(raw.enum) && raw.enum.length > 0 &&
        raw.enum.length <= COMPOSIO_MANIFEST_LIMITS.enumValues &&
        raw.enum.every((value) => typeof value === 'string' && value.length <= COMPOSIO_MANIFEST_LIMITS.enumValueLength)
        ? raw.enum as string[] : undefined;
      return {
        schema: withDescription({
          type: 'string', maxLength,
          ...(minLength && minLength <= maxLength ? { minLength } : {}),
          ...(values ? { enum: values } : {}),
        }, description),
      };
    }
    case 'integer':
    case 'number': {
      const integer = raw.type === 'integer';
      const minimum = finite(raw.minimum) ??
        (finite(raw.exclusiveMinimum) === undefined ? undefined : finite(raw.exclusiveMinimum)! + (integer ? 1 : 0));
      const maximum = finite(raw.maximum) ??
        (finite(raw.exclusiveMaximum) === undefined ? undefined : finite(raw.exclusiveMaximum)! - (integer ? 1 : 0));
      return {
        schema: withDescription({
          type: raw.type,
          ...(minimum === undefined ? {} : { minimum }),
          ...(maximum === undefined ? {} : { maximum }),
        }, description),
      };
    }
    case 'boolean':
      return { schema: withDescription({ type: 'boolean' }, description) };
    case 'array': {
      const items = deriveNode(raw.items, depth + 1, `${where}[]`, context);
      if ('unsupported' in items) return items;
      const maxItems = Math.min(positiveInteger(raw.maxItems) ?? Infinity, COMPOSIO_MANIFEST_LIMITS.arrayItems);
      const minItems = positiveInteger(raw.minItems);
      return {
        schema: withDescription({
          type: 'array', items: items.schema, maxItems,
          ...(minItems && minItems <= maxItems ? { minItems } : {}),
        }, description),
      };
    }
    case 'object': {
      const source = isPlainObject(raw.properties) ? Object.entries(raw.properties) : [];
      if (source.length === 0 && !root) return { unsupported: `${where} is a free-form object` };
      const required = new Set(Array.isArray(raw.required) ? raw.required.filter((key) => typeof key === 'string') : []);
      const properties: Record<string, ManifestInputSchema> = {};
      for (const [key, child] of source) {
        const childWhere = where ? `${where}.${key}` : key;
        const withheld = context.write
          ? withheldArgumentReason(key, child, required.has(key), context.write)
          : undefined;
        if (withheld && !context.allow.has(childWhere)) {
          // Withholding an argument whose default overwrites would still overwrite.
          const overwritesByDefault = withheld === WITHHELD_OVERWRITE && isPlainObject(child) &&
            (child.default === true || (typeof child.default === 'string' && OVERWRITE.test(child.default)));
          if (required.has(key) || overwritesByDefault) {
            const argument = required.has(key)
              ? `required argument ${childWhere} ${withheld}`
              : `argument ${childWhere} ${withheld} by default`;
            return { unsupported: `administrative: ${argument}; keep it only through review.allowArguments and review.add` };
          }
          context.withheld[childWhere] = withheld;
          continue;
        }
        const derived = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) &&
            Object.keys(properties).length < COMPOSIO_MANIFEST_LIMITS.properties
          ? deriveNode(child, depth + 1, childWhere, context)
          : { unsupported: `${childWhere} exceeds the property limit or naming rule` };
        if ('schema' in derived) {
          properties[key] = derived.schema;
          if (withheld) context.allowedKept.push(childWhere);
        } else if (required.has(key)) {
          return { unsupported: `required argument ${derived.unsupported}` };
        } else {
          context.withheld[childWhere] = 'unsupported schema';
        }
      }
      if (!root && Object.keys(properties).length === 0) return { unsupported: `${where} has no usable properties` };
      const kept = [...required].filter((key) => key in properties);
      if (kept.length !== required.size) return { unsupported: `${where || 'input'} requires an undeclared argument` };
      return {
        schema: withDescription({
          type: 'object', properties,
          ...(kept.length > 0 ? { required: kept } : {}),
        }, description),
      };
    }
    default:
      return { unsupported: `${where || 'input'} has unsupported type ${JSON.stringify(raw.type ?? null)}` };
  }
}

export function draftComposioManifest(
  snapshot: ComposioSnapshot,
  previous?: ComposioManifest,
): { manifest: ComposioManifest; report: DraftReport } {
  const toolkit = snapshot.toolkit.slug;
  if (previous && previous.toolkit !== toolkit) throw new Error('previous manifest belongs to another toolkit');
  const auth = deriveAuth(snapshot);
  const label = previous?.label ?? snapshot.toolkit.name;
  const add = new Set(previous?.review.add ?? []);
  const drop = previous?.review.drop ?? {};
  const allowArguments = previous?.review.allowArguments ?? {};
  const kept = new Map(previous?.capabilities.map((capability) => [capability.tool, capability]) ?? []);
  const prefix = `${toolkit.toUpperCase()}_`;
  const report: DraftReport = {
    toolkit, version: snapshot.toolkit.version, validationCapability: '',
    read: [], write: [], excluded: [], withheldArguments: [], preconditions: [], irreversible: [],
  };
  const capabilities: ComposioManifestCapability[] = [];
  for (const tool of [...snapshot.tools].sort((left, right) => left.slug.localeCompare(right.slug))) {
    if (!tool.tags.includes('important') && !add.has(tool.slug)) continue;
    const exclude = (reason: string) => report.excluded.push({ tool: tool.slug, reason });
    const name = tool.slug.startsWith(prefix) ? tool.slug.slice(prefix.length) : tool.slug;
    if (drop[tool.slug]) {
      exclude(`reviewer: ${drop[tool.slug]}`);
      continue;
    }
    const classification = classify(tool, name);
    if ('excluded' in classification) {
      exclude(classification.excluded);
      continue;
    }
    const irreversible = 'irreversible' in classification ? classification.irreversible : undefined;
    if (irreversible) report.irreversible.push({ tool: tool.slug, verb: irreversible });
    const write = classification.lane === 'write';
    const input = deriveInputSchema(tool.input, {
      ...(write ? { write: writeKind(tool.tags) } : {}),
      allow: new Set(allowArguments[tool.slug] ?? []),
    });
    if ('error' in input) {
      exclude(input.error);
      continue;
    }
    const effect = input.allowedKept.length > 0 && classification.effect !== 'destructive'
      ? 'administrative'
      : classification.effect;
    if (REVIEW_REQUIRED_EFFECTS.has(effect) && !add.has(tool.slug)) {
      const notes = [
        ...(irreversible ? [`irreversible verb ${irreversible}`] : []),
        ...(input.allowedKept.length > 0 ? [`keeps ${input.allowedKept.join(', ')}`] : []),
      ];
      exclude(`${effect}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}; include only by adding it to review.add`);
      continue;
    }
    const toolName = `${toolkit}_${name.toLowerCase()}`;
    if (toolName.length > 64) {
      exclude('model tool name is longer than 64 characters');
      continue;
    }
    const previousCapability = kept.get(tool.slug);
    const withheld = Object.keys(input.withheld).length > 0;
    capabilities.push({
      id: `${toolkit}.${name.toLowerCase()}`,
      tool: tool.slug,
      toolName,
      lane: classification.lane,
      effect,
      description: previousCapability?.description ?? boundedText(tool.description, 1_000) ?? tool.name,
      ...(write ? {
        sideEffectLabel: previousCapability?.sideEffectLabel ?? boundedText(`${label}: ${tool.name}`, 240)!,
      } : {}),
      maxResultBytes: COMPOSIO_MANIFEST_LIMITS.resultBytes,
      ...(withheld ? { withheldArguments: input.withheld } : {}),
      ...(previousCapability?.preconditions ? { preconditions: previousCapability.preconditions } : {}),
      input: input.schema,
    });
    for (const { argument } of previousCapability?.preconditions ?? []) {
      report.preconditions.push({ tool: tool.slug, argument });
    }
    if (withheld) report.withheldArguments.push({ tool: tool.slug, arguments: input.withheld });
    if (write) report.write.push({ tool: tool.slug, effect });
    else report.read.push(tool.slug);
  }
  const validationCandidates = capabilities.filter(({ lane, input }) => lane === 'read' && !input.required);
  const validation = validationCandidates.find(({ id }) => id === previous?.validationCapability) ??
    validationCandidates.find(({ tool }) => /(?:^|_)(WHO_AM_I|ME|CURRENT|AUTHENTICATED|ACCOUNT|PROFILE)(?:_|$)/.test(tool)) ??
    validationCandidates[0];
  if (!validation) throw new Error(`${toolkit} has no read tool without required input to validate a connection`);
  report.validationCapability = validation.id;
  const manifest: ComposioManifest = {
    toolkit,
    version: snapshot.toolkit.version,
    auth,
    label,
    description: previous?.description ?? boundedText(snapshot.toolkit.description, 240) ?? label,
    securityDescription: previous?.securityDescription ?? defaultSecurityDescription(label, auth),
    preset: previous?.preset ?? { category: 'business', accent: '#000000' },
    validationCapability: validation.id,
    review: {
      add: [...add].sort(),
      drop: Object.fromEntries(Object.entries(drop).sort()),
      allowArguments: Object.fromEntries(Object.entries(allowArguments).sort()),
    },
    capabilities,
  };
  return { manifest: parseComposioManifest(manifest), report };
}

export function checkComposioManifest(value: unknown, snapshot: ComposioSnapshot): string[] {
  let manifest: ComposioManifest;
  try {
    manifest = parseComposioManifest(value);
  } catch (error) {
    return [error instanceof Error ? error.message : 'manifest is invalid'];
  }
  const where = `${manifest.toolkit} manifest`;
  if (snapshot.toolkit.slug !== manifest.toolkit || snapshot.toolkit.version !== manifest.version) {
    return [`${where} pins ${manifest.version}, but its snapshot is ${snapshot.toolkit.slug} ${snapshot.toolkit.version}`];
  }
  const known = new Set(snapshot.tools.map(({ slug }) => slug));
  const problems = [
    ...manifest.review.add, ...Object.keys(manifest.review.drop), ...Object.keys(manifest.review.allowArguments),
  ]
    .filter((slug) => !known.has(slug))
    .map((slug) => `${where} review names ${slug}, which the snapshot does not contain`);
  let expected: ComposioManifest;
  try {
    expected = draftComposioManifest(snapshot, manifest).manifest;
  } catch (error) {
    return [...problems, `${where}: ${error instanceof Error ? error.message : 'draft failed'}`];
  }
  if (!isDeepStrictEqual(manifest.auth, expected.auth)) problems.push(`${where} auth differs from the snapshot`);
  if (manifest.validationCapability !== expected.validationCapability) {
    problems.push(`${where} validation capability is not a read tool without required input`);
  }
  const expectedByTool = new Map(expected.capabilities.map((capability) => [capability.tool, capability]));
  for (const capability of manifest.capabilities) {
    const derived = expectedByTool.get(capability.tool);
    if (!derived) {
      problems.push(`${where} exposes ${capability.tool}, which the rules exclude or the snapshot lacks`);
    } else if (!isDeepStrictEqual(capability, derived)) {
      const fields = (Object.keys({ ...capability, ...derived }) as Array<keyof ComposioManifestCapability>)
        .filter((key) => !isDeepStrictEqual(capability[key], derived[key]));
      problems.push(`${where} ${capability.tool} differs from its derivation in ${fields.join(', ')}`);
    }
  }
  const present = new Set(manifest.capabilities.map(({ tool }) => tool));
  for (const { tool } of expected.capabilities) {
    if (!present.has(tool)) problems.push(`${where} omits ${tool}; drop it through review.drop with a reason`);
  }
  if (problems.length === 0 && !isDeepStrictEqual(manifest, expected)) {
    problems.push(`${where} is not in generator order; rerun the draft command`);
  }
  return problems;
}

export async function checkComposioManifestDirectory(): Promise<string[]> {
  const files = (await readdir(MANIFEST_DIRECTORY)).filter((file) => file.endsWith('.json')).sort();
  const problems: string[] = [];
  const toolkits = files.map((file) => file.slice(0, -'.json'.length));
  const bundled = COMPOSIO_MANIFESTS.map(({ toolkit }) => toolkit).sort();
  const held = Object.keys(HELD_COMPOSIO_MANIFESTS).sort();
  if (!isDeepStrictEqual([...bundled, ...held].sort(), toolkits)) {
    problems.push(`composio-manifests.ts bundles [${bundled.join(', ')}] and holds [${held.join(', ')}] but the manifest directory has [${toolkits.join(', ')}]`);
  }
  for (const toolkit of toolkits) {
    const value: unknown = JSON.parse(await readFile(path.join(MANIFEST_DIRECTORY, `${toolkit}.json`), 'utf8'));
    const version = isPlainObject(value) && typeof value.version === 'string' ? value.version : '';
    if (!isPlainObject(value) || value.toolkit !== toolkit) {
      problems.push(`${toolkit}.json must declare toolkit "${toolkit}"`);
      continue;
    }
    const snapshots = await readdir(path.join(SNAPSHOT_DIRECTORY, toolkit)).catch(() => [] as string[]);
    if (!snapshots.includes(`${version}.json`)) {
      problems.push(`${toolkit} has no committed snapshot for pinned version ${version}`);
      continue;
    }
    for (const stale of snapshots.filter((file) => file !== `${version}.json`)) {
      problems.push(`${toolkit} snapshot ${stale} is not the pinned version; delete it`);
    }
    problems.push(...checkComposioManifest(value, await readSnapshot(toolkit, version)));
  }
  const snapshotToolkits = await readdir(SNAPSHOT_DIRECTORY).catch(() => [] as string[]);
  for (const orphan of snapshotToolkits.filter((toolkit) => !toolkits.includes(toolkit))) {
    problems.push(`snapshots/${orphan} has no manifest`);
  }
  return problems;
}

export async function readSnapshot(toolkit: string, version: string): Promise<ComposioSnapshot> {
  return JSON.parse(await readFile(path.join(SNAPSHOT_DIRECTORY, toolkit, `${version}.json`), 'utf8')) as ComposioSnapshot;
}

const TOOL_LIST_PAGE_LIMIT = 50;

/** Reads toolkit metadata from Composio with GET requests only. */
export async function fetchComposioToolkit(
  toolkit: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<[detail: unknown, toolList: { items: unknown[] }]> {
  const slug = encodeURIComponent(toolkit);
  const get = async (url: string): Promise<unknown> => {
    const response = await fetchImpl(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Composio metadata request failed with HTTP ${response.status}`);
    return response.json();
  };
  const detail = await get(`https://backend.composio.dev/api/v3/toolkits/${slug}`);
  const items: unknown[] = [];
  let cursor = '';
  for (let pages = 0; pages < TOOL_LIST_PAGE_LIMIT; pages += 1) {
    const page = await get(`https://backend.composio.dev/api/v3/tools?toolkit_slug=${slug}&limit=1000` +
      `&toolkit_versions=latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!isPlainObject(page) || !Array.isArray(page.items)) throw new Error('Composio tool list is not in the expected shape');
    items.push(...page.items);
    cursor = typeof page.next_cursor === 'string' ? page.next_cursor : '';
    if (!cursor) return [detail, { items }];
  }
  throw new Error(`Composio tool list did not end after ${TOOL_LIST_PAGE_LIMIT} pages; its cursor may be looping`);
}

export function snapshotFromComposio(
  detail: unknown,
  toolList: unknown,
  include: ReadonlySet<string>,
): ComposioSnapshot {
  if (!isPlainObject(detail) || !isPlainObject(toolList) || !Array.isArray(toolList.items) ||
      typeof detail.slug !== 'string' || !isPlainObject(detail.meta)) {
    throw new Error('Composio toolkit metadata is not in the expected shape');
  }
  const version = String(detail.meta.version ?? '');
  const tools = toolList.items.filter((tool): tool is Record<string, unknown> => isPlainObject(tool) &&
    Array.isArray(tool.tags) && (tool.tags.includes('important') || include.has(String(tool.slug))));
  const snapshot: ComposioSnapshot = {
    toolkit: {
      slug: detail.slug,
      name: String(detail.name ?? detail.slug),
      version,
      description: String(detail.meta.description ?? ''),
      managedAuthSchemes: Array.isArray(detail.composio_managed_auth_schemes)
        ? detail.composio_managed_auth_schemes.map(String) : [],
      authModes: (Array.isArray(detail.auth_config_details) ? detail.auth_config_details : [])
        .filter(isPlainObject)
        .map((mode) => ({
          mode: String(mode.mode),
          fields: connectedAccountFields(mode.fields),
        })),
      currentUserEndpoint: typeof detail.get_current_user_endpoint === 'string'
        ? detail.get_current_user_endpoint : null,
    },
    tools: tools.map((tool) => ({
      slug: String(tool.slug),
      name: String(tool.name ?? tool.slug),
      description: String(tool.description ?? ''),
      version: String(tool.version ?? ''),
      tags: (tool.tags as unknown[]).map(String),
      deprecated: tool.is_deprecated === true,
      input: tool.input_parameters ?? {},
    })).sort((left, right) => left.slug.localeCompare(right.slug)),
  };
  const mismatched = snapshot.tools.find((tool) => tool.version !== version);
  if (!version || mismatched) {
    throw new Error(`Composio returned ${mismatched?.slug ?? 'a tool'} at a version other than toolkit ${version || '(none)'}`);
  }
  const missing = [...include].filter((slug) => !snapshot.tools.some((tool) => tool.slug === slug));
  if (missing.length > 0) throw new Error(`Composio does not list ${missing.join(', ')}`);
  return snapshot;
}

export function renderDraftReport(report: DraftReport): string {
  const lines = [
    `# ${report.toolkit} ${report.version}`,
    '',
    `Validation capability: \`${report.validationCapability}\``,
    '',
    `## Read lane (${report.read.length})`,
    ...report.read.map((tool) => `- \`${tool}\``),
    '',
    `## Write lane (${report.write.length})`,
    ...report.write.map(({ tool, effect }) => `- \`${tool}\` (${effect})`),
    '',
    `## Excluded (${report.excluded.length})`,
    ...report.excluded.map(({ tool, reason }) => `- \`${tool}\`: ${reason}`),
    '',
    `## Write tools made destructive by an irreversible verb (${report.irreversible.length})`,
    ...report.irreversible.map(({ tool, verb }) => `- \`${tool}\`: ${verb}`),
    '',
    `## Arguments with a precondition (${report.preconditions.length})`,
    ...report.preconditions.map(({ tool, argument }) => `- \`${tool}\`: \`${argument}\``),
    '',
    `## Arguments withheld (${report.withheldArguments.reduce((sum, { arguments: names }) => sum + Object.keys(names).length, 0)})`,
    ...report.withheldArguments.flatMap(({ tool, arguments: names }) => [
      `- \`${tool}\``,
      ...Object.entries(names).map(([name, reason]) => `  - \`${name}\`: ${reason}`),
    ]),
  ];
  return `${lines.join('\n')}\n`;
}

function deriveAuth(snapshot: ComposioSnapshot): ComposioManifestAuth {
  if (snapshot.toolkit.managedAuthSchemes.length > 0) return { mode: 'managed_oauth' };
  const apiKey = snapshot.toolkit.authModes.find(({ mode }) => mode === 'API_KEY');
  if (apiKey && apiKey.fields.length > 0) return { mode: 'api_key', fields: apiKey.fields };
  throw new Error(`${snapshot.toolkit.slug} has neither Composio-managed sign-in nor an API key mode`);
}

function defaultSecurityDescription(label: string, auth: ComposioManifestAuth): string {
  const access = auth.mode === 'api_key'
    ? `${label} connects with an API key entered on Composio's hosted page; Chickpea never receives the key.`
    : `${label} sign-in opens through Composio.`;
  return `${access} Agents can reach what the connected ${label} account can reach. Delete, administrative, and billing operations are absent.`;
}

function connectedAccountFields(value: unknown): string[] {
  if (!isPlainObject(value) || !isPlainObject(value.connected_account_initiation)) return [];
  const required = value.connected_account_initiation.required;
  return Array.isArray(required)
    ? required.filter(isPlainObject).map((field) => String(field.name))
    : [];
}

function enumValues(schema: unknown): unknown[] {
  if (!isPlainObject(schema)) return [];
  return [schema, ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])]
    .flatMap((node) => isPlainObject(node) && Array.isArray(node.enum) ? node.enum : []);
}

function withDescription<T extends ManifestInputSchema>(schema: T, description: string | undefined): T {
  return description ? { ...schema, description } : schema;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text || undefined;
  const cut = text.slice(0, maximum);
  const sentence = cut.lastIndexOf('. ');
  return sentence > maximum / 2 ? cut.slice(0, sentence + 1) : cut.slice(0, cut.lastIndexOf(' ')).trimEnd();
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
