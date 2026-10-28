import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {A,W,I,D,CLOSE,REVIEW,assert,same,id,preparedSources} from './prompt15-sliver-preservation-evidence.mjs';
import {normalizeGeometry,polygons,digest,jsonBytes,hashCanonical} from './prompt14-catalog-core.mjs';
import {geometryHash,shape,intersection,physicalMetrics,previousRepairLedgerRoot} from './prompt15-preservation-audit-core.mjs';
import {validateBindings} from './prompt15-sliver-delivery-adapter.mjs';
export function validateParentTransport(membership,kind,delivered,binary,transport){
 assert(binary.length===membership.cellOrdinals.length*4&&transport.recordBytes===4&&transport.recordCount===membership.cellOrdinals.length&&!transport.partial,'Membership binary contract');
 assert(delivered.length===membership.parents.length,'Parent directory census');
 for(const [i,p] of membership.parents.entries()){
  const row=delivered[i],{historicalParent,...descriptor}=p;
  assert(row.ordinal===i+1&&same(row.descriptor,descriptor)&&row.currentMembership.count===p.count&&row.currentMembership.start===p.start&&same(row.currentMembership.artifact,transport),'Current parent descriptor/count/transport');
  assert(same(row.historicalGeneration,historicalParent?{cellCount:historicalParent.cellCount,parentHash:historicalParent.parentHash,role:'PAST_EVIDENCE_ONLY; current count is currentMembership.count; no new generation PASS'}:null),'Historical count misrepresented as current count');
  for(let j=p.start;j<p.start+p.count;j++)assert(binary.readUInt32LE(j*4)===membership.cellOrdinals[j],`${kind} binary reverse membership at ${j}`);
 }
}
export function buildContext(inputs,countries,output,progress=console.log){
 const read=inputs.indexed,selected=new Set(countries),order=read(I,'catalog-order.json.gz'),admin=read(I,'administrative-membership.json.gz'),previous=read(I,'previous-parent-index.json.gz'),indexRoot=read(I,'index-root.json'),manifest=read(D,'manifest.json'),detail=read(D,'detail-index.json');
 validateBindings(order,admin,previous);assert(digest(jsonBytes(order.cells.map(c=>c.id)))===indexRoot.roots.catalogOrder,'Actual catalog-order root');
 const deliveryParents=read(D,'metadata/parents.json.gz');
 for(const [kind,m] of [['administrative',admin],['previous',previous]]){
  const t=detail.membership[kind];assert(t.source.root===I&&same(t.source.artifact,inputs.indexes.get(I).get(kind==='administrative'?'administrative-membership.json.gz':'previous-parent-index.json.gz')),'Membership source binding');
  validateParentTransport(m,kind,deliveryParents[kind],gunzipSync(read(D,t.path,true)),t);
 }
 const cellMeta=o=>Number.isSafeInteger(o)&&o>0?order.cells[o-1]:undefined,ordinalById=new Map(order.cells.map((c,i)=>[c.id,i+1]));
 const edgeFiles=new Map(countries.map(c=>[c,path.join(output,'topology-inputs',`${c}.ndjson`)]));fs.mkdirSync(path.join(output,'topology-inputs'));
 for(const file of edgeFiles.values())fs.writeFileSync(file,'',{flag:'wx'});
 const binary=gunzipSync(read(D,'metadata/edge-incidence.bin.gz',true));assert(binary.length===indexRoot.counts.edges*8,'Incidence byte length');
 for(const [n,shard] of indexRoot.topologyShards.entries()){
  const source=read(I,shard),delivered=read(D,`detail/${shard}`),buffers=new Map(countries.map(c=>[c,[]]));
  assert(delivered.schemaVersion===manifest.schemaVersion&&delivered.sourceSchemaVersion===source.schemaVersion&&source.edges.length===delivered.edges.length,'Topology transport schema');
  for(const [j,e] of source.edges.entries()){
   const left=cellMeta(e.left),right=e.right?cellMeta(e.right):null;assert(left&&(!e.right||right),'Topology context reference');
   const relevant=[...new Set([left.sourceCountryId,right?.sourceCountryId].filter(c=>selected.has(c)))];if(!relevant.length)continue;
   const {lengthKm,...expected}=e;assert(same(expected,delivered.edges[j]),`Delivered topology changed ${e.ordinal}`);
   const off=(e.ordinal-1)*8;assert(binary.readUInt32LE(off)===e.left&&binary.readUInt32LE(off+4)===e.right,`Binary incidence changed ${e.ordinal}`);
   for(const c of relevant)buffers.get(c).push(JSON.stringify(e)+'\n');
  }
  for(const [c,lines] of buffers)if(lines.length)fs.appendFileSync(edgeFiles.get(c),lines.join(''));
  if(n%32===0)progress(`[incident topology ${n+1}/${indexRoot.topologyShards.length}]`);
 }
 const edgePins=new Map([...edgeFiles].map(([c,f])=>[c,id(f)]));
 const csr=read(I,'adjacency.json.gz'),adjacency=new Map();assert(csr.cellCount===order.cells.length&&csr.offsets.length===order.cells.length+1,'Adjacency CSR');
 for(const c of order.cells)if(selected.has(c.sourceCountryId))adjacency.set(c.ordinal,csr.neighbors.slice(csr.offsets[c.ordinal-1],csr.offsets[c.ordinal]));
 const provenance=read(A,'provenance.json'),external=p=>{const pin=provenance.inputs.find(v=>v.path.replaceAll('\\','/')===p);assert(pin,`Missing source pin ${p}`);return inputs.read(p,pin);};
 const raw=external('data/raw/ne_10m_admin_1_states_provinces.geojson'),prepared=external('data/derived/prompt14/shared-admin1-input.geojson'),envelopes=external('data/derived/prompt14/shared-game-p0.geojson');
 const traces=read(A,'source-identity-trace.json').filter(t=>selected.has(t.sourceCountryId)),sourceIds=new Set(traces.map(t=>t.source.identity));
 const routed=preparedSources(inputs,provenance,prepared.features,traces);
 const adoption=inputs.read(`${CLOSE}/adoption-manifest.json`),baseline=path.posix.dirname(adoption.baseArtifactIndexes.catalog.path),oldI=path.posix.dirname(adoption.baseArtifactIndexes.indices.path);
 const baselineIndex=inputs.read(`${baseline}/artifact-index.json`,adoption.baseArtifactIndexes.catalog),baselineFiles=new Map(baselineIndex.artifacts.map(p=>[p.path,p]));
 const oldIndex=inputs.read(`${oldI}/artifact-index.json`,adoption.baseArtifactIndexes.indices),oldMap=new Map(oldIndex.artifacts.map(p=>[p.path,p]));
 const oldRead=n=>{const b=inputs.bytes(`${oldI}/${n}`,oldMap.get(n));return JSON.parse(n.endsWith('.gz')?gunzipSync(b):b);};
 const oldPrevious=oldRead('previous-parent-index.json.gz'),oldApproval=oldRead('topology-validation.json');
 const admission=inputs.read('reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/admitted/verdict.json'),v20pin=admission.upstreamReceipts.v20,historicalV20=inputs.read(v20pin.path,v20pin);
 assert(historicalV20.status==='pass'&&historicalV20.root===oldI&&same(historicalV20.membership.unionEvidence,oldApproval.membership.unionEvidence),'Historical V20 source evidence binding');
 oldApproval.independent={status:historicalV20.status,checks:historicalV20.checks};
 const repairRoot=oldApproval.numericalBoundaryRepairs;assert(repairRoot.count===repairRoot.items.length&&hashCanonical('prompt15-task-15-20-numerical-boundary-repairs.v1',repairRoot.items)===repairRoot.root,'Historical repair witness root');
 const witnessOrdinals=new Set(repairRoot.items.flatMap(w=>[w.owner,w.otherOwner]).filter(Boolean));
 const oldCells=oldRead('catalog-order.json.gz').cells,oldWitnessCells=new Map([...witnessOrdinals].map(o=>[o,oldCells[o-1]]));
 const reconciliation=inputs.read('reports/prompt15/15-20-sliver-adoption/20261028-indices-6084b5f890/ledger-reference-reconciliation.json');assert(reconciliation.status==='PASS'&&reconciliation.noAreaDeltaReapplied,'Repair references reconciled without applying deltas');
 const receipts=read(I,'historical-repair-receipts.json');
 return {order:order.cells,admin,previous,manifest,detail,indexRoot,cellMeta,ordinalById,edgeFiles,edgePins,adjacency,rawById:new Map(raw.features.filter(f=>sourceIds.has(String(f.properties.ne_id))).map(f=>[String(f.properties.ne_id),f])),preparedById:routed.byId,preparedEvidence:routed.receipt,historicalReplayCodePins:routed.historicalCode,envelopeById:new Map(envelopes.features.filter(f=>selected.has(f.properties.countryId)).map(f=>[f.properties.countryId,f.geometry])),traces,restored:read(A,'administrative-restoration.geojson').features.filter(f=>selected.has(f.properties.sourceCountryId)),residuals:read(A,'residuals.geojson').features.filter(f=>selected.has(f.properties.countryId)),protected:read(A,'protected-overlay.geojson').features.filter(f=>selected.has(f.properties.sourceCountryId)),protectedTraces:read(A,'protected-overlay-trace.json').filter(t=>selected.has(t.sourceCountryId)),adoption,baseline,baselineFiles,oldPrevious,oldApproval,oldWitnessCells,repairReceipts:receipts,reconciliation};
}
export function previousEvidence(inputs,ctx,country,entries,history,assembly){
 // Only exact unchanged selected geometry may reuse a historical metric receipt.
 if(!assembly.catalogAndGeometryByteIdenticalToBaseline)return undefined;
 const ledger=[...(history.numericalProtectedFragmentRepairs??[]).map(r=>({countryId:country,ledger:'protected',...r})),...(history.numericalCellRepairs??[]).map(r=>({countryId:country,ledger:'cell',...r})),...(history.topologySourceRepairs??[]).map(r=>({countryId:country,ledger:'topology-source',...r}))];
 const historicalReceipts=ctx.repairReceipts.receipts.filter(r=>r.countryId===country);
 assert(historicalReceipts.length===ledger.length,'Complete historical repair ledger receipt set');
 for(const item of ledger){const {countryId,ledger:kind,...record}=item,evidenceId=hashCanonical('prompt15-historical-repair-receipt.v1',{countryId,ledger:kind,record}),receipt=historicalReceipts.find(r=>r.evidenceId===evidenceId);assert(receipt&&same(receipt.originalRecord,record),'Historical repair record identity');for(const ref of receipt.cellReferences){assert(entries.some(c=>c.id===ref.selectedCellId)&&ctx.reconciliation.references.some(r=>r.evidenceId===evidenceId&&r.historicalCellId===ref.originalCellId&&r.selectedCellId===ref.selectedCellId),'Repair cell reference reconciliation');}}
 const byId=new Map(entries.map(e=>[e.id,e])),protectedById=new Map(ctx.protected.map(f=>[f.properties.territoryId,f])),out=new Map();
 const at=oldOrdinal=>{const old=ctx.oldWitnessCells.get(oldOrdinal),entry=byId.get(old?.id),ordinal=ctx.ordinalById.get(old?.id);assert(entry&&ordinal&&['sourceCountryId','parentKey','oldTerritoryId','sourceComponentHash'].every(k=>entry[k]===old[k]),'Historical witness cell/parent/component correspondence');return {ordinal,id:entry.id,sourceCountryId:country,parentKey:entry.parentKey,oldTerritoryId:entry.oldTerritoryId,sourceComponentHash:entry.sourceComponentHash};};
 for(const descriptor of ctx.oldPrevious.parents.filter(p=>p.sourceCountryId===country)){
  const oldTerritoryId=descriptor.oldTerritoryId,relevant=ledger.filter(r=>[r.oldTerritoryId,r.sourceOldTerritoryId,r.assignedOldTerritoryId].includes(oldTerritoryId));
  const boundaryRepairs=ctx.oldApproval.numericalBoundaryRepairs.items.filter(w=>w.kind==='protected-fragment-transfer-boundary'&&w.otherOwner&&w.assignedPass&&[w.sourceOldTerritoryId,w.assignedOldTerritoryId].includes(oldTerritoryId)).map(w=>{const ownerCell=at(w.owner),oppositeCell=at(w.otherOwner);return {...w,historicalOwner:w.owner,historicalOtherOwner:w.otherOwner,owner:ownerCell.ordinal,otherOwner:oppositeCell.ordinal,ownerCell,oppositeCell,protectedSources:[protectedById.get(w.sourceOldTerritoryId),protectedById.get(w.assignedOldTerritoryId)]};});
  out.set(oldTerritoryId,{countryId:country,oldTerritoryId,descriptor,ledger:relevant,ledgerRoot:previousRepairLedgerRoot(relevant),approval:{status:ctx.oldApproval.status,checks:ctx.oldApproval.checks,policy:ctx.oldApproval.policy,independent:ctx.oldApproval.independent},generation:{status:history.status,checks:history.checks,maximumNodedSegmentDisplacement:history.numericalNoding?.maximumNodedSegmentDisplacement},boundaryRepairs,evidenceRole:'HISTORICAL_METRIC_ONLY; selected bytes unchanged; not new draft generation or V20 geometry PASS'});
 }
 return out;
}
export function assemble(inputs,ctx,country){
 const read=inputs.indexed,envelope=ctx.envelopeById.get(country),traces=ctx.traces.filter(t=>t.sourceCountryId===country),restored=ctx.restored.filter(f=>f.properties.sourceCountryId===country),parents=[],tinySourceComponents=new Set();
 assert(new Set(traces.map(t=>t.source.identity)).size===restored.length&&traces.every(t=>restored.some(f=>String(f.properties.sourceFeatureId)===t.source.identity)),'Complete restored source identity set');
 for(const trace of traces){const raw=ctx.rawById.get(trace.source.identity),prepared=ctx.preparedById.get(trace.source.identity),result=restored.find(f=>String(f.properties.sourceFeatureId)===trace.source.identity);
  assert(raw&&prepared&&result&&digest(jsonBytes(raw.geometry))===trace.source.geometrySha256&&digest(jsonBytes(prepared.geometry))===trace.source.preparedGeometrySha256&&digest(jsonBytes(result.geometry))===trace.result.geometrySha256&&same(shape(raw.geometry),trace.source.shape)&&same(shape(result.geometry),trace.result.shape)&&trace.components.length===shape(result.geometry).components,'Raw/prepared/restored lineage');
  for(const component of trace.components){const coordinates=polygons(result.geometry)[component.resultComponentIndex];assert(coordinates&&geometryHash({type:'Polygon',coordinates})===component.resultGeometrySha256&&coordinates.length-1===component.resultHoles&&component.sourceHoles<=component.resultHoles,'Source component/hole trace');}
  parents.push({parentKey:`${country}:${trace.source.identity}`,adminId:trace.source.identity,geometry:normalizeGeometry(intersection(result.geometry,envelope))});
 }
 for(const f of ctx.residuals.filter(f=>f.properties.countryId===country))parents.push({parentKey:`${country}:country-envelope:${f.properties.residualId}`,adminId:null,geometry:normalizeGeometry(f.geometry)});
 const descriptors=ctx.admin.parents.filter(p=>p.sourceCountryId===country),olds=ctx.previous.parents.filter(p=>p.sourceCountryId===country);
 for(const parent of parents){const d=descriptors.find(p=>p.parentKey===parent.parentKey);assert(d&&d.preparedGeometryHash===geometryHash(parent.geometry)&&d.historicalParent.parentHash===geometryHash(parent.geometry),'Prepared parent identity/hash');parent.expectedGeometryHash=d.preparedGeometryHash;
  for(const [i,coordinates] of polygons(parent.geometry).entries()){const m=physicalMetrics({type:'Polygon',coordinates});if(m.areaKm2<=1&&m.diameterKm<=8)tinySourceComponents.add(`${parent.parentKey}:${i}`);}
 }
 assert(parents.length===descriptors.length,'Full parent set');
 const previousParents=ctx.protected.filter(f=>f.properties.sourceCountryId===country).map(f=>{const trace=ctx.protectedTraces.find(t=>t.previousTerritoryId===f.properties.territoryId),d=olds.find(p=>p.oldTerritoryId===f.properties.territoryId);assert(trace&&d&&digest(jsonBytes(f.geometry))===trace.geometrySha256&&same(shape(f.geometry),trace.shape)&&d.approvedGeometryHash===digest(jsonBytes(f.geometry)),'Protected parent original identity/shape');return {oldTerritoryId:f.properties.territoryId,geometry:f.geometry};});
 const catalog=read(W,`countries/${country}/catalog.json.gz`),source=read(W,`countries/${country}/geometry.geojson.gz`),detail=read(D,`detail/countries/${country}.geojson.gz`),meta=read(D,`metadata/countries/${country}.json.gz`),history=read(W,`historical-generation/countries/${country}/generation.json.gz`),assembly=read(W,`countries/${country}/assembly.json`);
 inputs.bytes(`${W}/historical-generation/countries/${country}/generation.json.gz`,ctx.baselineFiles.get(`countries/${country}/generation.json.gz`));
 assert(assembly.countryId===country&&assembly.cellCount===catalog.entries.length&&history.countryId===country,'Current/historical country identity');
 if(assembly.catalogAndGeometryByteIdenticalToBaseline)for(const [n,pin] of [['catalog.json.gz',assembly.sourceCatalog],['geometry.geojson.gz',assembly.sourceGeometry]])inputs.bytes(`${W}/countries/${country}/${n}`,pin);
 const entries=new Map(catalog.entries.map(c=>[c.id,c])),byId=new Map(source.features.map(f=>[f.properties.cellId,f]));
 assert(entries.size===catalog.entries.length&&byId.size===entries.size&&detail.features.length===entries.size&&meta.rows.length===entries.size&&meta.countryId===country&&same(meta.columns,['cellOrdinal','cellId','administrativeOrdinal','previousParentOrdinal']),'Country detail/metadata full census');
 let last=0;const cells=detail.features.map((f,i)=>{const c=ctx.cellMeta(f.id),entry=entries.get(c?.id);assert(entry&&c.sourceCountryId===country&&f.id>last,'Global ordinal/country/order');last=f.id;
  assert(same(meta.rows[i],[f.id,entry.id,ctx.admin.parentOrdinalByCell[f.id-1],ctx.previous.oldParentOrdinalByCell[f.id-1]])&&same(f.geometry,byId.get(entry.id)?.geometry)&&same(f.properties,{}),'Delivered exact geometry/canonical/parent row');
  assert(['id','parentKey','oldTerritoryId','sourceComponentHash','componentIndex','parentSourceFeatureId'].every(k=>c[k]===entry[k]),'New order/source lineage');return {...entry,ordinal:f.id,geometry:f.geometry};});
 assert(cells.length===ctx.order.filter(c=>c.sourceCountryId===country).length,'Full assigned cell universe');
 const expectedCells=catalog.entries.map(c=>({...c,ordinal:ctx.ordinalById.get(c.id),geometryHash:geometryHash(byId.get(c.id).geometry)}));
 const edgeBytes=inputs.bytes(ctx.edgeFiles.get(country),ctx.edgePins.get(country)),incidentEdges=edgeBytes.toString('utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
 const membership=(ps,m)=>ps.map(p=>({...p,cellOrdinals:m.cellOrdinals.slice(p.start,p.start+p.count)}));
 return {countryId:country,envelope,parents,previousParents,cells,expectedCells,sourceIdentities:traces.map(t=>t.source.identity),administrativeMembership:membership(descriptors,ctx.admin),previousMembership:membership(olds,ctx.previous),incidentEdges,cellMeta:ctx.cellMeta,adjacency:ctx.adjacency,tinySourceComponents,previousMetricEvidence:previousEvidence(inputs,ctx,country,catalog.entries,history,assembly),assembly,historicalGeneration:history,historyRole:'PAST SOURCE/REPAIR EVIDENCE ONLY',historicalCurrentCounts:descriptors.map(d=>({parentKey:d.parentKey,current:d.count,historical:d.historicalParent.cellCount}))};
}
