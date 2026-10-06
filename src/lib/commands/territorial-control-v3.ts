import {z} from 'zod';
import {createMapCommandV2Schema} from './map-command-v2';
import {authorityTerritoryIdSchema,territorialControlAuthorityIdSchema,MAX_AUTHORITY_TERRITORIES} from '../simulation/simulation-state-v2';
import {countryIdSchema,nullableCountryIdSchema} from '../simulation/simulation-contract-primitives';
const base={actorCountryId:countryIdSchema,targetCountryId:nullableCountryIdSchema,authorityId:territorialControlAuthorityIdSchema,
  expectedSimulationRevision:z.number().int().nonnegative().safe(),
  territoryIds:z.array(authorityTerritoryIdSchema).min(1).max(MAX_AUTHORITY_TERRITORIES).refine(ids=>ids.every((id,i)=>i===0||ids[i-1]<id),'Expected canonical unique territory IDs')};
export const territoryOccupyCommandSchema=createMapCommandV2Schema('territory.occupy',z.strictObject(base));
export const territoryLiberateCommandSchema=createMapCommandV2Schema('territory.liberate',z.strictObject(base));
export const territoryTransferOwnershipCommandSchema=createMapCommandV2Schema('territory.transferOwnership',z.strictObject({...base,newOwnerCountryId:countryIdSchema,controllerPolicy:z.enum(['new-owner','preserve'])}));
export type TerritorialControlCommand=z.infer<typeof territoryOccupyCommandSchema>|z.infer<typeof territoryLiberateCommandSchema>|z.infer<typeof territoryTransferOwnershipCommandSchema>;
export function parseTerritorialControlCommand(input:unknown):TerritorialControlCommand{
  const value=input as {type?:unknown};
  if(value?.type==='territory.occupy')return territoryOccupyCommandSchema.parse(input);
  if(value?.type==='territory.liberate')return territoryLiberateCommandSchema.parse(input);
  if(value?.type==='territory.transferOwnership')return territoryTransferOwnershipCommandSchema.parse(input);
  throw new Error('INVALID_TERRITORIAL_COMMAND');
}
