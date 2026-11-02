import {z} from 'zod';
import {operationalFrontierPolicy as policy} from './operational-frontier-policy';
import {createWorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import type {OperationalSelection, OperationalWorldView} from '../world/operational-catalog';
import {countryIdSchema} from './simulation-contract-primitives';
import {subdivisionReferenceSchema} from './subdivision-reference';

// Shared by lookup, submit, and the host planner; no server assets in this contract.
export const operationalFrontierRequestSchema = z.strictObject({
  catalogRef: z.strictObject({
    catalogVersion: z.string().min(1).max(160),
    geometryRoot: z.string().regex(/^[a-f0-9]{64}$/),
    topologyRoot: z.string().regex(/^[a-f0-9]{64}$/),
    renderArtifactRoot: z.string().regex(/^[a-f0-9]{64}$/),
    manifestPath: z.string().min(1).max(512),
  }).transform(createWorldGeometryCatalogRef),
  baseWorldRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  actorCountryId: countryIdSchema,
  targetCountryId: countryIdSchema,
  operation: z.enum(['occupy', 'liberate', 'transfer']),
  extent: z.enum(['near', 'limited', 'deeper']),
  direction: z.enum(['north', 'south', 'east', 'west']).nullish(),
  reference: subdivisionReferenceSchema.nullish(),
  regionQuery: z.string().trim().min(1).max(120).nullish(),
  cap: z.number().int().min(1).max(policy.lookupCap).default(policy.lookupCap),
}).refine(r => !(r.reference && r.regionQuery), 'Use a region reference or a name, not both');

export type OperationalFrontierRequest = z.output<typeof operationalFrontierRequestSchema>;
export type OperationalFrontierResolver = (world: OperationalWorldView, scope: OperationalFrontierRequest) => OperationalSelection;
