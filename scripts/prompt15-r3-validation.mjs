import {polygons,normalizeGeometry,jsonBytes,digest,hashCanonical,compareText,generateAtoms} from './prompt14-catalog-core.mjs';
import {territoryIdForAtom} from './prompt14-catalog-topology.mjs';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {REVISION_POLICY as Q} from './prompt15-r3-policy.mjs';
import {validatePartitionCoverage} from './prompt14-source-gate.mjs';
import {union} from './prompt15-r3-input.mjs';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
const reader=new GeoJSONReader();
export function validateArchive(raw,records){
 const errors=[],byId=new Map(records.map(r=>[r.id,r]));
 if(raw.features.length!==records.length||byId.size!==records.length)errors.push('source-identity-cardinality');
 for(const f of raw.features){const r=byId.get(String(f.properties.ne_id));if(!r||r.name!==f.properties.name||r.geometryHash!==digest(jsonBytes(f.geometry))||r.originalShape.components!==polygons(f.geometry).length||r.originalShape.holes!==polygons(f.geometry).reduce((n,p)=>n+p.length-1,0))errors.push(`source-provenance:${f.properties.ne_id}`);}
 return {pass:!errors.length,errors};
}
export function stableCellId(cell,partition,sourceVersion,prepared=null){
 const geometry=normalizeGeometry(cell.geometry),partitionId=prepared?.partitionId??hashCanonical('prompt15-protected-administrative-partition.v1',{policy:Q.version,countryId:partition.sourceCountryId,oldTerritoryId:partition.oldTerritoryId,adminId:partition.adminId,geometry:partition.geometry});
 const sourceFeatureId=hashCanonical('prompt15-operational-cell.v1',{policy:P.version,candidate:'adaptive-12-24',parentKey:`${partition.sourceCountryId}:${partitionId}`,parentHash:prepared?.parentHash??digest(jsonBytes(normalizeGeometry(partition.geometry))),geometry});
 const atom=generateAtoms({selected:{features:[{properties:{countryId:partition.sourceCountryId,sourceCountryId:partition.sourceCountryId,sourceFeatureId,inputRole:'P1'},geometry}]},lock:{sourceVersion}})[0];
 return territoryIdForAtom(atom.canonicalAtomKey);
}
export function validateMembership(catalog,membership,residuals,regions){
 const errors=[],seen=new Set(),regionById=new Map(regions.map(r=>[`${r.sourceCountryId}:${r.id}`,r]));
 if(membership.length!==regions.length)errors.push('identity-deletion');
 for(const m of membership){const r=regionById.get(`${m.countryId}:${m.adminId}`);if(!r||r.active!==m.active||r.gameGeometryHash!==m.gameGeometryHash||r.sourceGeometryHash!==m.sourceGeometryHash)errors.push('identity-contract');
  if(!m.active&&m.cellOrdinals.length)errors.push('inactive-membership');if(m.active&&!m.cellOrdinals.length)errors.push('active-membership-empty');
  for(const o of m.cellOrdinals){const c=catalog[o-1];if(!c||c.adminId!==m.adminId||c.sourceCountryId!==m.countryId||seen.has(o))errors.push('administrative-membership');seen.add(o);}
 }
 for(const r of residuals){if(r.administrativeIdentity!==null)errors.push('residual-false-administration');for(const o of r.cellOrdinals){const c=catalog[o-1];if(!c||c.adminId!==null||c.sourceCountryId!==r.sourceCountryId||seen.has(o))errors.push('residual-membership');seen.add(o);}}
 if(seen.size!==catalog.length)errors.push('active-membership-omission');
 return {pass:!errors.length,errors};
}
export function validateRealization(input,cells,oldParents,sourceVersion){
 const errors=[],checks=[],groups=new Map(),ids=new Set(),idExceptions=[];
 const partitionMap=new Map(input.partitions.map(p=>[hashCanonical('prompt15-protected-administrative-partition.v1',{policy:Q.version,countryId:input.countryId,oldTerritoryId:p.oldTerritoryId,adminId:p.adminId,geometry:p.geometry}),p]));
 const idInputs=new Map([...partitionMap].map(([partitionId,p])=>[partitionId,{partitionId,parentHash:digest(jsonBytes(normalizeGeometry(p.geometry)))}]));
 for(const c of cells){const p=partitionMap.get(c.partitionId);if(!p||c.adminId!==p.adminId||c.oldTerritoryId!==p.oldTerritoryId||c.sourceCountryId!==input.countryId){errors.push('protected-parent-or-admin-mapping');continue;}
  try{if(ids.has(c.id)||stableCellId(c,p,sourceVersion,idInputs.get(c.partitionId))!==c.id)errors.push('unstable-or-duplicate-id');}catch(error){errors.push('stable-id-numeric-representation-unresolved');idExceptions.push({cellId:c.id,name:error.name,message:error.message});}ids.add(c.id);const list=groups.get(c.partitionId)??[];list.push(c.geometry);groups.set(c.partitionId,list);
 }
 for(const [id,p]of partitionMap){const parts=groups.get(id)??[],coverage=validatePartitionCoverage(p.geometry,[union(parts)]),index=new STRtree();for(const g of parts){const polygon=reader.read(g);index.insert(polygon.getEnvelopeInternal(),polygon);}let supportedComponents=0;
  for(const component of polygons(p.geometry)){const source=reader.read({type:'Polygon',coordinates:component});for(const it=index.query(source.getEnvelopeInternal()).iterator();it.hasNext();)if(OverlayOp.intersection(source,it.next()).getArea()>0){supportedComponents++;break;}}
  const componentPresence=supportedComponents===polygons(p.geometry).length;checks.push({partitionId:id,...coverage,supportedComponents,expectedComponents:polygons(p.geometry).length,componentPresence});if(!coverage.pass||!parts.length)errors.push('partition-membership-union');if(!componentPresence)errors.push('positive-game-component-omission');}
 for(const parent of oldParents){const coverage=validatePartitionCoverage(parent.geometry,[union(cells.filter(c=>c.oldTerritoryId===parent.properties.territoryId).map(c=>c.geometry))]);if(!coverage.pass)errors.push('protected-parent-crossing');}
 for(const r of input.gameRegions){const parts=cells.filter(c=>c.adminId===r.id);if(r.active){const coverage=validatePartitionCoverage(r.geometry,[union(parts.map(c=>c.geometry))]);if(!coverage.pass||!parts.length)errors.push('active-game-union');}else if(r.geometry!==null||parts.length)errors.push('inactive-geometry-or-membership');}
 return {pass:!errors.length,errors:[...new Set(errors)].sort(compareText),checks,idExceptions};
}
