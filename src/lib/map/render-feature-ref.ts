import type {TerritoryId} from '../world/territory-id';
export type RenderFeatureRef = Readonly<
  {sourceType:'vector';sourceId:string;sourceLayer:'territories'|'edges';featureId:TerritoryId|string} |
  {sourceType:'geojson';sourceId:string;featureId:TerritoryId|string}
>;
export function mapLibreFeatureTarget(ref:RenderFeatureRef) {
  if(!ref.sourceId||!ref.featureId)throw new Error('Invalid render feature reference');
  if(ref.sourceType==='vector'){
    if(!['territories','edges'].includes(ref.sourceLayer))throw new Error('Invalid vector source layer');
    return {source:ref.sourceId,sourceLayer:ref.sourceLayer,id:ref.featureId};
  }
  if(ref.sourceType!=='geojson')throw new Error('Unknown render source type');
  return {source:ref.sourceId,id:ref.featureId};
}
