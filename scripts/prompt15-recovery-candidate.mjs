// Offline diagnostic candidates only. Never writes source locks or runtime assets.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import {arrangeSourcePartitions,ARRANGEMENT_POLICY} from './prompt14-boundary-arrangement.mjs';
import {certifyResidualBoundary} from './prompt14-game-selection.mjs';
import {generateAtoms,polygons,jsonBytes,digest} from './prompt14-catalog-core.mjs';
import {buildCatalogTopology} from './prompt14-catalog-topology.mjs';
import {resolveAdmin1Parents,validatePartitionCoverage,validatePolygonFeatureCollection,CANONICAL_P0_VALIDATOR_POLICY} from './prompt14-source-gate.mjs';

const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const reader=new GeoJSONReader();
const area=coordinates=>coordinates.length?reader.read({type:'MultiPolygon',coordinates}).getArea():0;
const shape=g=>({components:polygons(g).length,holes:polygons(g).reduce((n,p)=>n+p.length-1,0)});

export function recoverCountry(countryId,onProgress=()=>{}) {
 const all=read('data/derived/prompt14/shared-game-p0.geojson'),raw=read('data/derived/prompt14/shared-admin1-input.geojson');
 const parents=resolveAdmin1Parents(raw,all.features.map(f=>f.properties.countryId),read('src/data/countries-2020.json'));
 const p0={type:'FeatureCollection',features:all.features.filter(f=>f.properties.countryId===countryId)};
 if(p0.features.length!==1)throw Error('Unknown country');
 const selected={type:'FeatureCollection',features:raw.features.flatMap((f,i)=>parents.entries[i].normalizedParentCountryId===countryId&&!parents.entries[i].excluded?[{...f,properties:{countryId,sourceCountryId:countryId,sourceFeatureId:String(f.properties.ne_id),inputRole:'P1'}}]:[])};
 if(!selected.features.length)return {status:'blocked',countryId,reason:'No pinned P1 identity; retain original P0 classification without fabricating administrative identity',sourceIdentityCount:0};
 try {
  const result=arrangeSourcePartitions(p0,selected,raw,onProgress);
  result.evidence.policy={...ARRANGEMENT_POLICY,version:'prompt15-administrative-recovery-diagnostic-v1',stage:'15-2 offline diagnostic candidate',
   algorithmVersion:ARRANGEMENT_POLICY.version,fallback:'Fail the new candidate and retain existing deployment. Never replace source administrative identities with one whole-country territory.'};
  const coverage=validatePartitionCoverage(p0.features[0].geometry,result.selected.features.map(f=>f.geometry));
  const validity=validatePolygonFeatureCollection(result.selected,'candidate',CANONICAL_P0_VALIDATOR_POLICY);
  const correspondences=selected.features.map((source,i)=>{
   const candidate=result.selected.features[i];
   const removed=polygonClipping.difference(polygons(source.geometry),polygons(candidate.geometry));
   const added=polygonClipping.difference(polygons(candidate.geometry),polygons(source.geometry));
   return {sourceFeatureId:source.properties.sourceFeatureId,candidateSourceFeatureId:candidate.properties.sourceFeatureId,
    sourceShape:shape(source.geometry),candidateShape:shape(candidate.geometry),removedArea:area(removed),addedArea:area(added),
    addedBoundaryCertificate:added.length?certifyResidualBoundary({type:'MultiPolygon',coordinates:added},source.geometry):{pass:true},
    removedBoundaryCertificate:removed.length?certifyResidualBoundary({type:'MultiPolygon',coordinates:removed},source.geometry):{pass:true}};
  });
  const countryArea=reader.read(p0.features[0].geometry).getArea();
  const adjustmentAreaFraction=correspondences.reduce((n,c)=>n+c.removedArea+c.addedArea,0)/countryArea;
  const identityPreserved=correspondences.every(c=>c.sourceFeatureId===c.candidateSourceFeatureId)&&new Set(correspondences.map(c=>c.sourceFeatureId)).size===selected.features.length;
  const componentsAndHolesPreserved=correspondences.every(c=>JSON.stringify(c.sourceShape)===JSON.stringify(c.candidateShape));
  const boundaryCertified=correspondences.every(c=>c.addedBoundaryCertificate.pass&&c.removedBoundaryCertificate.pass);
  let topology=null,topologyFailure=null;
  try {topology=buildCatalogTopology(generateAtoms({selected:result.selected,lock:read('data/source-locks/prompt14-derived-game-input-lock.json')}),result.p0,onProgress);}catch(e){topologyFailure={message:e.message,evidence:e.evidence??null};}
  const checks={coverage:coverage.pass,validity:validity.pass,identityPreserved,componentsAndHolesPreserved,boundaryCertified,
   adjustmentWithinExistingBound:adjustmentAreaFraction<=ARRANGEMENT_POLICY.maximumActualAlignmentAreaFraction,topology:topology!==null,
   numericalDisplacement:result.evidence.common.maximumNodedSegmentDisplacement<=1e-12,unresolved:result.evidence.unresolved.length===0};
  return {status:Object.values(checks).every(Boolean)?'pass':'blocked',countryId,sourceIdentityCount:selected.features.length,checks,coverage,validity,
   adjustmentAreaFraction,correspondences,topologyEvidence:topology?.evidence??null,topologyFailure,...result,
   geometrySha256:digest(jsonBytes(result.selected)),topologySha256:topology?digest(jsonBytes(topology)):null,
   scope:'Diagnostic administrative recovery only; no operational cells, migration, runtime cutover or global topology approval'};
 }catch(e){return {status:'blocked',countryId,sourceIdentityCount:selected.features.length,reason:e.message,evidence:e.evidence??null};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const country=process.argv[2]??'SVN',label=process.argv[3]??'first';
 if(!/^[A-Z0-9]{3}$/.test(country)||!['first','second'].includes(label))throw Error('Invalid candidate output');
 fs.mkdirSync('reports/prompt15/candidates',{recursive:true});
 const result=recoverCountry(country,console.log);
 fs.writeFileSync(`reports/prompt15/candidates/${country}-${label}.json`,jsonBytes(result));
 console.log(JSON.stringify({country,status:result.status,checks:result.checks,reason:result.reason}));
}
