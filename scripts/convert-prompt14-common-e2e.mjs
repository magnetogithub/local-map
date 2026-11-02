import fs from 'node:fs';
for(const file of ['game-setup.spec.ts','prompt11-10.spec.ts','prompt12-simulation.spec.ts','prompt13-integration.spec.ts','prompt13-shell.spec.ts']){
 const p=`e2e/${file}`,s=fs.readFileSync(p,'utf8');fs.writeFileSync(p,s.replaceAll('"./legacy-fixture"','"./catalog-fixture"'));
}
const p='e2e/game-setup.spec.ts';let s=fs.readFileSync(p,'utf8');
s=`import {test as legacyTest} from './legacy-fixture';\n${s}`;
for(const title of ['renders dynamic labels, global Admin 1, high-resolution interaction, and world copies','dissolved seams select parents and do not render border layers'])s=s.replace(`test("${title}"`, `legacyTest("${title}"`);
s=s.replaceAll('window.__PAX_MAP_DEBUG__?.getPlayerFilter()',"window.__PAX_CATALOG_DEBUG__?.getSnapshot().playerCountryId");
s=s.replace('for(const [query,id,name] of [[','for(const [query,id,name] of [[');
s=s.replace(']]){await search.fill(query);',']]){await page.goto("/");await search.fill(query);');
fs.writeFileSync(p,s);
