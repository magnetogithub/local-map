import {loadCatalogConsumerBootstrap} from '@/lib/map/catalog-consumer.server';
import {loadProductionCatalogSeed} from '@/lib/world/production-catalog-seed.server';
export const runtime='nodejs';
export async function GET(){
  try{loadCatalogConsumerBootstrap();return Response.json(loadProductionCatalogSeed().bootstrap,{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({error:'catalog_not_ready',message:'지도 catalog를 불러올 수 없습니다.'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
