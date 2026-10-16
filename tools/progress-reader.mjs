import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const page = nonce => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>progress.txt · 진행 상황</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#17202b;font:14px system-ui,sans-serif}header{position:sticky;top:0;background:#fff;border-bottom:1px solid #d9dee5;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:17px;margin:0}#status{font-size:12px;color:#586576}main{max-width:1100px;margin:auto;padding:18px}pre{margin:0;background:#fff;border:1px solid #d9dee5;border-radius:8px;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 Consolas,monospace}form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}input{flex:1;min-width:180px;padding:10px;border:1px solid #aeb9c8;border-radius:5px}button{padding:10px 16px;border:0;border-radius:5px;background:#245cbb;color:white}p{color:#586576;font-size:12px}@media(max-width:600px){header,main{padding:12px}pre{padding:12px;font-size:12px}}</style>
<style nonce="${nonce}">[hidden]{display:none!important}</style>
<header><h1>progress.txt</h1><span id="status" role="status">접속 확인 중</span></header><main><form id="login"><input id="key" type="password" placeholder="접속 키" aria-label="접속 키" autocomplete="off"><button>열기</button></form><p>약 5초마다 자동 갱신 · 개인 접속 링크를 즐겨찾기에 보관하세요.</p><pre id="content">접속 키를 입력하면 진행 상황을 표시합니다.</pre></main>
<script nonce="${nonce}">
const form=document.getElementById('login'),content=document.getElementById('content'),status=document.getElementById('status');
let key=new URLSearchParams(location.hash.slice(1)).get('key')||sessionStorage.getItem('progress-key')||'',timer;
async function update(){clearTimeout(timer);if(!key){status.textContent='접속 키 필요';return}try{const response=await fetch('/progress.txt',{headers:{Authorization:'Bearer '+key},cache:'no-store',signal:AbortSignal.timeout(12000)});if(response.status===401){form.hidden=false;status.textContent='접속 키를 확인하세요';return}if(!response.ok)throw Error('unavailable');content.textContent=await response.text();form.hidden=true;sessionStorage.setItem('progress-key',key);status.textContent='갱신 '+new Date().toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});}catch{status.textContent='연결 확인 중 · 마지막 내용 유지'}timer=setTimeout(update,5000)}
form.addEventListener('submit',event=>{event.preventDefault();key=document.getElementById('key').value.trim();location.hash='key='+encodeURIComponent(key);update()});update();
</script></html>`;

export function createProgressReader({file, token}) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Error('A strong access key is required');
  const fixedFile = path.resolve(file);
  if (path.basename(fixedFile) !== 'progress.txt') throw Error('Only progress.txt can be served');
  const expected = Buffer.from(`Bearer ${token}`);
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('X-Frame-Options', 'DENY');
    const route = new URL(request.url, 'http://localhost').pathname;
    if (!['GET', 'HEAD'].includes(request.method)) {response.writeHead(405); response.end(); return;}
    if (route === '/') {
      const nonce = randomBytes(18).toString('base64');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      response.end(request.method === 'HEAD' ? undefined : page(nonce));
      return;
    }
    if (route !== '/progress.txt') {response.writeHead(404); response.end(); return;}
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {response.writeHead(401); response.end('Access key required'); return;}
    try {
      const stat = await fs.lstat(fixedFile);
      const real = await fs.realpath(fixedFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || real.toLowerCase() !== fixedFile.toLowerCase()) throw Error('Invalid progress file');
      const data = await fs.readFile(fixedFile);
      response.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8', 'Last-Modified': stat.mtime.toUTCString()});
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {response.writeHead(503); response.end('Progress is temporarily unavailable');}
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = path.join(root, '.tmp/progress-remote');
  const latest = JSON.parse(await fs.readFile(path.join(root, 'reports/prompt15/orchestration/latest.json'), 'utf8'));
  const file = path.join(latest.directory, 'progress.txt');
  const relative = path.relative(path.join(root, 'reports/prompt15/orchestration'), file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw Error('Progress must stay in this workspace');
  await fs.mkdir(scratch, {recursive: true});
  const tokenFile = path.join(scratch, 'access-key.txt');
  let token;
  try {token = (await fs.readFile(tokenFile, 'utf8')).trim();}
  catch (error) {if (error.code !== 'ENOENT') throw error; token = randomBytes(32).toString('base64url'); await fs.writeFile(tokenFile, token, {mode: 0o600, flag: 'wx'});}
  const server = createProgressReader({file, token});
  const port = 8766;
  server.listen(port, '127.0.0.1', async () => {
    await fs.writeFile(path.join(scratch, 'reader.json'), JSON.stringify({pid: process.pid, port, file, startedAt: new Date().toISOString()}, null, 2));
    console.log(`Progress reader ready on 127.0.0.1:${port}`);
  });
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
