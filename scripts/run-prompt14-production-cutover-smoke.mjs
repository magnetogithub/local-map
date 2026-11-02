import {spawn} from 'node:child_process';
const port=process.argv[2]??'3140',output=process.argv[3]??'.tmp/prompt14-cutover/browser';
if(!/^\d{4,5}$/.test(port)||Number(port)>65535)throw new Error('Invalid smoke port');
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',port],{windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';
server.stdout.on('data',b=>{log+=b;});server.stderr.on('data',b=>{log+=b;});
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Next readiness timeout: ${log}`)),30000);server.stdout.on('data',b=>{if(String(b).includes('Ready')){clearTimeout(timer);resolve();}});server.once('error',e=>{clearTimeout(timer);reject(e);});server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Next exited (${code}): ${log}`));});});
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/smoke-prompt14-production-cutover.mjs',`http://127.0.0.1:${port}`,output],{windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)throw new Error(`Production cutover smoke failed (${code})`);
}finally{server.kill();}
