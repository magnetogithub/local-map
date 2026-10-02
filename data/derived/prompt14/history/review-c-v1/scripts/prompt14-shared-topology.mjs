import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import {normalizeCountryId,UPSTREAM_RELEASE,CANONICAL_P0_VALIDATOR_POLICY,validatePolygonFeatureCollection,sha256} from './prompt14-source-gate.mjs';
import {normalizeCollection} from './prompt14-repair.mjs';

export const SHARED_TOPOLOGY_POLICY=Object.freeze({
  version:'prompt14-shared-source-topology-v1',generatorVersion:'prompt14-shared-topology-v1',
  authority:'Derived game P0; pinned Natural Earth v5.1.2 unsimplified Admin0; existing metadata IDs/owner and existing map-unit assignment retained. Not external legal certification.',
  originals:'Raw sources, original production seed and metadata remain byte-identical.',
  precision:'Original doubles preserved. No independent rounding, simplification, snapping, buffer or winner-country subtraction.',
  operations:['same-country source union with shared coordinates unchanged','existing KAS->IND/KAB->KAZ source masks only; no new ownership decisions','exact duplicate removal and winding normalization','self-touch ring noding only if geometric area and boundary unchanged'],
  maximumSeedBoundaryDisplacementDegrees:0.0015+Math.SQRT2*0.000005,
  displacementBasis:'Existing distance thinning .0015 degrees plus 5-place rounding radius. Bidirectional continuous segment certificate by adaptive subdivision: distance to each fixed target segment is convex, so endpoint maximum bounds the entire subsegment.',
  areaChangeBound:'Seed perimeter * maximumSeedBoundaryDisplacementDegrees + pi * displacement^2 per ring; also report relative area and symmetric difference per country.',
  sourceCoverageToleranceDegreesSquared:1e-9,
  p1SelfTouchNodingBoundaryToleranceDegrees:1e-12,
  p1SelfTouchNodingPolicy:'Only pre-existing exact non-adjacent repeated source vertices may be noded. No bow-tie/intersection repair or guessed topology. Preserve feature properties, area within 1e-9 degree squared and certify both complete boundary sets within 1e-12 degree. Validate output independently; otherwise keep candidate invalid and explicitly exclude it through country selection.',
  islandHolePolicy:'Every positive-area seed component and hole must intersect a corresponding derived component/hole. Report counts and source self-touch splits; no whole island/hole deletion allowed.',
  failureConditions:['source hash mismatch','non-deterministic bytes','metadata/property changes','positive country overlap','unjustified ownership change','displacement/area bound exceeded','island or hole loss','invalid derived geometry'],
  locks:'Derived P0 locked after full checks, P1 locked after partition verification; no cap merges across either boundary.',
});
const reader=new GeoJSONReader();
const mp=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates;
const geom=coordinates=>({type:'MultiPolygon',coordinates});
const area=g=>reader.read(g).getArea();
const excluded=new Set(['BJN','SER','SCR']);

export function deriveSharedP0(raw,seed,applyExistingMasks=true){
  const groups=new Map();
  for(const f of raw.features){if(excluded.has(f.properties.ADM0_A3))continue;const id=normalizeCountryId(f.properties.ADM0_A3);if(!id)throw new Error('unknown Admin0 identity');const a=groups.get(id)??[];a.push(f);groups.set(id,a);}
  const geometries=new Map([...groups].map(([id,fs])=>[id,polygonClipping.union(...fs.map(f=>mp(f.geometry)))]));
  for(const [rawId,target]of applyExistingMasks?[['KAS','IND'],['KAB','KAZ']]:[]){
    const masks=raw.features.filter(f=>f.properties.ADM0_A3===rawId);if(!masks.length)continue;
    const mask=polygonClipping.union(...masks.map(f=>mp(f.geometry)));
    for(const [id,g]of geometries)if(id!==target)geometries.set(id,polygonClipping.difference(g,mask));
  }
  if(JSON.stringify([...geometries.keys()].sort())!==JSON.stringify(seed.features.map(f=>f.properties.countryId).sort()))throw new Error('derived P0 country set differs');
  return normalizeCollection({type:'FeatureCollection',features:seed.features.map(f=>{const coordinates=geometries.get(f.properties.countryId);if(!coordinates?.length)throw new Error('empty derived country');return {...structuredClone(f),geometry:coordinates.length===1?{type:'Polygon',coordinates:coordinates[0]}:geom(coordinates)};})},CANONICAL_P0_VALIDATOR_POLICY);
}

// A sparse index avoids quadratic world-scale comparisons. Original doubles are never changed.
function boundaryIndex(g){
  const cell=.02,buckets=new Map(),segments=[];
  for(const p of mp(g))for(const r of p)for(let i=1;i<r.length;i++){
    const a=r[i-1],b=r[i],index=segments.length;segments.push([a,b]);
    const x0=Math.floor(Math.min(a[0],b[0])/cell),x1=Math.floor(Math.max(a[0],b[0])/cell),y0=Math.floor(Math.min(a[1],b[1])/cell),y1=Math.floor(Math.max(a[1],b[1])/cell);
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const k=x+','+y,arr=buckets.get(k)??[];arr.push(index);buckets.set(k,arr);}
  }
  return p=>{
    const x=Math.floor(p[0]/cell),y=Math.floor(p[1]/cell);let minimum=Infinity,nearest=null;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const i of buckets.get((x+dx)+','+(y+dy))??[]){const segment=segments[i],distance=segmentDistance(p,segment);if(distance<minimum){minimum=distance;nearest=segment;}}
    return {distance:minimum,segment:nearest};
  };
}
function segmentDistance(p,[a,b]){const vx=b[0]-a[0],vy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*vx+(p[1]-a[1])*vy)/(vx*vx+vy*vy||1)));return Math.hypot(p[0]-a[0]-t*vx,p[1]-a[1]-t*vy);}
export function measureBoundaryChange(a,b,limit=SHARED_TOPOLOGY_POLICY.maximumSeedBoundaryDisplacementDegrees){
  let maximum=0,upper=0,perimeter=0,certified=true;
  for(const [source,target]of [[a,b],[b,a]]){const nearest=boundaryIndex(target);
    const certify=(p,q,depth=0)=>{const middle=[(p[0]+q[0])/2,(p[1]+q[1])/2],n=nearest(middle);maximum=Math.max(maximum,n.distance);if(!n.segment||n.distance>limit){certified=false;return;}
      const bound=Math.max(segmentDistance(p,n.segment),segmentDistance(q,n.segment));if(bound<=limit){upper=Math.max(upper,bound,n.distance);return;}if(depth>=24){certified=false;return;}certify(p,middle,depth+1);certify(middle,q,depth+1);
    };
    for(const polygon of mp(source))for(const ring of polygon)for(let i=1;i<ring.length;i++){const p=ring[i-1],q=ring[i];certify(p,q);if(source===a)perimeter+=Math.hypot(p[0]-q[0],p[1]-q[1]);}}
  return {sampledMaximumBoundaryDisplacementDegrees:maximum,certifiedMaximumBoundaryDisplacementUpperBoundDegrees:certified?upper:null,seedPerimeterDegrees:perimeter,continuousMaximumCertified:certified};
}

export function prepareTopologyP1(collection){
  const output=structuredClone(collection),repairs=[],unresolved=[];
  for(const [i,f]of collection.features.entries()){
    const before=validatePolygonFeatureCollection(normalizeCollection({type:'FeatureCollection',features:[f]},CANONICAL_P0_VALIDATOR_POLICY),'source-P1',CANONICAL_P0_VALIDATOR_POLICY);
    if(before.pass)continue;
    let repeated=false;for(const p of mp(f.geometry))for(const ring of p){const seen=new Set();for(const coordinate of ring.slice(0,-1)){const key=JSON.stringify(coordinate);if(seen.has(key))repeated=true;seen.add(key);}}
    const sourceFeatureId=String(f.properties.ne_id??f.properties.sourceFeatureId??i);
    if(!repeated){unresolved.push({sourceFeatureId,reason:'invalid source without exact self-touch witness',errors:before.errors});continue;}
    try{const noded={...structuredClone(f),geometry:geom(polygonClipping.union(mp(f.geometry)))},normalized=normalizeCollection({type:'FeatureCollection',features:[noded]},CANONICAL_P0_VALIDATOR_POLICY).features[0];
      const after=validatePolygonFeatureCollection({type:'FeatureCollection',features:[normalized]},'noded-P1',CANONICAL_P0_VALIDATOR_POLICY),boundary=measureBoundaryChange(f.geometry,normalized.geometry,SHARED_TOPOLOGY_POLICY.p1SelfTouchNodingBoundaryToleranceDegrees),areaDelta=area(normalized.geometry)-area(f.geometry);
      if(!after.pass||!boundary.continuousMaximumCertified||Math.abs(areaDelta)>SHARED_TOPOLOGY_POLICY.sourceCoverageToleranceDegreesSquared)throw new Error('self-touch noding changes area/boundary or remains invalid');
      output.features[i]=normalized;repairs.push({sourceFeatureId,featureIndex:i,typeBefore:f.geometry.type,typeAfter:normalized.geometry.type,componentsBefore:mp(f.geometry).length,componentsAfter:mp(normalized.geometry).length,areaDeltaDegreesSquared:areaDelta,boundary,before,after});
    }catch(error){unresolved.push({sourceFeatureId,reason:error.message,errors:before.errors});}
  }
  return {collection:output,repairs,unresolved,identityPreserved:output.features.length===collection.features.length&&output.features.every((f,i)=>JSON.stringify(f.properties)===JSON.stringify(collection.features[i].properties))};
}
export function verifySharedP0(seed,derived,firstBytes,secondBytes){
  const errors=[],countries=[];
  const boxCache=new WeakMap(),box=p=>{if(boxCache.has(p))return boxCache.get(p);const b=[Infinity,Infinity,-Infinity,-Infinity];for(const r of p)for(const [x,y]of r){b[0]=Math.min(b[0],x);b[1]=Math.min(b[1],y);b[2]=Math.max(b[2],x);b[3]=Math.max(b[3],y);}boxCache.set(p,b);return b;};
  if(!firstBytes.equals(secondBytes))errors.push('non-deterministic derived P0 bytes');
  if(seed.features.length!==derived.features.length)errors.push('country count changed');
  for(const f of seed.features){try{const d=derived.features.find(g=>g.properties.countryId===f.properties.countryId);if(!d||JSON.stringify(d.properties)!==JSON.stringify(f.properties)){errors.push('country identity/metadata changed');continue;}
    const before=mp(f.geometry),after=mp(d.geometry),boundary=measureBoundaryChange(f.geometry,d.geometry),delta=area(d.geometry)-area(f.geometry),bound=boundary.seedPerimeterDegrees*SHARED_TOPOLOGY_POLICY.maximumSeedBoundaryDisplacementDegrees+before.reduce((s,p)=>s+p.length,0)*Math.PI*SHARED_TOPOLOGY_POLICY.maximumSeedBoundaryDisplacementDegrees**2;
    const overlapArea=(p,q)=>{const a=box(p),b=box(q);if(a[2]<b[0]||b[2]<a[0]||a[3]<b[1]||b[3]<a[1])return 0;try{const x=polygonClipping.intersection(polygonClipping.union([p]),polygonClipping.union([q]));return x.length?area(geom(x)):0;}catch{ return OverlayOp.intersection(reader.read({type:'Polygon',coordinates:p}),reader.read({type:'Polygon',coordinates:q})).getArea();}};
    const shellBoxCache=new WeakMap(),shell=p=>{if(!shellBoxCache.has(p))shellBoxCache.set(p,[p[0]]);return shellBoxCache.get(p);};
    const ordered=(p,candidates)=>{const a=box(p),score=q=>{const b=box(q),intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return intersection/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection||1);};return candidates.map(q=>({q,score:score(q)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).map(x=>x.q);};
    const lostComponents=before.flatMap((p,i)=>ordered(shell(p),after.map(shell)).some(q=>overlapArea(shell(p),q)>0)?[]:[i]);
    const holesBefore=before.flatMap(p=>p.slice(1)),holesAfter=after.flatMap(p=>p.slice(1));
    const holeCache=new WeakMap(),hole=r=>{if(!holeCache.has(r))holeCache.set(r,[r]);return holeCache.get(r);};
    const lostHoles=holesBefore.flatMap((r,i)=>ordered(hole(r),holesAfter.map(hole)).some(q=>overlapArea(hole(r),q)>0)?[]:[i]);
    let symmetricDifferenceAreaDegreesSquared;try{const removed=polygonClipping.difference(mp(f.geometry),mp(d.geometry)),added=polygonClipping.difference(mp(d.geometry),mp(f.geometry));symmetricDifferenceAreaDegreesSquared=(removed.length?area(geom(removed)):0)+(added.length?area(geom(added)):0);}catch{ symmetricDifferenceAreaDegreesSquared=OverlayOp.symDifference(reader.read(f.geometry),reader.read(d.geometry)).getArea(); }
    const result={countryId:f.properties.countryId,...boundary,areaChangeDegreesSquared:delta,relativeAreaChange:delta/area(f.geometry),symmetricDifferenceAreaDegreesSquared,areaChangeBoundDegreesSquared:bound,componentsBefore:before.length,componentsAfter:after.length,holesBefore:holesBefore.length,holesAfter:holesAfter.length,lostComponents,lostHoles};
    if(!boundary.continuousMaximumCertified||Math.abs(delta)>bound||lostComponents.length||lostHoles.length)errors.push(`${result.countryId}: bounded change or island/hole preservation failed`);
    countries.push(result);
    }catch(error){errors.push(`${f.properties.countryId}: comparison failed: ${error.message}`);countries.push({countryId:f.properties.countryId,comparisonError:error.message,continuousMaximumCertified:false,lostComponents:[],lostHoles:[]});}
  }
  const validation=validatePolygonFeatureCollection(derived,'shared-P0',CANONICAL_P0_VALIDATOR_POLICY);
  return {pass:!errors.length&&validation.pass,errors,validation,countries,maximumSampledBoundaryDisplacementDegrees:Math.max(...countries.map(c=>c.sampledMaximumBoundaryDisplacementDegrees??0)),maximumCertifiedBoundaryDisplacementUpperBoundDegrees:countries.every(c=>c.continuousMaximumCertified)?Math.max(...countries.map(c=>c.certifiedMaximumBoundaryDisplacementUpperBoundDegrees)):null,maximumAbsoluteAreaChangeDegreesSquared:Math.max(...countries.map(c=>Math.abs(c.areaChangeDegreesSquared??0))),maximumRelativeAreaChange:Math.max(...countries.map(c=>Math.abs(c.relativeAreaChange??0))),islandHolePreservation:!countries.some(c=>c.comparisonError||c.lostComponents.length||c.lostHoles.length),continuousBoundaryBoundVerified:countries.every(c=>c.continuousMaximumCertified)};
}
export function buildSharedP0(root){
  const rawBytes=fs.readFileSync(root+'/data/raw/ne_10m_admin_0_countries.geojson');if(sha256(rawBytes)!==UPSTREAM_RELEASE.admin0Sha256)throw new Error('shared P0 source hash mismatch');
  const seed=JSON.parse(fs.readFileSync(root+'/public/data/maps/countries-10m.geojson')),raw=JSON.parse(rawBytes);
  const first=deriveSharedP0(raw,seed),second=deriveSharedP0(structuredClone(raw),structuredClone(seed)),firstBytes=Buffer.from(JSON.stringify(first)+'\n'),secondBytes=Buffer.from(JSON.stringify(second)+'\n');
  return {collection:first,bytes:firstBytes,evidence:verifySharedP0(seed,first,firstBytes,secondBytes),sourceFeatureIds:Object.fromEntries(seed.features.map(f=>[f.properties.countryId,raw.features.filter(r=>!excluded.has(r.properties.ADM0_A3)&&normalizeCountryId(r.properties.ADM0_A3)===f.properties.countryId).map(r=>String(r.properties.NE_ID))]))};
}

export const REQUIRED_PARTIAL_OCCUPATION_COUNTRIES=['USA','CHN','KOR','GBR','FRA'];
export function estimateComponentAtoms(collection){
  const counts=new Map();for(const f of collection.features){const id=f.properties.countryId;counts.set(id,(counts.get(id)??0)+mp(f.geometry).length);}
  return {totalAtoms:[...counts.values()].reduce((a,b)=>a+b,0),sourceFeatureTerritoryEstimate:collection.features.length,countries:[...counts].map(([countryId,atomCount])=>({countryId,atomCount})),basis:'Conservative source-feature plus normalized component atom identities, per prompt canonicalAtomKey. Source feature count alone is a lower territory estimate, not proof of the atom cap. Any reduction requires a demonstrated policy within P0/P1 locks, preserving islands/holes and administrative identities; not whole-country cap fallback.'};
}
export const COMPONENT_GROUPING_POLICY=Object.freeze({
  version:'prompt14-source-feature-component-grouping-v1',
  operation:'Plan one MultiPolygon territory for the complete component set of ONE already-selected source feature. No geometric alteration or source-feature merge.',
  allowed:'Disconnected components of the same selected administrative identity, or the explicitly recorded P0 fallback/source-component identity; preserve every ring, hole and component.',
  forbidden:['merging different selected P1 identities','merging countries','inventing connectors','dropping islands/holes','whole-country fallback to reduce caps'],
  basis:'Prompt permits Polygon/MultiPolygon and merges within protected P0/P1 partitions. All component identities remain recorded; the source administrative unit remains the game occupation unit.',
  futureGate:'14-6/14-7 must derive canonical component keys, verify this exact membership plan and final caps, coverage, topology and z0-6 delivery. Plan evidence is not a generated catalog.',
});
export function planSourceComponentGroups(collection){
  return {policy:COMPONENT_GROUPING_POLICY,inputSha256:sha256(Buffer.from(JSON.stringify(collection)+'\n')),groups:collection.features.map((f,featureIndex)=>({sourceCountryId:f.properties.countryId,sourceFeatureId:f.properties.sourceFeatureId,members:mp(f.geometry).map((p,componentIndex)=>({featureIndex,componentIndex,componentInputSha256:sha256(Buffer.from(JSON.stringify(p)))}))}))};
}
export function verifySourceComponentGroups(collection,plan){
  const errors=[],seen=new Set(),counts=new Map();
  if(JSON.stringify(plan.policy)!==JSON.stringify(COMPONENT_GROUPING_POLICY)||plan.inputSha256!==sha256(Buffer.from(JSON.stringify(collection)+'\n')))errors.push('grouping policy/input mismatch');
  for(const group of plan.groups){let anchor=null;for(const member of group.members){const f=collection.features[member.featureIndex],p=f&&mp(f.geometry)[member.componentIndex],key=member.featureIndex+':'+member.componentIndex;if(!p||seen.has(key)||group.sourceCountryId!==f.properties.countryId||group.sourceFeatureId!==f.properties.sourceFeatureId||sha256(Buffer.from(JSON.stringify(p)))!==member.componentInputSha256){errors.push('missing, duplicate, modified or foreign component');continue;}seen.add(key);if(anchor!==null&&anchor!==member.featureIndex)errors.push('crossing protected source-feature boundary');anchor=member.featureIndex;}
    if(!group.members.length)errors.push('empty component group');counts.set(group.sourceCountryId,(counts.get(group.sourceCountryId)??0)+1);
  }
  const raw=estimateComponentAtoms(collection);if(seen.size!==raw.totalAtoms||plan.groups.length!==collection.features.length)errors.push('lost components or changed administrative identity count');
  return {pass:errors.length===0,errors,rawComponentAtomCandidates:raw.totalAtoms,projectedAtoms:plan.groups.length,countries:[...counts].map(([countryId,atomCount])=>({countryId,atomCount})),everyComponentPreserved:seen.size===raw.totalAtoms,geometryChanges:0,protectedBoundaryCrossings:errors.length?null:0,classification:'14-2 proven source-partition membership/cap projection; final canonical atom/catalog generation remains mandatory later'};
}
export function validatePartialOccupationReadiness(countries){
  const major=countries.filter(c=>REQUIRED_PARTIAL_OCCUPATION_COUNTRIES.includes(c.countryId));
  const failures=REQUIRED_PARTIAL_OCCUPATION_COUNTRIES.filter(id=>!major.some(c=>c.countryId===id&&c.selection==='aligned-P1'&&c.originalP1FeatureCount>1&&c.maintainedP1SourceFeatureIds?.length===c.originalP1FeatureCount&&new Set(c.maintainedP1SourceFeatureIds).size===c.originalP1FeatureCount&&c.selectedFeatureCount===c.originalP1FeatureCount+(c.sourceComponentFallbacks?.length??0)));
  return {pass:failures.length===0,failures,countries:major};
}

export const DERIVED_LINEAGE_PATHS=[
  'data/raw/ne_10m_admin_0_countries.geojson','data/raw/ne_10m_admin_1_states_provinces.geojson',
  'public/data/maps/countries-10m.geojson','src/data/countries-2020.json','scripts/prepare-map-data.mjs',
  'scripts/prompt14-shared-topology.mjs','scripts/prompt14-game-selection.mjs','scripts/prompt14-repair.mjs',
  'scripts/prompt14-source-gate.mjs','scripts/audit-prompt14-game-inputs.mjs','scripts/audit-prompt14-stage-1-2.mjs','package.json','package-lock.json',
  'data/source-locks/prompt14-shared-topology-policy.json','data/source-locks/prompt14-game-selection-policy.json',
  'data/source-locks/prompt14-component-grouping-policy.json',
];
export function validateDerivedGameLock(lock,root){
  const errors=[];
  if(lock&&Object.keys(lock).some(k=>!['schemaVersion','boundaryKind','operationalOnly','legalEvidenceStatus','gameStartDate','release','sourceVersion','license','attribution','acquiredFrom','lineageInputs','artifacts','tools','planningEvidence'].includes(k)))errors.push('unknown derived source-lock fields');
  if(lock?.schemaVersion!=='prompt14-derived-game-input-lock-v1'||lock?.boundaryKind!=='project-game-seed-derived-2020'||lock?.legalEvidenceStatus!=='not-required'||lock?.gameStartDate!=='2020-01-01'||lock?.operationalOnly!==false)errors.push('derived game contract/schema mismatch');
  if(!lock?.release||!lock?.sourceVersion||!lock?.license||!lock?.attribution||!lock?.acquiredFrom)errors.push('missing release/source/license/attribution');
  if(JSON.stringify((lock?.lineageInputs??[]).map(x=>x.repositoryPath).sort())!==JSON.stringify([...DERIVED_LINEAGE_PATHS].sort()))errors.push('missing original source/seed/code/policy connection');
  if(lock?.release!==UPSTREAM_RELEASE.release||lock?.sourceVersion!==UPSTREAM_RELEASE.commit)errors.push('derived release/lineage version mismatch');
  if(JSON.stringify((lock?.artifacts??[]).map(x=>x.repositoryPath).sort())!==JSON.stringify(['data/derived/prompt14/shared-game-p0.geojson','data/derived/prompt14/shared-admin1-input.geojson','data/derived/prompt14/selected-game-input.geojson'].sort()))errors.push('derived artifact set mismatch');
  if(lock?.planningEvidence?.repositoryPath!=='reports/prompt14/14-02-component-grouping-plan.json')errors.push('missing component grouping plan');
  for(const f of [...(lock?.lineageInputs??[]),...(lock?.artifacts??[]),...(lock?.planningEvidence?[lock.planningEvidence]:[])]){
    try{const bytes=fs.readFileSync(root+'/'+f.repositoryPath);if(sha256(bytes)!==f.sha256||bytes.length!==f.byteLength)errors.push('lineage/artifact bytes mismatch: '+f.repositoryPath);
      if((lock?.artifacts??[]).includes(f)){const collection=JSON.parse(bytes),types=[...new Set(collection.features.map(g=>g.geometry.type))].sort(),ids=[...new Set(collection.features.map(g=>g.properties.countryId??normalizeCountryId(g.properties.adm0_a3)).filter(Boolean))].sort();if(JSON.stringify(types)!==JSON.stringify(f.geometryTypes)||JSON.stringify(ids)!==JSON.stringify(f.coveredCountryIds))errors.push('derived geometry/coverage facts mismatch');}
    }catch{errors.push('missing or unreadable lineage/artifact file');}
  }
  return {pass:errors.length===0,errors};
}
