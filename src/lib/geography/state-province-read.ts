import {z} from 'zod';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import {canonicalStringify} from '../world/canonical-serializer';
import {geographyCountryIdSchema, geographyMetadataRefSchema, geographyCatalogRefSchema} from './state-province-contract';
import {geographyPageRequestSchema, geographyReferenceSchema, type GeographySnapshot} from './state-province-io';
import {geographyFailure} from './state-province-validation';
import {COUNTRY_ID_PATTERN} from '../world/country-id';

export const geographyContextSchema = z.strictObject({catalogRef: geographyCatalogRefSchema, metadataRef: geographyMetadataRefSchema});
export type GeographyContext = z.infer<typeof geographyContextSchema>;
/** Every nullable field is required at the model boundary. No action/authority arguments. */
export const geographyReadRequestSchema = z.strictObject({
  operation: z.enum(['search', 'list', 'inspect', 'members']),
  sourceCountryId: geographyCountryIdSchema.nullable(),
  kind: z.enum(['state', 'province', 'source-region']).nullable(),
  query: z.string().trim().min(1).max(120).nullable(), reference: geographyReferenceSchema.nullable(),
  page: geographyPageRequestSchema,
}).superRefine((request, context) => {
  const named = request.operation === 'search', referenced = request.operation === 'inspect' || request.operation === 'members';
  if ((request.query !== null) !== named || (request.reference !== null) !== referenced || referenced && request.kind !== null) {
    context.addIssue({code: 'custom', message: 'search needs query; inspect/members need reference and null kind; unused query/reference must be null'});
  }
});
export type GeographyReadRequest = z.infer<typeof geographyReadRequestSchema>;

export function geographyReadFunctionParameters() {
  const object = (properties: Record<string, unknown>) => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
  const nullable = (schema: unknown) => ({anyOf: [schema, {type: 'null'}]});
  const hash = {type: 'string', pattern: '^[a-f0-9]{64}$'};
  const catalogRef = object({catalogVersion: {type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'}, geometryRoot: hash, topologyRoot: hash,
    renderArtifactRoot: hash, manifestPath: {type: 'string', minLength: 1, maxLength: 512, pattern: '^/data/[A-Za-z0-9._/-]+\\.json$'}});
  const metadataRef = object({schemaVersion: {type: 'string', enum: ['geography-metadata-ref-v1']}, contentRoot: hash});
  const target = {anyOf: [
    object({kind: {type: 'string', enum: ['state']}, id: {type: 'string', minLength: 1, maxLength: 512}}),
    object({kind: {type: 'string', enum: ['province']}, id: {type: 'string', pattern: '^territory:catalog:[a-f0-9]{64}$'}}),
    object({kind: {type: 'string', enum: ['source-region']}, id: {type: 'string', pattern: '^source-region:[a-f0-9]{64}$'}}),
  ]};
  return object({operation: {type: 'string', enum: ['search', 'list', 'inspect', 'members']},
    sourceCountryId: nullable({type: 'string', pattern: COUNTRY_ID_PATTERN.source}),
    kind: nullable({type: 'string', enum: ['state', 'province', 'source-region']}),
    query: nullable({type: 'string', minLength: 1, maxLength: 120}), reference: nullable(object({catalogRef, metadataRef, target})),
    page: object({offset: {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER}, limit: {type: 'integer', minimum: 1, maximum: 128}}),
  });
}

export function assertGeographyContextSnapshot(context: GeographyContext | undefined, snapshot: GeographySnapshot | undefined) {
  if (!context && !snapshot) return;
  if (!context || !snapshot) throw Error('GEOGRAPHY_SNAPSHOT_REQUIRED');
  assertWorldGeometryCatalogRefMatches(context.catalogRef, snapshot.catalogRef);
  if (canonicalStringify(context.metadataRef) !== canonicalStringify(snapshot.metadataRef)) throw Error('STALE_GEOGRAPHY_METADATA');
}

/** Shared by HTTP and AI tools; compact summaries never drop provenance/coverage fields. */
export function executeGeographyRead(snapshot: GeographySnapshot, raw: unknown) {
  const parsed = geographyReadRequestSchema.safeParse(raw);
  if (!parsed.success) return geographyFailure('GEOGRAPHY_SCHEMA', 'geographyRead', parsed.error.issues[0].message);
  const request = parsed.data;
  if (request.operation === 'search') return snapshot.search({sourceCountryId: request.sourceCountryId, kind: request.kind, query: request.query!, page: request.page});
  if (request.operation === 'list') return snapshot.list({sourceCountryId: request.sourceCountryId, kind: request.kind, page: request.page});
  const reference = request.reference!;
  const summary = snapshot.inspect(reference);
  if (!summary.ok) return summary;
  if (request.sourceCountryId !== null && summary.value.sourceCountryId !== request.sourceCountryId) return geographyFailure('GEOGRAPHY_CATALOG', 'sourceCountryId', 'Reference belongs to another original source country');
  if (request.operation === 'inspect') return summary;
  const members = snapshot.members(reference, request.page);
  return members.ok ? {ok: true as const, value: {...members.value, summary: summary.value}} : members;
}
