import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
  try { fs.renameSync(temporary, file); }
  catch (error) {
    if (!['EPERM', 'EEXIST'].includes(error.code)) throw error;
    // OneDrive on Windows can reject replacement rename while permitting an
    // ordinary file replacement. Never turn that storage quirk into a model
    // recovery loop; perform one local fallback and surface any real failure.
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function fileIdentity(root, file) {
  const absolute = path.resolve(file);
  const bytes = fs.readFileSync(absolute);
  return {
    path: path.relative(root, absolute).replaceAll('\\', '/'),
    sha256: sha256(bytes),
    byteLength: bytes.length,
  };
}

export function resolveInside(root, value, label = 'path') {
  const base = path.resolve(root);
  const absolute = path.resolve(value);
  const relative = path.relative(base, absolute);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return absolute;
  throw Error(`${label} escapes the project: ${value}`);
}

export function resolveInsideEither(roots, value, label = 'path') {
  for (const root of roots) {
    try { return resolveInside(root, value, label); } catch { /* try next root */ }
  }
  throw Error(`${label} escapes its allowed roots: ${value}`);
}

export function appendEvent(file, event) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const bounded = {...event};
  if (typeof bounded.text === 'string') bounded.text = bounded.text.slice(0, 4000);
  fs.appendFileSync(file, `${JSON.stringify({at: new Date().toISOString(), ...bounded})}\n`);
}

export function runId() {
  return `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}-${randomUUID().slice(0, 8)}`;
}
