import fs from 'node:fs';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import {commonNodeRings} from './prompt14-boundary-arrangement.mjs';
import {digest,jsonBytes} from './prompt14-catalog-core.mjs';
import {HISTORY} from './regenerate-prompt14-sources.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),source=read('reports/prompt14/14-02-source-arrangement-evidence.json');
const common=commonNodeRings(read(`${HISTORY}/data/derived/prompt14/shared-game-p0.geojson`),read(`${HISTORY}/data/derived/prompt14/selected-game-input.geojson`),console.log,source.arrangement.sharedBoundaryExtensions);
if(common.evidence.uniqueSegments!==source.arrangement.common.uniqueSegments||common.evidence.traceNodeCount!==source.arrangement.common.traceNodeCount)throw new Error('Construction replay does not match locked source evidence');
const reader=new GeoJSONReader(),writer=new GeoJSONWriter(),polygonizer=new Polygonizer();
for(const e of common.edges.values())polygonizer.add(reader.read({type:'LineString',coordinates:[e.a,e.b]}));
polygonizer.getPolygons();const tails=[];
const cmp=(a,b)=>a[0]-b[0]||a[1]-b[1],key=(a,b)=>cmp(a,b)<0?`${a[0]},${a[1]};${b[0]},${b[1]}`:`${b[0]},${b[1]};${a[0]},${a[1]}`;
for(const it=polygonizer.getDangles().iterator();it.hasNext();){const geometry=writer.write(it.next());
  for(let i=1;i<geometry.coordinates.length;i++){const segment=[geometry.coordinates[i-1],geometry.coordinates[i]],contexts=common.edges.get(key(...segment))?.contexts;
    if(!contexts?.length||contexts.some(c=>c.role!=='P1-extension'))throw new Error('A genuine source ring segment is dangling in the construction arrangement');
    tails.push({segment,contexts:contexts.map(c=>({role:c.role,countryId:c.countryId,sharedSourceFeaturePair:c.sourceFeatureId}))});
  }
}
if(tails.length!==source.arrangement.failures.dangles)throw new Error('Construction tail count differs');
fs.writeFileSync('reports/prompt14/14-02-construction-tail-proof.json',jsonBytes({status:'pass',sourceEvidenceSha256:digest(fs.readFileSync('reports/prompt14/14-02-source-arrangement-evidence.json')),
  sourceInputDanglingSegments:0,constructionExtensionTailSegments:tails.length,
  explanation:'Every Polygonizer dangle belongs exclusively to a generated open P1 continuation constraint. No original P0/P1 ring segment is dangling. These construction tails are not emitted into the locked source; its separate full topology proof has zero unmatched interior, ambiguous, or P0-only segments.',tails}));
console.log(JSON.stringify({status:'pass',sourceInputDanglingSegments:0,constructionExtensionTailSegments:tails.length}));
