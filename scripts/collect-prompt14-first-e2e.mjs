import fs from 'node:fs';
const root='reports/prompt14/final-validation',bytes=fs.readFileSync(`${root}/e2e-first.log`);
const text=bytes.toString(bytes[0]===255?'utf16le':'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
const start=text.indexOf('{\n  "config"');if(start<0)throw Error('No Playwright JSON report in completed log');
const report=JSON.parse(text.slice(start));fs.writeFileSync(`${root}/e2e.json`,JSON.stringify(report,null,2));
const exitCode=Number(fs.readFileSync(`${root}/e2e-first.exit`,'utf16le').replace(/^\uFEFF/,'').trim());
fs.appendFileSync(`${root}/commands.jsonl`,JSON.stringify({stage:'e2e',command:'node scripts/run-playwright-e2e.mjs --reporter=json',environment:{PLAYWRIGHT_CHROMIUM_CHANNEL:'chrome'},startedAt:report.stats.startTime,durationMs:report.stats.duration,exitCode,log:`${root}/e2e-first.log`,report:`${root}/e2e.json`})+'\n');
console.log(JSON.stringify(report.stats));if(exitCode)process.exitCode=exitCode;
