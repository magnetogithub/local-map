import fs from 'node:fs';
import {createHash} from 'node:crypto';
const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json'));
const files=['public/data/maps/country-labels-2020.geojson','public/data/maps/country-label-glyph-fills-2020.geojson','public/data/maps/country-label-glyph-outlines-2020.geojson','public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf','src/data/country-label-typography-policy-v1.json','src/data/country-label-overrides-2020.json'];
const assets=files.map(path=>{const b=fs.readFileSync(path);return {path,sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length};});
const target=`data/catalog-consumers/prompt14/${freeze.ref.catalogVersion}/label-approval.json`;
if(fs.existsSync(target))throw Error('Label approval already exists; compare identity before changing it');
fs.writeFileSync(target,JSON.stringify({schemaVersion:'catalog-label-assets-v1',catalogRef:freeze.ref,assets,policy:'Reuse unchanged validated 2020 seed placements and glyph geometry; changed owned-country geometry uses the same bounded server layout/typography functions.'},null,2));
console.log(JSON.stringify({target,assets}));
