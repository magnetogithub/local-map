import {spawn} from 'node:child_process';
const root='reports/prompt14/label-length',url='http://127.0.0.1:3169';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3169'],{windowsHide:true,env:{...process.env,PAX_E2E_BUILD:'0'}});
server.stderr.on('data',b=>process.stderr.write(b));server.stdout.on('data',b=>process.stdout.write(b));
try{
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Production server exited');try{if((await fetch(url+'/game')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error('Production server not ready');
 const child=spawn(process.execPath,['scripts/run-playwright-e2e.mjs','e2e/prompt14-label-length.spec.ts','--output',`${root}/production-test-results`,'--reporter=line,json'],{windowsHide:true,stdio:'inherit',env:{...process.env,PLAYWRIGHT_BASE_URL:url,PLAYWRIGHT_JSON_OUTPUT_NAME:`${root}/production-length-browser.json`,PAX_E2E_SCREENSHOT_DIR:`${root}/production-screenshots`}});
 process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code??1));});
}finally{server.kill();}
