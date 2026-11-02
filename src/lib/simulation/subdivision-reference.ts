import {z} from 'zod';
import {simulationIdSchema} from './simulation-contract-primitives';

export const subdivisionReferenceSchema = z.strictObject({
  catalogId: simulationIdSchema,
  sourceVersion: z.string().trim().min(1).max(128),
  subdivisionId: z.string().trim().min(1).max(128),
});
