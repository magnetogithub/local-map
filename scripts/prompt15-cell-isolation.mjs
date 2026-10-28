// Bounded experimental input adapter. This is not world-catalog admission.
import path from 'node:path';
import {openAuditInputs,ADMIN_ROOT} from './prompt15-preservation-audit.mjs';
import {WORLD_ROOT} from './prompt15-world-delivery-core.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import {normalizeGeometry,polygons,canonical} from './prompt14-catalog-core.mjs';
import {prepareAdministrativeParent} from './prompt15-parent-preparation.mjs';
export function loadIsolatedCellSources(countryIds){
 if(!Array.isArray(countryIds)||!countryIds.length||countryIds.length>6||new Set(countryIds).size!==countryIds.length)throw Error('Explicit distinct bounded country list (1..6) required');
 const wanted=new Set(countryIds),inputs=openAuditInputs(),provenance=inputs.read(ADMIN_ROOT,'provenance.json'),generation=inputs.read(WORLD_ROOT,'provenance.json');
 const fromProvenance=file=>{const pin=provenance.inputs.find(p=>p.path.replaceAll('\\','/')===file);if(!pin)throw Error(`No approved input pin: ${file}`);return JSON.parse(inputs.readFile(file,pin));};
 const p0All=fromProvenance('data/derived/prompt14/shared-game-p0.geojson'),freeze=fromProvenance('data/catalogs/prompt14/frozen-catalog-ref.json'),catalogRoot=path.dirname(freeze.artifactIndex.path).replaceAll('\\','/'),artifactIndex=JSON.parse(inputs.readFile(freeze.artifactIndex.path,freeze.artifactIndex));
 const readCatalog=name=>{const relative=`build-only/${freeze.ref.catalogVersion}/${name}`,pin=artifactIndex.artifacts.find(a=>a.path===relative);if(!pin)throw Error(`Missing frozen reference ${relative}`);return JSON.parse(inputs.readFile(`${catalogRoot}/${relative}`,pin));};
 const catalog=readCatalog('catalog.json'),topology=readCatalog('topology.json'),countries=new Map(catalog.entries.map(c=>[c.id,c.sourceCountryId]));
 const policyPin=generation.inputs.find(p=>p.path==='scripts/prompt15-cell-policy.mjs');inputs.readFile(policyPin.path,policyPin);
 const candidate=POLICY.candidates.find(c=>c.id===generation.candidate.id);if(canonical(candidate)!==canonical(generation.candidate))throw Error('Pinned candidate does not match frozen physical policy');
 const administrative=inputs.read(ADMIN_ROOT,'administrative-restoration.geojson'),residuals=inputs.read(ADMIN_ROOT,'residuals.geojson'),protectedOverlay=inputs.read(ADMIN_ROOT,'protected-overlay.geojson'),envelopes=new Map(p0All.features.map(f=>[f.properties.countryId,f.geometry])),selected=[];
 for(const f of administrative.features){const countryId=f.properties.sourceCountryId;if(!wanted.has(countryId))continue;const geometry=prepareAdministrativeParent(f.geometry,envelopes.get(countryId),f.properties);if(!geometry)throw Error(`Source identity is outside its P0 envelope: ${f.properties.sourceFeatureId}`);selected.push({type:'Feature',properties:{...f.properties,countryId,inputRole:'P1'},geometry});}
 for(const f of residuals.features){const countryId=f.properties.countryId;if(wanted.has(countryId))selected.push({type:'Feature',properties:{...f.properties,countryId,sourceFeatureId:`country-envelope:${f.properties.residualId}`,inputRole:'P0R'},geometry:normalizeGeometry(f.geometry)});}
 selected.sort((a,b)=>a.properties.countryId.localeCompare(b.properties.countryId)||String(a.properties.sourceFeatureId).localeCompare(String(b.properties.sourceFeatureId)));
 const oldTerritories=new Map(countryIds.map(c=>[c,[]])),land=new Map(countryIds.map(c=>[c,[]]));
 for(const f of protectedOverlay.features){const c=f.properties.sourceCountryId;if(wanted.has(c))oldTerritories.get(c).push({id:f.properties.territoryId,geometry:f.geometry,sourceFeatureIds:[]});}
 for(const e of topology.edges){if(e.boundaryClass!=='country'||!e.rightTerritoryId)continue;const owners=[countries.get(e.leftTerritoryId),countries.get(e.rightTerritoryId)];for(const c of owners){if(!wanted.has(c))continue;for(let i=1;i<e.geometry.coordinates.length;i++)land.get(c).push({a:e.geometry.coordinates[i-1],b:e.geometry.coordinates[i],neighbor:owners.find(x=>x!==c)});}}
 const refinement=new Map(countryIds.map(c=>[c,land.get(c).slice()])),segmentKey=(a,b)=>JSON.stringify([a,b].sort((x,y)=>x[0]-y[0]||x[1]-y[1]));
 for(const [c,territories] of oldTerritories){const list=refinement.get(c),seen=new Set(list.map(e=>segmentKey(e.a,e.b)));for(const t of territories)for(const p of polygons(t.geometry))for(const ring of p)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],key=segmentKey(a,b);if(key===segmentKey(a,a)||seen.has(key))continue;seen.add(key);list.push({a,b,neighbor:null,protectedTerritoryId:t.id});}}
 for(const c of countryIds)if(!selected.some(f=>f.properties.countryId===c)||!envelopes.has(c))throw Error(`Unknown country ${c}`);
 return {inputs,p0:{type:'FeatureCollection',features:p0All.features.filter(f=>wanted.has(f.properties.countryId))},selected:{type:'FeatureCollection',features:selected},land,refinement,oldTerritories,sourceVersion:provenance.sourceVersion,protectOldBoundaries:true,protectedOverlay,pins:{candidate,scope:'isolated-country-regeneration-proof',worldAdmission:false}};
}
