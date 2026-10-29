// KOR ADM2 acquisition only. Existing ADM3 files and locks are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const output = 'data/raw/prompt19/KOR/geoboundaries-adm2-2020-9469f095';
const revision = '9469f09592ced973a3448cf66b6100b741b64c0d';
const base = `https://github.com/wmgeolab/geoBoundaries/raw/${revision}/releaseData/gbOpen/KOR/ADM2`;
const requests = [
  ['metadata.json', `${base}/geoBoundaries-KOR-ADM2-metaData.json`],
  ['citation-and-use.txt', `${base}/CITATION-AND-USE-geoBoundaries.txt`],
  ['source.geojson', `${base}/geoBoundaries-KOR-ADM2.geojson`],
  ['upstream-terms-of-use.html', 'https://www.citypopulation.de/en/help/termsofuse/'],
];
const receiptPath = path.join(output, 'acquisition.json');
if (fs.existsSync(receiptPath)) throw Error(`Refusing to overwrite completed acquisition: ${receiptPath}`);
fs.mkdirSync(output, {recursive: true});
const receipts = [];
for (const [file, url] of requests) {
  const target = path.join(output, file);
  if (fs.existsSync(target)) throw Error(`Refusing to overwrite acquired bytes: ${target}`);
  const response = await fetch(url, {signal: AbortSignal.timeout(90000)});
  if (!response.ok) throw Error(`Source download failed ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com')) throw Error('LFS pointer is not source data');
  if (file.endsWith('.json') || file.endsWith('.geojson')) JSON.parse(bytes);
  fs.writeFileSync(target, bytes, {flag: 'wx'});
  receipts.push({path: target.replaceAll('\\', '/'), url, finalUrl: response.url, retrievedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, contentType: response.headers.get('content-type')});
  console.log(JSON.stringify({file, byteLength: bytes.length}));
}
fs.writeFileSync(receiptPath, JSON.stringify({countryId: 'KOR', adminLevel: 2, representedYear: 2020, revision, receipts}, null, 2) + '\n', {flag: 'wx'});

