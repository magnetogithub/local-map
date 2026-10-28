import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {polygons,normalizeGeometry,digest,jsonBytes} from './prompt14-catalog-core.mjs';
import {physicalMetrics} from './prompt15-cell-physical.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
export const LEGACY_SLIVER_RULE='prompt15-cell-experiment-v6';
export const ELIGIBLE_SLIVER_RULE='prompt15-sliver-evaluation-rule-v2';
export const sliverSummary=r=>({raw:r.raw,sourceTiny:r.sourceTiny,nonSourceTiny:r.nonSourceTiny,reasons:r.reasons,legacy:r.legacy,eligibleV2:r.eligibleV2,errors:r.errors});
const hash=g=>digest(jsonBytes(normalizeGeometry(g))),sum=values=>values.reduce((a,b)=>a+b,0);
export function computeSliverDistributions(measured){
 const sliver=m=>m.areaKm2<POLICY.sliver.areaKm2||m.aspectRatio>POLICY.sliver.aspectRatio,all=measured,eligible=all.filter(m=>!m.sourceTiny),tiny=all.filter(m=>m.sourceTiny),bad=all.filter(sliver),eligibleBad=eligible.filter(sliver),totalArea=sum(all.map(m=>m.areaKm2)),eligibleArea=sum(eligible.map(m=>m.areaKm2)),rawArea=sum(bad.map(m=>m.areaKm2)),eligibleSliverArea=sum(eligibleBad.map(m=>m.areaKm2)),empty=!all.length||!(totalArea>0),ratio=(n,d)=>d>0?n/d:0;
 const count={numerator:eligibleBad.length,denominator:eligible.length,ratio:ratio(eligibleBad.length,eligible.length)},raw={cells:all.length,areaKm2:totalArea,slivers:bad.length,sliverAreaKm2:rawArea,countRatio:ratio(bad.length,all.length),areaRatio:ratio(rawArea,totalArea)},sourceTiny={cells:tiny.length,areaKm2:sum(tiny.map(m=>m.areaKm2))},nonSourceTiny={cells:eligible.length,areaKm2:eligibleArea},legacyArea={numerator:rawArea,denominator:totalArea,ratio:raw.areaRatio},v2Area={numerator:eligibleSliverArea,denominator:eligibleArea,ratio:ratio(eligibleSliverArea,eligibleArea)};
 const score=(rule,area)=>({rule,count,area,applicability:eligible.length?'APPLICABLE':empty?'INVALID_EMPTY_INPUT':rule===LEGACY_SLIVER_RULE?'AREA_APPLICABLE_COUNT_NOT_APPLICABLE':'NOT_APPLICABLE',reason:eligible.length?null:empty?'EMPTY_OR_NONPOSITIVE_INPUT':rule===LEGACY_SLIVER_RULE?'NO_ELIGIBLE_CELLS_RAW_AREA_STILL_APPLIES':'ALL_SOURCE_COMPONENTS_TINY',pass:!empty&&count.ratio<=POLICY.sliver.maximumNonSourceTinyCellFraction&&area.ratio<=POLICY.sliver.maximumSliverAreaFraction});
 return {raw,sourceTiny,nonSourceTiny,reasons:{areaOnly:bad.filter(m=>m.areaKm2<POLICY.sliver.areaKm2&&m.aspectRatio<=POLICY.sliver.aspectRatio).length,aspectOnly:bad.filter(m=>m.areaKm2>=POLICY.sliver.areaKm2&&m.aspectRatio>POLICY.sliver.aspectRatio).length,both:bad.filter(m=>m.areaKm2<POLICY.sliver.areaKm2&&m.aspectRatio>POLICY.sliver.aspectRatio).length},legacy:score(LEGACY_SLIVER_RULE,legacyArea),eligibleV2:score(ELIGIBLE_SLIVER_RULE,v2Area)};
}
export function evaluateCellSlivers(cells,parents){
 const reader=new GeoJSONReader(),components=new Map(),errors=[],proofs=[];
 for(const p of parents){
  const parentHash=hash(p.geometry);if(p.expectedGeometryHash&&p.expectedGeometryHash!==parentHash)throw Error(`Sliver parent pin mismatch ${p.parentKey}`);
  if(!new IsValidOp(reader.read(p.geometry)).isValid())throw Error(`Invalid sliver source ${p.parentKey}`);
  for(const [componentIndex,coordinates] of polygons(p.geometry).entries()){
   const geometry=normalizeGeometry({type:'Polygon',coordinates}),metrics=physicalMetrics(geometry),proof={parentKey:p.parentKey,parentGeometryHash:parentHash,componentIndex,sourceComponentHash:hash(geometry),...metrics,sourceTiny:metrics.areaKm2<=POLICY.tinySourceComponent.maximumAreaKm2&&metrics.diameterKm<=POLICY.tinySourceComponent.maximumDiameterKm};
   const key=`${p.parentKey}:${componentIndex}`;if(components.has(key))throw Error('Duplicate sliver source component');components.set(key,proof);proofs.push(proof);
  }
 }
 const measured=[];for(const cell of cells){
  const geometry=normalizeGeometry(cell.geometry);if(polygons(geometry).length!==1||!new IsValidOp(reader.read(geometry)).isValid())throw Error(`Invalid sliver cell ${cell.id}`);
  const metrics=physicalMetrics(geometry),proof=components.get(`${cell.parentKey}:${cell.componentIndex}`),lineage=proof&&cell.sourceComponentHash===proof.sourceComponentHash;
  if(!lineage)errors.push({code:'unproven-source-component',cellId:cell.id});
  if(lineage&&Boolean(cell.sourceTiny)!==proof.sourceTiny)errors.push({code:'source-tiny-classification-mismatch',cellId:cell.id,declared:cell.sourceTiny,actual:proof.sourceTiny});
  if(!Number.isFinite(metrics.areaKm2)||!(metrics.areaKm2>0)||!Number.isFinite(metrics.aspectRatio))errors.push({code:'invalid-physical-sliver-measurement',cellId:cell.id});
  measured.push({cellId:cell.id,parentKey:cell.parentKey,componentIndex:cell.componentIndex,sourceComponentHash:cell.sourceComponentHash,...metrics,sourceTiny:Boolean(lineage&&proof.sourceTiny&&cell.sourceTiny),sliver:metrics.areaKm2<POLICY.sliver.areaKm2||metrics.aspectRatio>POLICY.sliver.aspectRatio});
 }
 const result=computeSliverDistributions(measured);result.legacy.pass&&=errors.length===0;result.eligibleV2.pass&&=errors.length===0;return {...result,errors,sourceProofs:proofs,cells:measured,scope:'sliver-only: source geometry identity/size and cell physical statistics; not whole-country preservation/topology approval'};
}
