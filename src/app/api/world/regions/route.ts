import {z} from 'zod';
import {loadCatalogRegionIndex} from '@/lib/simulation/catalog-region.server';
import {loadProductionCatalogSeed} from '@/lib/world/production-catalog-seed.server';
import {assertWorldGeometryCatalogRefMatches,createWorldGeometryCatalogRef} from '@/lib/world/world-geometry-catalog-ref';
import {subdivisionReferenceSchema} from '@/lib/simulation/world-effect';
import {regionOperation} from '@/lib/simulation/catalog-region';
export const runtime='nodejs';
const schema=z.strictObject({catalogRef:z.unknown(),countryId:z.string().min(1).max(160),operation:regionOperation,query:z.string().min(1).max(120).optional(),reference:subdivisionReferenceSchema.optional(),limit:z.number().int().min(1).max(128).optional()});
export async function POST(request:Request){
  if(Number(request.headers.get('content-length'))>4096)return Response.json({ok:false,code:'REGION_REQUEST_CAP'},{status:413});
  try{const raw=await request.text();if(new TextEncoder().encode(raw).length>4096)throw Error('REGION_REQUEST_CAP');const a=schema.parse(JSON.parse(raw));
    assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(a.catalogRef),loadProductionCatalogSeed().bootstrap.catalogRef);
    const index=loadCatalogRegionIndex();
    if(a.reference)return Response.json({ok:true,region:index.resolve(a.countryId,a.reference,a.operation)});
    const compact=(r:typeof index.records[number])=>({ref:r.ref,parentCountryId:r.parentCountryId,nameKo:r.nameKo,nameEn:r.nameEn,materializable:true});
    if(a.query){const found=index.search(a.countryId,a.query);if(found.length!==1)return Response.json({ok:false,code:found.length?'AMBIGUOUS_REGION':'UNKNOWN_REGION',candidates:found.map(compact)});
      return Response.json({ok:true,region:compact(found[0])});}
    return Response.json({ok:true,regions:index.records.filter(r=>r.parentCountryId===a.countryId).slice(0,a.limit??128).map(compact),clipped:index.records.filter(r=>r.parentCountryId===a.countryId).length>(a.limit??128)});
  }catch(error){return Response.json({ok:false,code:error instanceof Error?error.message:'INVALID_REGION_REQUEST'},{status:400});}
}
