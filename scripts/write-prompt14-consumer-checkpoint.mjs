import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {digest,jsonBytes,writeArtifact} from './prompt14-catalog-core.mjs';
import path from 'node:path';

const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const checksPath=option('--checks','.tmp/prompt14-consumer/completed-checks.json'),output=option('--output','reports/prompt14/14-09-catalog-consumer-preparation.json');
const baselinePath=option('--baseline','.tmp/prompt14-consumer/baseline.json');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),identity=p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};};
const commands=read(checksPath),baseline=read(baselinePath),freeze=read('data/catalogs/prompt14/frozen-catalog-ref.json'),version=freeze.ref.catalogVersion;
const tests=read(option('--tests','.tmp/prompt14-consumer/final-tests.json'));
const browser=read(option('--browser','.tmp/prompt14-consumer/final-browser/browser-boundary-evidence.json'));
const http=read(option('--http','.tmp/prompt14-consumer/final-http/http-smoke-evidence.json'));
const consumerBase=`data/catalog-consumers/prompt14/${version}`,publication=read(`${consumerBase}/publication-evidence.json`),metadata=read(`${consumerBase}/consumer-metadata.json`);
const changedBaseline=[],missingBaseline=[];
for(const [file,previous]of Object.entries(baseline.hashes)){
  if(!fs.existsSync(file)){missingBaseline.push(file);continue;}
  const current=identity(file);if(current.sha256!==previous.sha256||current.byteLength!==previous.byteLength)changedBaseline.push(file);
}
const allowedChanges=['.gitattributes','.github/workflows/prompt14-catalog.yml'];
const productionFiles=['src/components/layout/WorldAppPage.tsx','src/components/map/WorldMap.tsx','src/stores/world-state-store.ts','src/lib/world/initial-world-state-v2.ts'];
const productionDiff=spawnSync('git',['diff','--',...productionFiles],{encoding:'utf8',windowsHide:true});
const head=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});
const reviewedTypes=['src/lib/projection/country-panel-projection.ts','src/lib/projection/country-search-index-patch.ts'];
const typeOnly=reviewedTypes.every(file=>{
  const original=spawnSync('git',['show',`HEAD:${file}`],{encoding:'utf8',windowsHide:true});
  return original.status===0&&fs.readFileSync(file,'utf8').replace("state: Pick<WorldStateV2, 'revision' | 'countryOrder' | 'countriesById'>","state: WorldStateV2").replaceAll('\r\n','\n')===original.stdout.replaceAll('\r\n','\n');
});
const sourceCapitals=new Set(read('public/data/maps/capitals-2020.geojson').features.map(f=>f.properties.countryId));
const checks={
  commands:Array.isArray(commands)&&commands.length>0&&commands.every(c=>typeof c.command==='string'&&c.exitCode===0),
  realConsumerAndV2Tests:tests.success&&tests.numFailedTests===0&&tests.testResults.some(r=>r.name.endsWith('catalog-consumer.test.ts'))&&tests.testResults.some(r=>r.name.endsWith('initial-world-state-v2.test.ts')),
  approvedPublication:publication.status==='pass'&&publication.allPublishedBytesVerified&&publication.byteIdenticalArtifacts.length===3,
  browserBoundary:browser.status==='pass'&&!browser.browserBoundary.serverOrBuildOnlyDependencies&&browser.publicNamespaceContainsOnlyApprovedDelivery&&browser.independentCatalogReplay?.frozenArtifactIndexMatches===true,
  localHttpDelivery:http.status==='pass'&&http.artifacts.every(a=>a.httpStatus===200)&&http.buildOnlyRequestsRejected.every(a=>a.httpStatus===404),
  catalogRef:[publication,browser,http].every(e=>jsonBytes(e.catalogRef).equals(jsonBytes(freeze.ref))),
  reviewCPreserved:freeze.status==='pass'&&read('reports/prompt14/14-08-immutable-catalog-checkpoint.json').status==='pass'&&identity(freeze.artifactIndex.path).sha256===freeze.artifactIndex.sha256,
  originalDirtyWorkPreserved:missingBaseline.length===0&&changedBaseline.every(p=>allowedChanges.includes(p)),
  productionAuthorityPreserved:productionDiff.status===0&&!productionDiff.stdout&&head.status===0&&head.stdout.trim()===baseline.head&&typeOnly,
};
const status=Object.values(checks).every(Boolean)?'pass':'fail';
const changedFiles=[...allowedChanges,...reviewedTypes,'vitest.config.ts','src/lib/projection/catalog-map-consumer-projection.ts','src/app/api/world/catalog/route.ts',
  'src/lib/map/render-feature-ref.ts','src/lib/map/catalog-consumer-contract.ts','src/lib/map/catalog-consumer.server.ts','src/lib/map/catalog-vector-delivery.ts','src/lib/map/catalog-map-consumer.ts','src/lib/map/catalog-consumer.test.ts',
  'scripts/prepare-prompt14-catalog-consumer.mjs','scripts/publish-prompt14-catalog-consumer.mjs','scripts/verify-prompt14-catalog-consumer.mjs','scripts/smoke-prompt14-catalog-consumer.mjs','scripts/run-prompt14-catalog-consumer-http-smoke.mjs','scripts/write-prompt14-consumer-checkpoint.mjs',
  ...['consumer-metadata.json','consumer-approval.json','preparation-evidence.json','publication-evidence.json'].map(n=>`${consumerBase}/${n}`)].map(identity);
const report={schemaVersion:'prompt14-catalog-consumer-checkpoint-v1',task:'14-9',status,checks,catalogRef:freeze.ref,
  stages:{projection:status,selectionAndHover:status,labelsAndCountryPanel:status,vectorAndGeoJsonRefs:status,serverAndBrowserContract:status,unitAndIntegrationTests:status},
  sourceLock:identity('data/source-locks/prompt14-derived-game-input-lock.json'),frozenArtifactIndex:identity(freeze.artifactIndex.path),
  catalogCoverage:{territories:metadata.territories.length,countries:metadata.countries.length,capitalSeeds:sourceCapitals.size,mappedCapitals:metadata.countries.filter(c=>c.capital).length,
    missingCapitalSeeds:metadata.countries.filter(c=>!sourceCapitals.has(c.countryId)).map(c=>c.countryId),capitalSeedsOutsideLockedSourceCountry:metadata.countries.filter(c=>!c.capital&&sourceCapitals.has(c.countryId)).map(c=>c.countryId),
    capitalPolicy:'Only display capital points with build-verified containment in a canonical territory of their source country while that territory is currently owned by that country. Omitted points are never assigned to a nearest territory.'},
  consumerDelivery:{publication,browser,http,publicDirectory:`public/data/territory-catalog/${version}`,publicArtifactCount:5464,fullGeometryAndTopology:'build-only',
    tileCache:{maximumTiles:256,maximumBytes:8*1024*1024,verifiedBytesCopiedOnReturn:true},generalCameraProjectionOrGeometryHashWork:0},
  tests:{success:tests.success,files:tests.testResults.length,total:tests.numTotalTests,passed:tests.numPassedTests,failed:tests.numFailedTests,
    results:tests.testResults.map(r=>({file:r.name.replaceAll('\\','/').replace(`${process.cwd().replaceAll('\\','/')}/`,''),assertions:r.assertionResults.map(a=>({name:a.fullName,status:a.status}))}))},
  commands,changedFiles,originalInputPreservation:{baseline:baselinePath,files:Object.keys(baseline.hashes).length,changedBaseline,missingBaseline,authorizedBaselineChanges:allowedChanges},
  production:{worldSchemaVersion:2,simulationSchemaVersion:1,storeAndBootstrapChanges:false,authorityFilesVerifiedUnchanged:productionFiles,sharedHelpersChangedOnlyInTypeSignatures:typeOnly,cutover:false},
  resume:{workflow:'.github/workflows/prompt14-catalog.yml',prepare:'node scripts/prepare-prompt14-catalog-consumer.mjs <empty-output>',publish:'node scripts/publish-prompt14-catalog-consumer.mjs <first> <second>',verify:'node scripts/verify-prompt14-catalog-consumer.mjs <browser-output> <independent-catalog-output>',http:'node scripts/run-prompt14-catalog-consumer-http-smoke.mjs 3139 <http-output>'},
  subsequentTasksImplemented:[],reviewDPerformed:false};
writeArtifact(path.dirname(output),path.basename(output),jsonBytes(report));console.log(JSON.stringify({status,task:'14-9',tests:report.tests.total,output}));
if(status!=='pass')process.exitCode=1;
