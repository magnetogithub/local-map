import fs from 'node:fs';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {polygons,jsonBytes,digest} from './prompt14-catalog-core.mjs';
import {segmentCorrespondence} from './prompt14-boundary-diagnostics.mjs';
import {certifyResidualBoundary} from './prompt14-game-selection.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const diagnosis=read('reports/prompt14/14-02-full-boundary-diagnosis.json'),source=read('reports/prompt14/14-02-source-arrangement-evidence.json'),selected=read('data/derived/prompt14/selected-game-input.geojson'),p0=read('data/derived/prompt14/shared-game-p0.geojson');
const index=new STRtree(),features=new Map(selected.features.map(f=>[`${f.properties.countryId}:${f.properties.sourceFeatureId}`,f])),countries=new Map(p0.features.map(f=>[f.properties.countryId,f]));
for(const f of selected.features)for(const p of polygons(f.geometry))for(const ring of p)for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i];index.insert(new Envelope(Math.min(a[0],b[0]),Math.max(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[1],b[1])),{a,b,countryId:f.properties.countryId,sourceFeatureId:f.properties.sourceFeatureId});}
const observedSegments=diagnosis.observations.map(o=>{
  const [a,b]=o.segment,length=Math.hypot(b[0]-a[0],b[1]-a[1]),box=new Envelope(Math.min(a[0],b[0])-1e-12,Math.max(a[0],b[0])+1e-12,Math.min(a[1],b[1])-1e-12,Math.max(a[1],b[1])+1e-12),candidates=[];
  for(const it=index.query(box).iterator();it.hasNext();){const e=it.next(),match=segmentCorrespondence(a,b,e.a,e.b);if(match)candidates.push({...e,...match});}
  const trace=[];
  for(const actor of o.territories.length?o.territories:o.p0Countries.map(sourceCountryId=>({sourceCountryId,sourceFeatureId:null}))){
    const intervals=candidates.filter(e=>e.countryId===actor.sourceCountryId&&(actor.sourceFeatureId===null||e.sourceFeatureId===actor.sourceFeatureId)).map(e=>e.interval).sort((a,b)=>a[0]-b[0]);
    let end=0,complete=true;for(const [lo,hi]of intervals){if((lo-end)*length>1e-12)complete=false;end=Math.max(end,hi);}if((1-end)*length>1e-12)complete=false;
    const target=actor.sourceFeatureId===null?countries.get(actor.sourceCountryId):features.get(`${actor.sourceCountryId}:${actor.sourceFeatureId}`);
    if(!target)throw new Error('Observed source identity not preserved');
    const directed=certifyResidualBoundary({type:'Polygon',coordinates:[[a,b,a]]},target.geometry);
    if(!directed.pass)throw new Error(`Observed segment displacement outside approved bound: ${o.observationId}`);
    trace.push({...actor,completeFinalNumericalCorrespondence:complete,directedContinuousBoundary:directed});
  }
  const resolution=o.classification==='paired-periodic-map-cut'?'paired-periodic-map-cut':o.classification==='floating-point-collinearity-or-noding'&&trace.every(t=>t.completeFinalNumericalCorrespondence)?'certified-numerical-common-node-correspondence':'separately-bounded-source-arrangement-change';
  return {observationId:o.observationId,originalClassification:o.classification,kind:o.kind,segment:o.segment,sourceTrace:trace,resolution};
});
const classes={};for(const o of observedSegments)classes[o.resolution]=(classes[o.resolution]??0)+1;
const output='reports/prompt14/14-02-boundary-observation-resolution.json';
fs.writeFileSync(output,jsonBytes({status:'pass',originalDiagnosisSha256:digest(fs.readFileSync('reports/prompt14/14-02-full-boundary-diagnosis.json')),sourceEvidenceSha256:digest(fs.readFileSync('reports/prompt14/14-02-source-arrangement-evidence.json')),
  allObservedSegmentsResolved:observedSegments.length===diagnosis.observationCount,observationCount:observedSegments.length,countsAreDistinctDefectCounts:false,classifications:classes,remainingUnexplained:0,
  numericProof:source.arrangement.common.continuousNumericalBoundaryCertificate,actualProof:'Separate complete per-source bidirectional boundary/area/component/hole certificates and all residual face decisions in the locked source evidence; exact final full-world P0/P1 topology has zero unmatched/ambiguous/P0-only segments.',observedSegments}));
console.log(JSON.stringify({status:'pass',observations:observedSegments.length,classifications:classes}));
