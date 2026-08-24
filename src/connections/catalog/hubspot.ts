import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const Id = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/));
const Cursor = v.pipe(v.string(), v.regex(/^\d{1,4}$/));
const ShortText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));
const Content = v.pipe(v.string(), v.minLength(1), v.maxLength(65_536));
const Timestamp = v.pipe(v.string(), v.trim(), v.isoTimestamp());

export const HUBSPOT_OBJECT_TYPES = [
  'contacts', 'companies', 'deals', 'tickets', 'notes', 'tasks', 'meetings', 'calls',
] as const;

export const HUBSPOT_OBJECT_PROPERTIES: Readonly<Record<
  typeof HUBSPOT_OBJECT_TYPES[number],
  readonly string[]
>> = {
  contacts: [
    'firstname', 'lastname', 'email', 'phone', 'mobilephone', 'jobtitle', 'company',
    'website', 'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id',
  ],
  companies: [
    'name', 'domain', 'phone', 'city', 'state', 'country', 'industry',
    'numberofemployees', 'annualrevenue', 'lifecyclestage', 'hubspot_owner_id',
  ],
  deals: [
    'dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'dealtype',
    'description', 'hubspot_owner_id',
  ],
  tickets: [
    'subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority',
    'hubspot_owner_id',
  ],
  notes: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'],
  tasks: [
    'hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority',
    'hs_timestamp', 'hs_task_type', 'hubspot_owner_id',
  ],
  meetings: [
    'hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time',
    'hs_meeting_outcome', 'hs_timestamp', 'hubspot_owner_id',
  ],
  calls: [
    'hs_call_title', 'hs_call_body', 'hs_call_status', 'hs_call_duration',
    'hs_timestamp', 'hubspot_owner_id',
  ],
};

const ObjectType = v.picklist(HUBSPOT_OBJECT_TYPES);
const PropertyName = v.picklist([...new Set(Object.values(HUBSPOT_OBJECT_PROPERTIES).flat())]);
const AssociationObjectType = v.picklist(['contacts', 'companies', 'deals', 'tickets']);
const Filter = v.strictObject({
  property: PropertyName,
  operator: v.picklist([
    'EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN',
    'NOT_CONTAINS_TOKEN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY',
  ]),
  value: v.optional(ShortText),
});
const SearchSchema = v.pipe(
  v.strictObject({
    objectType: ObjectType,
    query: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2_000))),
    filters: v.optional(v.pipe(v.array(Filter), v.maxLength(6))),
    properties: v.optional(v.pipe(v.array(PropertyName), v.maxLength(20))),
    sort: v.optional(v.strictObject({
      property: PropertyName,
      direction: v.picklist(['ascending', 'descending']),
    })),
    after: v.optional(Cursor),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  }),
  v.check((input) => fieldsAreAllowed(input.objectType, input.properties) &&
    fieldsAreAllowed(input.objectType, input.filters?.map(({ property }) => property)) &&
    fieldsAreAllowed(input.objectType, input.sort ? [input.sort.property] : undefined),
  'HubSpot properties must be allowlisted for the object type'),
  v.check(({ filters }) => filters?.every(({ operator, value }) =>
    ['HAS_PROPERTY', 'NOT_HAS_PROPERTY'].includes(operator) ? value === undefined : value !== undefined,
  ) ?? true, 'HubSpot filter value does not match its operator'),
);
const GetObjectSchema = v.pipe(
  v.strictObject({
    objectType: ObjectType,
    objectId: Id,
    properties: v.optional(v.pipe(v.array(PropertyName), v.maxLength(20))),
    associations: v.optional(v.pipe(v.array(AssociationObjectType), v.maxLength(4))),
  }),
  v.check(({ objectType, properties }) => fieldsAreAllowed(objectType, properties),
    'HubSpot properties must be allowlisted for the object type'),
);
const OwnerListSchema = v.strictObject({
  email: v.optional(v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320))),
  after: v.optional(Id),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
});
const PipelineListSchema = v.strictObject({ objectType: v.picklist(['deals', 'tickets']) });
const AssociationListSchema = v.strictObject({
  objectType: AssociationObjectType,
  objectId: Id,
  toObjectType: AssociationObjectType,
  after: v.optional(Id),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
});
const AssociationTypesSchema = v.strictObject({
  fromObjectType: AssociationObjectType,
  toObjectType: AssociationObjectType,
});

const ContactFields = {
  email: v.optional(v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320))),
  firstName: v.optional(ShortText),
  lastName: v.optional(ShortText),
  phone: v.optional(ShortText),
  mobilePhone: v.optional(ShortText),
  jobTitle: v.optional(ShortText),
  companyName: v.optional(ShortText),
  website: v.optional(v.pipe(v.string(), v.trim(), v.url(), v.maxLength(2_000))),
  lifecycleStage: v.optional(ShortText),
  leadStatus: v.optional(ShortText),
  ownerId: v.optional(Id),
};
const ContactCreateSchema = v.pipe(v.strictObject(ContactFields), v.check(
  (input) => Boolean(input.email || input.firstName || input.lastName),
  'A contact requires an email or name',
));
const ContactUpdateSchema = updateSchema(ContactFields);

const CompanyFields = {
  name: v.optional(ShortText),
  domain: v.optional(ShortText),
  phone: v.optional(ShortText),
  city: v.optional(ShortText),
  state: v.optional(ShortText),
  country: v.optional(ShortText),
  industry: v.optional(ShortText),
  employeeCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000_000))),
  annualRevenue: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000_000_000))),
  lifecycleStage: v.optional(ShortText),
  ownerId: v.optional(Id),
};
const CompanyCreateSchema = v.pipe(v.strictObject(CompanyFields), v.check(
  (input) => Boolean(input.name || input.domain), 'A company requires a name or domain',
));
const CompanyUpdateSchema = updateSchema(CompanyFields);

const DealFields = {
  name: v.optional(ShortText),
  amount: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000_000_000))),
  stageId: v.optional(Id),
  pipelineId: v.optional(Id),
  closeDate: v.optional(Timestamp),
  dealType: v.optional(ShortText),
  description: v.optional(Content),
  ownerId: v.optional(Id),
};
const DealCreateSchema = v.strictObject({
  ...DealFields,
  name: ShortText,
  stageId: Id,
  pipelineId: Id,
});
const DealUpdateSchema = updateSchema(DealFields);

const TicketFields = {
  subject: v.optional(ShortText),
  content: v.optional(Content),
  pipelineId: v.optional(Id),
  stageId: v.optional(Id),
  priority: v.optional(v.picklist(['LOW', 'MEDIUM', 'HIGH'])),
  ownerId: v.optional(Id),
};
const TicketCreateSchema = v.strictObject({
  ...TicketFields,
  subject: ShortText,
  pipelineId: Id,
  stageId: Id,
});
const TicketUpdateSchema = updateSchema(TicketFields);

const NoteCreateSchema = v.strictObject({
  body: Content,
  timestamp: Timestamp,
  ownerId: v.optional(Id),
});
const TaskCreateSchema = v.strictObject({
  subject: ShortText,
  body: v.optional(Content),
  dueAt: Timestamp,
  type: v.optional(v.picklist(['CALL', 'EMAIL', 'TODO'])),
  status: v.optional(v.picklist(['NOT_STARTED', 'COMPLETED'])),
  priority: v.optional(v.picklist(['LOW', 'MEDIUM', 'HIGH', 'NONE'])),
  ownerId: v.optional(Id),
});
const MeetingCreateSchema = v.strictObject({
  title: ShortText,
  body: v.optional(Content),
  startsAt: Timestamp,
  endsAt: v.optional(Timestamp),
  outcome: v.optional(v.picklist(['SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELED'])),
  location: v.optional(ShortText),
  ownerId: v.optional(Id),
});
const AssociationCreateSchema = v.pipe(v.strictObject({
  objectType: AssociationObjectType,
  objectId: Id,
  toObjectType: AssociationObjectType,
  toObjectId: Id,
  associationCategory: v.picklist(['HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED']),
  associationTypeId: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_647)),
}), v.check((input) => input.objectType !== input.toObjectType || input.objectId !== input.toObjectId,
  'A HubSpot record cannot be associated with itself'));

export const MANAGED_HUBSPOT_CONNECTORS: readonly ManagedConnectorDefinition[] = [{
  id: 'hubspot-managed',
  toolkit: 'hubspot',
  providerId: 'hubspot',
  label: 'HubSpot',
  description: 'Research CRM records and make explicitly confirmed updates in one connected portal.',
  securityDescription:
    'HubSpot sign-in opens through Composio. Chickpea pins one exact connected portal and exposes only typed CRM reads and confirmed record writes. Privacy, delete, import, schema, workflow, marketing publication, batch, and trigger operations are absent. HubSpot may show an unverified-app warning for Composio managed OAuth.',
  capabilities: [
    capability('hubspot.account.get', 'read', 'read', 'hubspot_get_account', 'Verify the connected HubSpot portal identity.', v.strictObject({})),
    capability('hubspot.objects.search', 'read', 'read', 'hubspot_search_objects', 'Search bounded contacts, companies, deals, tickets, and activities.', SearchSchema),
    capability('hubspot.objects.get', 'read', 'read', 'hubspot_get_object', 'Read one CRM record with allowlisted properties.', GetObjectSchema),
    capability('hubspot.owners.list', 'read', 'read', 'hubspot_list_owners', 'List a bounded page of CRM owners.', OwnerListSchema),
    capability('hubspot.pipelines.list', 'read', 'read', 'hubspot_list_pipelines', 'List deal or ticket pipelines and stages.', PipelineListSchema),
    capability('hubspot.associations.list', 'read', 'read', 'hubspot_list_associations', 'List bounded associations for one CRM record.', AssociationListSchema),
    capability('hubspot.association_types.list', 'read', 'read', 'hubspot_list_association_types', 'List valid association labels for two CRM object types.', AssociationTypesSchema),
    capability('hubspot.contacts.create', 'write', 'reversible_write', 'hubspot_create_contact', 'Create one contact from typed, allowlisted fields.', ContactCreateSchema, 'create HubSpot contact'),
    capability('hubspot.contacts.update', 'write', 'reversible_write', 'hubspot_update_contact', 'Update allowlisted fields on one contact.', ContactUpdateSchema, 'update HubSpot contact'),
    capability('hubspot.companies.create', 'write', 'reversible_write', 'hubspot_create_company', 'Create one company from typed, allowlisted fields.', CompanyCreateSchema, 'create HubSpot company'),
    capability('hubspot.companies.update', 'write', 'reversible_write', 'hubspot_update_company', 'Update allowlisted fields on one company.', CompanyUpdateSchema, 'update HubSpot company'),
    capability('hubspot.deals.create', 'write', 'reversible_write', 'hubspot_create_deal', 'Create one deal in an existing pipeline and stage.', DealCreateSchema, 'create HubSpot deal'),
    capability('hubspot.deals.update', 'write', 'reversible_write', 'hubspot_update_deal', 'Update allowlisted fields on one deal.', DealUpdateSchema, 'update HubSpot deal'),
    capability('hubspot.tickets.create', 'write', 'reversible_write', 'hubspot_create_ticket', 'Create one ticket in an existing pipeline and stage.', TicketCreateSchema, 'create HubSpot ticket'),
    capability('hubspot.tickets.update', 'write', 'reversible_write', 'hubspot_update_ticket', 'Update allowlisted fields on one ticket.', TicketUpdateSchema, 'update HubSpot ticket'),
    capability('hubspot.notes.create', 'write', 'reversible_write', 'hubspot_create_note', 'Create one bounded CRM note.', NoteCreateSchema, 'create HubSpot note'),
    capability('hubspot.tasks.create', 'write', 'reversible_write', 'hubspot_create_task', 'Create one bounded CRM task.', TaskCreateSchema, 'create HubSpot task'),
    capability('hubspot.meetings.create', 'write', 'reversible_write', 'hubspot_create_meeting', 'Create one bounded CRM meeting record.', MeetingCreateSchema, 'create HubSpot meeting'),
    capability('hubspot.associations.create', 'write', 'reversible_write', 'hubspot_create_association', 'Create one typed association between existing CRM records.', AssociationCreateSchema, 'associate HubSpot records'),
  ],
}] as const;

function updateSchema<TEntries extends v.ObjectEntries>(fields: TEntries) {
  return v.pipe(v.strictObject({ objectId: Id, ...fields }), v.check(
    (input) => Object.keys(input).some((key) => key !== 'objectId'),
    'At least one HubSpot field must be updated',
  ));
}

function fieldsAreAllowed(
  objectType: typeof HUBSPOT_OBJECT_TYPES[number],
  fields: readonly string[] | undefined,
): boolean {
  const allowed = new Set(HUBSPOT_OBJECT_PROPERTIES[objectType]);
  return fields?.every((field) => allowed.has(field)) ?? true;
}

function capability(
  id: string,
  accessLane: 'read' | 'write',
  effect: 'read' | 'reversible_write',
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
  sideEffectLabel?: string,
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id,
    connectorToolkit: 'hubspot',
    accessLane,
    effect,
    toolName,
    description,
    input,
    maxResultBytes: DEFAULT_RESULT_LIMIT,
    ...(sideEffectLabel ? { sideEffectLabel } : {}),
  };
}
