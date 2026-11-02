import {spawn} from 'node:child_process';
const port=process.argv[2]??'3139',output=process.argv[3]??'.tmp/prompt14-consumer/http-smoke';
if(!/^\d{4,5}$/.test(port)||Number(port)>65535)throw new Error('Invalid local smoke port');
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',port],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',chunk=>{log+=chunk;});server.stderr.on('data',chunk=>{log+=chunk;});
try{
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`Local Next readiness timeout: ${log}`)),30000);
    const ready=chunk=>{if(String(chunk).includes('Ready')){clearTimeout(timeout);resolve();}};
    server.stdout.on('data',ready);server.once('error',e=>{clearTimeout(timeout);reject(e);});server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Next exited before readiness (${code}): ${log}`));});
  });
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/smoke-prompt14-catalog-consumer.mjs',`http://127.0.0.1:${port}`,output],{windowsHide:true,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>resolve(code));
  });
  if(result!==0)throw new Error(`Catalog HTTP smoke failed (${result})`);
}finally{server.kill();}
