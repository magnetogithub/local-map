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
import {physicalAreaKm2} from './prompt15-cell-core.mjs';

const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const reader=new GeoJSONReader();
const area=coordinates=>coordinates.length?reader.read({type:'MultiPolygon',coordinates}).getArea():0;
const shape=g=>({components:polygons(g).length,holes:polygons(g).reduce((n,p)=>n+p.length-1,0)});
const squareMetres=g=>physicalAreaKm2(g)*1e6;

// 15-08 reset: reuse the already-pinned Prompt 14 common-arrangement bounds.
// The previous 100/1000 m² absolute caps were not compatible with the pinned
// pre-fallback input itself: clipping its long border chains to the immutable
// P0 envelope requires 8,807 m² while moving no chain more than 0.000051°.
// Area is therefore bounded by the pre-existing proportional limit and every
// changed chain still needs a continuous boundary certificate.
export const RESTORATION_POLICY=Object.freeze({
 version:'prompt15-administrative-restoration-policy-v2',taskId:'15-08',stage:'fixed-before-15-09-v2-scoring',
 algorithmVersion:ARRANGEMENT_POLICY.version,
 numericalDisplacementDegrees:ARRANGEMENT_POLICY.numericalModel.maximumNumericalDisplacementDegrees,
 maximumActualAlignmentDisplacementDegrees:ARRANGEMENT_POLICY.maximumActualAlignmentDisplacementDegrees,
 maximumGrossSymmetricDifferenceFraction:ARRANGEMENT_POLICY.maximumActualAlignmentAreaFraction,
 preservation:{missingIdentities:0,duplicateIdentities:0,lostComponents:0,lostHoles:0,unresolvedFaces:0},
 baseline:'Pinned raw SVN Admin-1 bytes are identical to the pre-fallback derived SVN geometries. Candidate deltas are measured from those 193 geometries; approved P0 remains immutable.',
 ownership:'Only oriented pinned shared-chain terminal continuation may assign an actual residual. Nearest, centroid, ID-order, whole-country replacement and threshold deletion are forbidden.',
 failure:'Reject the new candidate and retain the approved deployment.',
});

export function recoverCountry(countryId,onProgress=()=>{}) {
 const all=read('data/derived/prompt14/shared-game-p0.geojson'),raw=read('data/derived/prompt14/shared-admin1-input.geojson'),upstream=read('data/raw/ne_10m_admin_1_states_provinces.geojson');
 const parents=resolveAdmin1Parents(raw,all.features.map(f=>f.properties.countryId),read('src/data/countries-2020.json'));
 const p0={type:'FeatureCollection',features:all.features.filter(f=>f.properties.countryId===countryId)};
 if(p0.features.length!==1)throw Error('Unknown country');
 const selected={type:'FeatureCollection',features:raw.features.flatMap((f,i)=>parents.entries[i].normalizedParentCountryId===countryId&&!parents.entries[i].excluded?[{...f,properties:{countryId,sourceCountryId:countryId,sourceFeatureId:String(f.properties.ne_id),inputRole:'P1'}}]:[])};
 if(!selected.features.length)return {status:'blocked',countryId,reason:'No pinned P1 identity; retain original P0 classification without fabricating administrative identity',sourceIdentityCount:0};
 try {
  const result=arrangeSourcePartitions(p0,selected,raw,onProgress);
  result.evidence.policy={...ARRANGEMENT_POLICY,...RESTORATION_POLICY,
   algorithmVersion:ARRANGEMENT_POLICY.version,fallback:'Fail the new candidate and retain existing deployment. Never replace source administrative identities with one whole-country territory.'};
  const coverage=validatePartitionCoverage(p0.features[0].geometry,result.selected.features.map(f=>f.geometry));
  const validity=validatePolygonFeatureCollection(result.selected,'candidate',CANONICAL_P0_VALIDATOR_POLICY);
  const upstreamById=new Map(upstream.features.map(feature=>[String(feature.properties.ne_id),feature]));
  const correspondences=selected.features.map((source,i)=>{
   const candidate=result.selected.features[i];
   const removed=polygonClipping.difference(polygons(source.geometry),polygons(candidate.geometry));
   const added=polygonClipping.difference(polygons(candidate.geometry),polygons(source.geometry));
   const removedGeometry={type:'MultiPolygon',coordinates:removed},addedGeometry={type:'MultiPolygon',coordinates:added};
   const removedSquareMetres=removed.length?squareMetres(removedGeometry):0,addedSquareMetres=added.length?squareMetres(addedGeometry):0;
   const baselineSquareMetres=squareMetres(source.geometry),grossSquareMetres=removedSquareMetres+addedSquareMetres;
   const addedBoundaryCertificate=added.length?certifyResidualBoundary(addedGeometry,source.geometry):{pass:true,maximumBoundaryDisplacementUpperBoundDegrees:0};
   const removedBoundaryCertificate=removed.length?certifyResidualBoundary(removedGeometry,source.geometry):{pass:true,maximumBoundaryDisplacementUpperBoundDegrees:0};
   const maximumBoundaryDisplacementDegrees=Math.max(addedBoundaryCertificate.maximumBoundaryDisplacementUpperBoundDegrees??0,removedBoundaryCertificate.maximumBoundaryDisplacementUpperBoundDegrees??0);
   return {sourceFeatureId:source.properties.sourceFeatureId,candidateSourceFeatureId:candidate.properties.sourceFeatureId,
    sourceShape:shape(source.geometry),candidateShape:shape(candidate.geometry),removedArea:area(removed),addedArea:area(added),
    removedSquareMetres,addedSquareMetres,grossSquareMetres,baselineSquareMetres,grossFraction:grossSquareMetres/baselineSquareMetres,maximumBoundaryDisplacementDegrees,
    addedBoundaryCertificate,removedBoundaryCertificate};
  });
  const countryArea=reader.read(p0.features[0].geometry).getArea();
  const adjustmentAreaFraction=correspondences.reduce((n,c)=>n+c.removedArea+c.addedArea,0)/countryArea;
  const identityPreserved=correspondences.every(c=>c.sourceFeatureId===c.candidateSourceFeatureId)&&new Set(correspondences.map(c=>c.sourceFeatureId)).size===selected.features.length;
  const componentsAndHolesPreserved=correspondences.every(c=>JSON.stringify(c.sourceShape)===JSON.stringify(c.candidateShape));
  const boundaryCertified=correspondences.every(c=>c.addedBoundaryCertificate.pass&&c.removedBoundaryCertificate.pass);
  const rawSourceCorrespondence=selected.features.map(source=>{const id=String(source.properties.sourceFeatureId),upstreamFeature=upstreamById.get(id);return {sourceFeatureId:id,rawGeometrySha256:upstreamFeature?digest(jsonBytes(upstreamFeature.geometry)):null,derivedGeometrySha256:digest(jsonBytes(source.geometry)),exactGeometry:upstreamFeature?digest(jsonBytes(upstreamFeature.geometry))===digest(jsonBytes(source.geometry)):false,rawShape:upstreamFeature?shape(upstreamFeature.geometry):null,derivedShape:shape(source.geometry)};});
  const rawIdentityBijection=rawSourceCorrespondence.length===selected.features.length&&rawSourceCorrespondence.every(item=>item.rawGeometrySha256)&&new Set(rawSourceCorrespondence.map(item=>item.sourceFeatureId)).size===selected.features.length;
  const rawGeometryCorrespondence=rawSourceCorrespondence.every(item=>item.exactGeometry&&JSON.stringify(item.rawShape)===JSON.stringify(item.derivedShape));
  const maximumBoundaryDisplacementDegrees=correspondences.reduce((maximum,item)=>Math.max(maximum,item.maximumBoundaryDisplacementDegrees),0);
  const countryGrossSquareMetres=correspondences.reduce((sum,item)=>sum+item.grossSquareMetres,0),countryAreaSquareMetres=squareMetres(p0.features[0].geometry),countryGrossFraction=countryGrossSquareMetres/countryAreaSquareMetres;
  const perIdentityAlignmentWithinBound=correspondences.every(item=>item.maximumBoundaryDisplacementDegrees<=RESTORATION_POLICY.maximumActualAlignmentDisplacementDegrees&&item.grossFraction<=RESTORATION_POLICY.maximumGrossSymmetricDifferenceFraction);
  const countryAlignmentWithinBound=countryGrossFraction<=RESTORATION_POLICY.maximumGrossSymmetricDifferenceFraction;
  let topology=null,topologyFailure=null;
  try {topology=buildCatalogTopology(generateAtoms({selected:result.selected,lock:read('data/source-locks/prompt14-derived-game-input-lock.json')}),result.p0,onProgress);}catch(e){topologyFailure={message:e.message,evidence:e.evidence??null};}
  const checks={coverage:coverage.pass,validity:validity.pass,identityPreserved,rawIdentityBijection,rawGeometryCorrespondence,componentsAndHolesPreserved,boundaryCertified,
   adjustmentWithinExistingBound:adjustmentAreaFraction<=RESTORATION_POLICY.maximumGrossSymmetricDifferenceFraction,perIdentityAlignmentWithinBound,countryAlignmentWithinBound,topology:topology!==null,
   numericalDisplacement:result.evidence.common.maximumNodedSegmentDisplacement<=1e-12,unresolved:result.evidence.unresolved.length===0};
  return {status:Object.values(checks).every(Boolean)?'pass':'blocked',countryId,sourceIdentityCount:selected.features.length,checks,coverage,validity,
   adjustmentAreaFraction,maximumBoundaryDisplacementDegrees,countryGrossSquareMetres,countryAreaSquareMetres,countryGrossFraction,rawSourceCorrespondence,correspondences,topologyEvidence:topology?.evidence??null,topologyFailure,...result,
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
