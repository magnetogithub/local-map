import {z} from 'zod';
import {boundedTitleSchema} from '@/lib/simulation/simulation-contract-primitives';
import {loadCatalogLabelSeed,buildCatalogCountryLabel} from '@/lib/map/catalog-labels.server';
import {loadProductionCatalogSeed} from '@/lib/world/production-catalog-seed.server';
import {assertWorldGeometryCatalogRefMatches,createWorldGeometryCatalogRef} from '@/lib/world/world-geometry-catalog-ref';
export const runtime='nodejs';
export async function GET(){const {placements,fills,outlines,approval}=loadCatalogLabelSeed();return Response.json({placements,fills,outlines,approval});}
const schema=z.strictObject({catalogRef:z.unknown(),countryId:z.string().length(3),text:boundedTitleSchema,territoryIds:z.array(z.string().regex(/^territory:catalog:[a-f0-9]{64}$/)).min(1).max(6000)});
export async function POST(request:Request){
  try{const raw=await request.text();if(new TextEncoder().encode(raw).length>600000)throw Error('LABEL_REQUEST_CAP');const a=schema.parse(JSON.parse(raw));assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(a.catalogRef),loadProductionCatalogSeed().bootstrap.catalogRef);
    return Response.json(buildCatalogCountryLabel(a.countryId,a.text,a.territoryIds));
  }catch(error){return Response.json({code:error instanceof Error?error.message:'INVALID_LABEL_REQUEST'},{status:400});}
}
