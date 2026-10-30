// Compact, byte-pinned runtime projection of an independently accepted presentation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const option=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('MISSING:'+name);return process.argv[i+1];};
const digest=b=>createHash('sha256').update(b).digest('hex');
const pin=file=>{const b=fs.readFileSync(file);return{path:file.replaceAll('\\','/'),sha256:digest(b),byteLength:b.length};};
const artifact=pin(option('--artifact')), verification=pin(option('--verification'));
const full=JSON.parse(fs.readFileSync(artifact.path)), proof=JSON.parse(fs.readFileSync(verification.path));
if(proof.pass!==true||proof.artifact?.path!==artifact.path||proof.artifact?.sha256!==artifact.sha256||proof.artifact?.byteLength!==artifact.byteLength)throw Error('PRESENTATION_NOT_ACCEPTED');
if(full.schemaVersion!=='chn-province-presentation-v1'||full.administrativeTruthClaim!==false||full.countryId!=='CHN')throw Error('INVALID_PRESENTATION');
for(const p of Object.values(full.inputs)){const actual=pin(p.path);if(actual.sha256!==p.sha256||actual.byteLength!==p.byteLength)throw Error('STALE_INPUT:'+p.path);}
const value={schemaVersion:full.schemaVersion,countryId:full.countryId,administrativeTruthClaim:false,catalogRef:full.catalogRef,
  acceptedPresentation:artifact,independentVerification:verification,code:pin('scripts/chn-2020/write-province-runtime-index.mjs'),
  inputs:{metadata:full.inputs.metadata,parents:full.inputs.parents,incidence:full.inputs.incidence},
  provinces:full.provinces.map(({id,name})=>({id,name})),cells:full.cells,addedBoundaryOrdinals:full.addedBoundaryOrdinals};
const bytes=Buffer.from(JSON.stringify(value)+'\n'),hash=digest(bytes);
const destination=`data/derived/chn-2020/province-render-${hash.slice(0,20)}/index.json`;
fs.mkdirSync(path.dirname(destination),{recursive:true});
if(fs.existsSync(destination)){if(!fs.readFileSync(destination).equals(bytes))throw Error('IMMUTABLE_INDEX_CHANGED');}
else fs.writeFileSync(destination,bytes,{flag:'wx'});
console.log(JSON.stringify({artifact:pin(destination),acceptedPresentation:artifact,independentVerification:verification}));
