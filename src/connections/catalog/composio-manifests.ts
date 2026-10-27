import * as v from 'valibot';

import bitbucket from './manifests/bitbucket.json' with { type: 'json' };
import box from './manifests/box.json' with { type: 'json' };
import cal from './manifests/cal.json' with { type: 'json' };
import canva from './manifests/canva.json' with { type: 'json' };
import contentful from './manifests/contentful.json' with { type: 'json' };
import dropbox from './manifests/dropbox.json' with { type: 'json' };
import dynamics365 from './manifests/dynamics365.json' with { type: 'json' };
import excel from './manifests/excel.json' with { type: 'json' };
import figma from './manifests/figma.json' with { type: 'json' };
import freshdesk from './manifests/freshdesk.json' with { type: 'json' };
import github from './manifests/github.json' with { type: 'json' };
import googlebigquery from './manifests/googlebigquery.json' with { type: 'json' };
import googlemeet from './manifests/googlemeet.json' with { type: 'json' };
import googletasks from './manifests/googletasks.json' with { type: 'json' };
import gorgias from './manifests/gorgias.json' with { type: 'json' };
import klaviyo from './manifests/klaviyo.json' with { type: 'json' };
import mailchimp from './manifests/mailchimp.json' with { type: 'json' };
import microsoftTeams from './manifests/microsoft_teams.json' with { type: 'json' };
import oneDrive from './manifests/one_drive.json' with { type: 'json' };
import outlook from './manifests/outlook.json' with { type: 'json' };
import pagerduty from './manifests/pagerduty.json' with { type: 'json' };
import pipedrive from './manifests/pipedrive.json' with { type: 'json' };
import quickbooks from './manifests/quickbooks.json' with { type: 'json' };
import salesforce from './manifests/salesforce.json' with { type: 'json' };
import semrush from './manifests/semrush.json' with { type: 'json' };
import sharePoint from './manifests/share_point.json' with { type: 'json' };
import square from './manifests/square.json' with { type: 'json' };
import trello from './manifests/trello.json' with { type: 'json' };
import webex from './manifests/webex.json' with { type: 'json' };
import wrike from './manifests/wrike.json' with { type: 'json' };
import zoho from './manifests/zoho.json' with { type: 'json' };
import zoom from './manifests/zoom.json' with { type: 'json' };
import type {
  ManagedAccessLane,
  ManagedConnectorDefinition,
  ManagedEffectClass,
} from './types.ts';

export const COMPOSIO_MANIFEST_LIMITS = Object.freeze({
  stringLength: 20_000,
  arrayItems: 100,
  depth: 4,
  properties: 100,
  enumValues: 200,
  enumValueLength: 200,
  descriptionLength: 500,
  inputBytes: 100_000,
  resultBytes: 64 * 1024,
});

export type ManifestInputSchema =
  | { type: 'string'; maxLength: number; minLength?: number; enum?: string[]; description?: string }
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | {
      type: 'array';
      items: ManifestInputSchema;
      maxItems: number;
      minItems?: number;
      description?: string;
    }
  | ManifestObjectSchema
  | { anyOf: ManifestInputSchema[]; description?: string };

export interface ManifestObjectSchema {
  type: 'object';
  properties: Record<string, ManifestInputSchema>;
  required?: string[];
  description?: string;
}

export type ComposioManifestAuth =
  | { mode: 'managed_oauth' }
  | { mode: 'api_key'; fields: string[] };

/** A read capability call whose result value at `path` is compared. `$name` copies a call argument. */
export interface ManifestLookup {
  capability: string;
  arguments: Record<string, string>;
  path: string;
}

/**
 * Before a write that sets `argument` dispatches, both lookups must return the
 * same non-empty string, for example the card's board and the target list's board.
 */
export interface ManifestPrecondition {
  argument: string;
  current: ManifestLookup;
  target: ManifestLookup;
}

export interface ComposioManifestCapability {
  id: string;
  tool: string;
  toolName: string;
  lane: ManagedAccessLane;
  effect: ManagedEffectClass;
  description: string;
  sideEffectLabel?: string;
  maxResultBytes: number;
  /** Provider arguments the generator kept from the model, with the reason. */
  withheldArguments?: Record<string, string>;
  preconditions?: ManifestPrecondition[];
  input: ManifestObjectSchema;
}

export interface ComposioManifest {
  toolkit: string;
  version: string;
  auth: ComposioManifestAuth;
  label: string;
  description: string;
  securityDescription: string;
  preset: {
    category: 'project' | 'dev' | 'data' | 'search' | 'docs' | 'business';
    accent: string;
    /** Other names a person might call the connector, such as "BigQuery" for Google BigQuery. */
    aliases?: string[] | undefined;
  };
  validationCapability: string;
  /**
   * Fixed arguments for the validation call, such as Zoom's `user_id: "me"`,
   * checked against its input schema. The model never supplies them.
   */
  validationArguments?: Record<string, string | number | boolean> | undefined;
  review: {
    add: string[];
    drop: Record<string, string>;
    allowArguments: Record<string, string[]>;
    /** Arguments no rule withholds that the reviewer keeps from the model, with the reason. */
    withholdArguments?: Record<string, Record<string, string>> | undefined;
  };
  capabilities: ComposioManifestCapability[];
}

const Text = (maximum: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(maximum));
const ToolSlug = v.pipe(v.string(), v.regex(/^[A-Z0-9][A-Z0-9_]{0,127}$/));
const Lookup = v.strictObject({
  capability: Text(192),
  arguments: v.record(Text(128), Text(200)),
  path: v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/)),
});

const ManifestShape = v.strictObject({
  toolkit: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_]{0,63}$/)),
  version: v.pipe(v.string(), v.regex(/^\d{8}_\d{2}$/)),
  auth: v.variant('mode', [
    v.strictObject({ mode: v.literal('managed_oauth') }),
    v.strictObject({
      mode: v.literal('api_key'),
      fields: v.pipe(v.array(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/))), v.minLength(1), v.maxLength(8)),
    }),
  ]),
  label: Text(80),
  description: Text(240),
  securityDescription: Text(1_000),
  preset: v.strictObject({
    category: v.picklist(['project', 'dev', 'data', 'search', 'docs', 'business']),
    accent: v.pipe(v.string(), v.regex(/^#[0-9A-F]{6}$/)),
    aliases: v.optional(v.pipe(v.array(Text(80)), v.minLength(1), v.maxLength(4))),
  }),
  validationCapability: Text(192),
  validationArguments: v.optional(v.pipe(
    v.record(Text(128), v.union([Text(200), v.pipe(v.number(), v.finite()), v.boolean()])),
    v.minEntries(1),
    v.maxEntries(8),
  )),
  review: v.strictObject({
    add: v.array(ToolSlug),
    drop: v.record(ToolSlug, Text(240)),
    allowArguments: v.record(ToolSlug, v.pipe(v.array(Text(200)), v.minLength(1))),
    withholdArguments: v.optional(v.record(ToolSlug, v.record(Text(200), Text(240)))),
  }),
  capabilities: v.pipe(v.array(v.strictObject({
    id: Text(192),
    tool: ToolSlug,
    toolName: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_]{0,63}$/)),
    lane: v.picklist(['read', 'write']),
    effect: v.picklist([
      'read', 'reversible_write', 'external_publish', 'spend_or_budget', 'destructive', 'administrative',
    ]),
    description: Text(1_000),
    sideEffectLabel: v.optional(Text(240)),
    maxResultBytes: v.pipe(
      v.number(), v.integer(), v.minValue(1_024), v.maxValue(COMPOSIO_MANIFEST_LIMITS.resultBytes),
    ),
    withheldArguments: v.optional(v.record(Text(200), Text(200))),
    preconditions: v.optional(v.pipe(v.array(v.strictObject({
      argument: Text(128),
      current: Lookup,
      target: Lookup,
    })), v.minLength(1), v.maxLength(4))),
    input: v.unknown(),
  })), v.minLength(1), v.maxLength(64)),
});

export function parseComposioManifest(value: unknown): ComposioManifest {
  const parsed = v.safeParse(ManifestShape, value);
  if (!parsed.success) {
    const path = parsed.issues[0]?.path?.map(({ key }) => String(key)).join('.') ?? 'manifest';
    throw new Error(`Composio manifest is invalid at ${path}`);
  }
  const manifest = parsed.output;
  const prefix = `${manifest.toolkit}.`;
  const capabilities = manifest.capabilities.map((capability): ComposioManifestCapability => {
    const where = `Composio manifest ${manifest.toolkit} capability ${capability.id}`;
    if (!capability.id.startsWith(prefix) || !capability.toolName.startsWith(`${manifest.toolkit}_`)) {
      throw new Error(`${where} is not namespaced by its toolkit`);
    }
    if ((capability.lane === 'read') !== (capability.effect === 'read') ||
        (capability.lane === 'write') !== (capability.sideEffectLabel !== undefined)) {
      throw new Error(`${where} has an inconsistent lane, effect, or side-effect label`);
    }
    const input = parseInputSchema(capability.input, 0, where);
    if (!('type' in input) || input.type !== 'object') throw new Error(`${where} input must be an object`);
    const { input: _input, sideEffectLabel, withheldArguments, preconditions, ...rest } = capability;
    return {
      ...rest,
      ...(sideEffectLabel ? { sideEffectLabel } : {}),
      ...(withheldArguments ? { withheldArguments } : {}),
      ...(preconditions ? { preconditions } : {}),
      input,
    };
  });
  const readCapabilities = new Set(capabilities.filter(({ lane }) => lane === 'read').map(({ id }) => id));
  for (const { id, input, preconditions = [] } of capabilities) {
    for (const { argument, current, target } of preconditions) {
      const references = [current, target].flatMap((lookup) => Object.values(lookup.arguments))
        .filter((value) => value.startsWith('$')).map((value) => value.slice(1));
      if (!(argument in input.properties) || references.some((name) => !(name in input.properties)) ||
          !readCapabilities.has(current.capability) || !readCapabilities.has(target.capability)) {
        throw new Error(`Composio manifest ${manifest.toolkit} capability ${id} has an invalid precondition`);
      }
    }
  }
  const validation = capabilities.find(({ id }) => id === manifest.validationCapability);
  if (!validation || validation.lane !== 'read' ||
      !v.is(compileInputSchema(validation.input), manifest.validationArguments ?? {})) {
    throw new Error(`Composio manifest ${manifest.toolkit} needs a read validation capability whose input accepts its validationArguments`);
  }
  return { ...manifest, capabilities };
}

export function compileComposioManifest(manifest: ComposioManifest): ManagedConnectorDefinition {
  return {
    id: `${manifest.toolkit.replaceAll('_', '-')}-managed`,
    toolkit: manifest.toolkit,
    providerId: manifest.toolkit,
    label: manifest.label,
    description: manifest.description,
    securityDescription: manifest.securityDescription,
    capabilities: manifest.capabilities.map((capability) => {
      let input: v.GenericSchema<Record<string, unknown>> | undefined;
      return {
        id: capability.id,
        connectorToolkit: manifest.toolkit,
        accessLane: capability.lane,
        effect: capability.effect,
        toolName: capability.toolName,
        description: capability.description,
        get input() {
          return input ??= v.pipe(
            compileInputSchema(capability.input) as v.GenericSchema<Record<string, unknown>>,
            v.check(
              (value) => JSON.stringify(value).length <= COMPOSIO_MANIFEST_LIMITS.inputBytes,
              'Tool input is too large',
            ),
          );
        },
        maxResultBytes: capability.maxResultBytes,
        ...(capability.sideEffectLabel ? { sideEffectLabel: capability.sideEffectLabel } : {}),
      };
    }),
  };
}

export const COMPOSIO_MANIFESTS: readonly ComposioManifest[] = [
  bitbucket,
  box,
  cal,
  canva,
  contentful,
  dropbox,
  dynamics365,
  excel,
  figma,
  freshdesk,
  github,
  googlebigquery,
  googlemeet,
  googletasks,
  gorgias,
  klaviyo,
  mailchimp,
  microsoftTeams,
  oneDrive,
  outlook,
  pagerduty,
  pipedrive,
  quickbooks,
  salesforce,
  semrush,
  sharePoint,
  square,
  trello,
  webex,
  wrike,
  zoho,
  zoom,
].map((value) => parseComposioManifest(value));

/** Reviewed manifests the generator still checks but the catalog does not ship, with the reason. */
export const HELD_COMPOSIO_MANIFESTS: Readonly<Record<string, string>> = {
  google_maps: "Every Google Maps read needs input, so validation needs validationArguments nobody has chosen and checked: geocoding needs an address, coordinates, or a place ID, and Composio's own current-user check uses a fixed place ID",
  linkedin: "Its only write, posting, publishes by default: lifecycleState defaults to PUBLISHED and visibility is required, so no withheld argument can hold a post as a draft, and every connector ships read and write tools",
};

function parseInputSchema(value: unknown, depth: number, where: string): ManifestInputSchema {
  const fail = (): never => {
    throw new Error(`${where} input exceeds the manifest schema subset`);
  };
  if (depth > COMPOSIO_MANIFEST_LIMITS.depth || !isPlainObject(value)) return fail();
  const { description, ...node } = value;
  if (description !== undefined && (typeof description !== 'string' || !description ||
      description.length > COMPOSIO_MANIFEST_LIMITS.descriptionLength)) return fail();
  const described = <T extends object>(schema: T): T =>
    description === undefined ? schema : { ...schema, description: description as string };
  if ('anyOf' in node) {
    if (Object.keys(node).length !== 1 || !Array.isArray(node.anyOf) || node.anyOf.length < 2) return fail();
    const branches = node.anyOf.map((branch) => parseInputSchema(branch, depth, where));
    if (branches.some((branch) => !('type' in branch) || !isPrimitiveType(branch.type))) return fail();
    return described({ anyOf: branches });
  }
  const keys = Object.keys(node);
  const only = (allowed: readonly string[]) => keys.every((key) => allowed.includes(key));
  const bound = (key: string, maximum: number, minimum = 0): number | undefined => {
    const raw = node[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minimum || raw > maximum) fail();
    return raw as number;
  };
  switch (node.type) {
    case 'string': {
      if (!only(['type', 'maxLength', 'minLength', 'enum'])) return fail();
      const maxLength = bound('maxLength', COMPOSIO_MANIFEST_LIMITS.stringLength, 1) ?? fail();
      const minLength = bound('minLength', maxLength);
      const values = node.enum;
      if (values !== undefined && (!Array.isArray(values) || values.length === 0 ||
          values.length > COMPOSIO_MANIFEST_LIMITS.enumValues ||
          values.some((entry) => typeof entry !== 'string' ||
            entry.length > COMPOSIO_MANIFEST_LIMITS.enumValueLength))) return fail();
      return described({
        type: 'string', maxLength,
        ...(minLength === undefined ? {} : { minLength }),
        ...(values === undefined ? {} : { enum: values as string[] }),
      });
    }
    case 'integer':
    case 'number': {
      if (!only(['type', 'minimum', 'maximum'])) return fail();
      const { minimum, maximum } = node;
      if ([minimum, maximum].some((entry) => entry !== undefined &&
          (typeof entry !== 'number' || !Number.isFinite(entry)))) return fail();
      return described({
        type: node.type,
        ...(minimum === undefined ? {} : { minimum: minimum as number }),
        ...(maximum === undefined ? {} : { maximum: maximum as number }),
      });
    }
    case 'boolean':
      return only(['type']) ? described({ type: 'boolean' }) : fail();
    case 'array': {
      if (!only(['type', 'items', 'maxItems', 'minItems'])) return fail();
      const maxItems = bound('maxItems', COMPOSIO_MANIFEST_LIMITS.arrayItems, 1) ?? fail();
      const minItems = bound('minItems', maxItems);
      return described({
        type: 'array',
        items: parseInputSchema(node.items, depth + 1, where),
        maxItems,
        ...(minItems === undefined ? {} : { minItems }),
      });
    }
    case 'object': {
      if (!only(['type', 'properties', 'required']) || !isPlainObject(node.properties)) return fail();
      const entries = Object.entries(node.properties);
      if (entries.length > COMPOSIO_MANIFEST_LIMITS.properties) return fail();
      const properties = Object.fromEntries(entries.map(([key, child]) => [
        /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) ? key : fail(),
        parseInputSchema(child, depth + 1, where),
      ]));
      const required = node.required;
      if (required !== undefined && (!Array.isArray(required) ||
          required.some((key) => typeof key !== 'string' || !(key in properties)) ||
          new Set(required).size !== required.length)) return fail();
      return described({
        type: 'object',
        properties,
        ...(required === undefined || required.length === 0 ? {} : { required: required as string[] }),
      });
    }
    default:
      return fail();
  }
}

function compileInputSchema(node: ManifestInputSchema): v.GenericSchema {
  const schema = compileInputNode(node);
  return node.description ? v.pipe(schema, v.description(node.description)) : schema;
}

function compileInputNode(node: ManifestInputSchema): v.GenericSchema {
  if ('anyOf' in node) return v.union(node.anyOf.map(compileInputSchema));
  switch (node.type) {
    case 'string': {
      const text = v.pipe(node.enum ? v.picklist(node.enum) : v.string(), v.maxLength(node.maxLength));
      return node.minLength ? v.pipe(text, v.minLength(node.minLength)) : text;
    }
    case 'integer':
    case 'number': {
      const base = node.type === 'integer' ? v.pipe(v.number(), v.integer()) : v.pipe(v.number(), v.finite());
      const floor = node.minimum === undefined ? base : v.pipe(base, v.minValue(node.minimum));
      return node.maximum === undefined ? floor : v.pipe(floor, v.maxValue(node.maximum));
    }
    case 'boolean':
      return v.boolean();
    case 'array': {
      const list = v.pipe(v.array(compileInputSchema(node.items)), v.maxLength(node.maxItems));
      return node.minItems ? v.pipe(list, v.minLength(node.minItems)) : list;
    }
    case 'object': {
      const required = new Set(node.required ?? []);
      return v.strictObject(Object.fromEntries(Object.entries(node.properties).map(([key, child]) => {
        const compiled = compileInputSchema(child);
        return [key, required.has(key) ? compiled : v.optional(compiled)];
      })));
    }
  }
}

function isPrimitiveType(type: string): boolean {
  return type === 'string' || type === 'integer' || type === 'number' || type === 'boolean';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
