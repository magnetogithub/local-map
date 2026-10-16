import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

export const MAX_LOG_BYTES = 256 * 1024;

// Drain every byte (so a noisy child cannot deadlock), but retain only a tail.
// The observed hash describes the full stream; the file hash describes the tail.
class Capture {
  constructor(limit) { this.limit = limit; this.bytes = 0; this.tail = Buffer.alloc(0); this.hash = createHash('sha256'); }
  accept(chunk) {
    this.bytes += chunk.length; this.hash.update(chunk);
    if (chunk.length >= this.limit) this.tail = Buffer.from(chunk.subarray(chunk.length - this.limit));
    else this.tail = Buffer.concat([this.tail.subarray(Math.max(0, this.tail.length + chunk.length - this.limit)), chunk]);
  }
  save(file) {
    fs.writeFileSync(file, this.tail, {flag: 'wx'});
    return {path: path.resolve(file), sha256: createHash('sha256').update(this.tail).digest('hex'), byteLength: this.tail.length,
      observedBytes: this.bytes, observedSha256: this.hash.digest('hex'), truncated: this.bytes > this.limit, limitBytes: this.limit};
  }
}

export async function runBoundedCommand({command, cwd, logPrefix, env = {}, maxLogBytes = MAX_LOG_BYTES, onStart,timeoutMs=3600000}) {
  if (!Array.isArray(command) || command.length < 2 || command.some(arg => typeof arg !== 'string')) throw Error('Use executable and explicit argv');
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1 || maxLogBytes > MAX_LOG_BYTES) throw Error('Log limit must be 1..256 KiB per stream');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>21600000)throw Error('Command timeout must be 1ms..6h');
  const stdout = new Capture(maxLogBytes), stderr = new Capture(maxLogBytes);
  for (const suffix of ['.stdout.log', '.stderr.log']) if (fs.existsSync(logPrefix + suffix)) throw Error('Preserve existing command logs');
  fs.mkdirSync(path.dirname(logPrefix), {recursive: true});
  const startedAt = new Date().toISOString();
  const execution = await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {cwd, env: {...process.env, ...env}, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let timedOut=false,killFallback;
    const timer=setTimeout(()=>{
      timedOut=true;
      if(process.platform==='win32'){
        // Only terminate the process tree just created by this invocation.
        const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.once('error',()=>child.kill());
        killer.once('exit',code=>{if(code!==0)child.kill('SIGKILL');});
        killFallback=setTimeout(()=>child.kill('SIGKILL'),2000);
      }else child.kill('SIGKILL');
    },timeoutMs);
    child.stdout.on('data', chunk => stdout.accept(chunk)); child.stderr.on('data', chunk => stderr.accept(chunk));
    child.once('error',error=>{clearTimeout(timer);clearTimeout(killFallback);reject(error);}); child.once('close', (exitCode, signal) => {clearTimeout(timer);clearTimeout(killFallback);resolve({exitCode, signal, pid: child.pid,timedOut,timeoutMs});});
    try { onStart?.(child.pid); } catch (error) { child.kill(); reject(error); }
  });
  return {...execution, startedAt, finishedAt: new Date().toISOString(), stdout: stdout.save(logPrefix + '.stdout.log'), stderr: stderr.save(logPrefix + '.stderr.log')};
}

// Copy only explicitly requested small files. No hardlinks or whole-candidate
// copies: mutating a fixture must never mutate the shared read-only baseline.
export function copySmallFixture(source, destination, files, maxBytes = 8 * 1024 * 1024) {
  if (!Array.isArray(files) || !files.length || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('Explicit fixture files and positive byte budget required');
  const entries = [], seen = new Set(); let bytes = 0;
  for (const name of files) {
    if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) throw Error('Invalid fixture relative path');
    const key = name.toLowerCase(); if (seen.has(key)) throw Error('Duplicate fixture file'); seen.add(key);
    const file = path.resolve(source, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw Error('Fixture source must be a regular file');
    bytes += stat.size; if (bytes > maxBytes) throw Error('Small fixture byte budget exceeded; use a shared read-only source');
    entries.push({name, file, size: stat.size});
  }
  if (fs.existsSync(destination)) throw Error('Use a fresh fixture directory');
  fs.mkdirSync(destination, {recursive: true});
  for (const entry of entries) {
    const target = path.join(destination, entry.name); fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(entry.file, target, fs.constants.COPYFILE_EXCL);
  }
  return {files: entries.length, byteLength: bytes, source: path.resolve(source), destination: path.resolve(destination)};
}
