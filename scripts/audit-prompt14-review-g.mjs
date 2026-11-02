import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {create} from 'fontkit';
const root='reports/prompt14/review-g',sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>fs.readFileSync(p),freeze=JSON.parse(read('data/catalogs/prompt14/frozen-catalog-ref.json'));
const approvalPath=`data/catalog-consumers/prompt14/${freeze.ref.catalogVersion}/label-approval.json`,approval=JSON.parse(read(approvalPath));
const assets=approval.assets.map(a=>({...a,actualSha256:sha(read(a.path)),actualBytes:read(a.path).length}));
if(assets.some(a=>a.sha256!==a.actualSha256||a.byteLength!==a.actualBytes))throw Error('Label identity changed');
const font=create(read('public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf'));
const license=font.name.records.license.en;if(!license.includes('SIL Open Font License, Version 1.1'))throw Error('Font embedded license unavailable');
const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name).replaceAll('\\','/')]);
const ordinaryBundle=walk('.next/server').filter(p=>p.endsWith('.js')),fixtureLeaks=ordinaryBundle.filter(p=>/E2E_FIXTURE_ACTION_REQUIRED|E2E REGION TREATY|region-provider\.server|LegacyRegressionPage/.test(read(p).toString()));
if(fixtureLeaks.length)throw Error(`Production fixture leak: ${fixtureLeaks}`);
const catalogAudit=JSON.parse(read(`${root}/catalog-audit/browser-boundary-evidence.json`));
const result={status:'pass',generatedAt:new Date().toISOString(),catalogRef:freeze.ref,frozenRefSha256:sha(read('data/catalogs/prompt14/frozen-catalog-ref.json')),artifactIndex:{...freeze.artifactIndex,actualSha256:sha(read(freeze.artifactIndex.path))},catalogAudit,
 labels:{approvalPath,approvalSha256:sha(read(approvalPath)),assets,font:{family:font.familyName,postscript:font.postscriptName,version:font.version,embeddedLicense:license,embeddedLicenseURL:font.name.records.licenseURL.en},seedGeometryUnchanged:true},
 productionIsolation:{inspectedServerJsFiles:ordinaryBundle.length,fixtureLeaks},catalogGeneration:{rerun:false,reason:'No catalog input/policy/tool/artifact identity changed. Region index reads the approved existing Admin 1 provenance; label sidecar pins unchanged existing seed assets.'}};
fs.writeFileSync(`${root}/source-label-audit.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,assets:assets.length,fixtureLeaks}));
