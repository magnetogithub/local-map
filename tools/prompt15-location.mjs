// Resolve historical workspace names without rewriting signed evidence bytes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {syncBuiltinESMExports, registerHooks} from 'node:module';
import childProcess from 'node:child_process';

const slot = Symbol.for('prompt15.workspaceLocation');
export const currentLocation = () => globalThis[slot]?.location ?? null;
export const physicalPath = value => globalThis[slot]?.map(value) ?? value;
export const locatedBaseline = value => typeof value === 'string' && value.startsWith('link:') ? 'link:' + physicalPath(value.slice(5)) : value;

export function installLocation({sourceRoot, destinationRoot}, {inherit = false} = {}) {
  if (globalThis[slot]) throw Error('A workspace location is already active');
  const native = {resolve: path.resolve, join: path.join, relative: path.relative};
  sourceRoot = native.resolve(sourceRoot); destinationRoot = native.resolve(destinationRoot);
  if (sourceRoot === destinationRoot) throw Error('Relocation requires a different destination');
  const within = (root, file) => file.toLowerCase() === root.toLowerCase() || file.toLowerCase().startsWith(root.toLowerCase() + path.sep);
  let passthrough = 0;
  const map = value => {
    if (passthrough) return value;
    const file = value instanceof URL && value.protocol === 'file:' ? fileURLToPath(value) : value;
    if (typeof file !== 'string') return value;
    const ordinary = file.startsWith('\\\\?\\') ? file.slice(4) : file;
    if (!path.isAbsolute(ordinary)) return value;
    const absolute = native.resolve(ordinary);
    if (within(destinationRoot, absolute) || !within(sourceRoot, absolute)) return value;
    const mapped = native.join(destinationRoot, absolute.slice(sourceRoot.length).replace(/^[/\\]+/, ''));
    return value instanceof URL ? pathToFileURL(mapped) : mapped;
  };
  const undo = [];
  const wrap = (object, name, indices = [0]) => {
    const original = object[name]; if (typeof original !== 'function') return;
    object[name] = function(...args) { for (const index of indices) args[index] = map(args[index]); passthrough++; try { return (name === 'realpathSync' && original.native ? original.native : original).apply(this, args); } finally { passthrough--; } };
    if (original.native) object[name].native = (...args) => { args[0] = map(args[0]); passthrough++; try { return original.native(...args); } finally { passthrough--; } };
    undo.push(() => object[name] = original);
  };
  // Cover sync, callback and promise APIs, including workers reading old pins.
  for (const suffix of ['', 'Sync']) for (const name of ['access','appendFile','chmod','chown','exists','lchmod','lchown','lstat','lutimes','mkdir','mkdtemp','open','opendir','readdir','readFile','readlink','realpath','rm','rmdir','stat','statfs','truncate','unlink','utimes','watch','watchFile','unwatchFile','writeFile']) wrap(fs, name + suffix);
  for (const name of ['createReadStream','createWriteStream']) wrap(fs, name);
  for (const suffix of ['', 'Sync']) for (const name of ['copyFile','cp','link','rename','symlink']) wrap(fs, name + suffix, [0, 1]);
  for (const name of ['access','appendFile','chmod','chown','lchmod','lchown','lstat','lutimes','mkdir','mkdtemp','open','opendir','readdir','readFile','readlink','realpath','rm','rmdir','stat','statfs','truncate','unlink','utimes','watch','writeFile']) wrap(fs.promises, name);
  for (const name of ['copyFile','cp','link','rename','symlink']) wrap(fs.promises, name, [0, 1]);
  for (const name of ['resolve', 'join']) { path[name] = (...args) => map(native[name](...args)); undo.push(() => path[name] = native[name]); }
  path.relative = (from, to) => native.relative(map(from), map(to)); undo.push(() => path.relative = native.relative);
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = function(...args) {
      args[0] = map(args[0]);
      if (Array.isArray(args[1])) args[1] = args[1].map(value => map(value));
      const index = Array.isArray(args[1]) ? 2 : 1, options = args[index];
      if (options && typeof options === 'object') args[index] = {...options,
        ...(options.cwd ? {cwd: map(options.cwd)} : {}),
        ...(options.env ? {env: Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, map(value)]))} : {})};
      return original.apply(this, args);
    };
    undo.push(() => childProcess[name] = original);
  }
  const chdir = process.chdir; process.chdir = directory => chdir(map(directory)); undo.push(() => process.chdir = chdir);
  const priorOptions = process.env.NODE_OPTIONS;
  if (inherit) {
    const preload = pathToFileURL(native.join(destinationRoot, 'tools/prompt15-location.mjs')).href;
    const option = '--import=' + JSON.stringify(preload);
    process.env.NODE_OPTIONS = priorOptions?.includes(option) ? priorOptions : [priorOptions, option].filter(Boolean).join(' ');
  }
  const location = {sourceRoot, destinationRoot};
  globalThis[slot] = {location, map};
  const hooks = registerHooks({resolve(specifier, context, nextResolve) {
    const value = specifier.startsWith('file:') ? map(new URL(specifier)).href : map(specifier);
    return nextResolve(value, context);
  }});
  undo.push(() => hooks.deregister()); syncBuiltinESMExports();
  return {location, restore() { for (const restore of undo.reverse()) restore(); if (inherit) { if (priorOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = priorOptions; } delete globalThis[slot]; syncBuiltinESMExports(); }};
}

// Only a verified installer creates this local routing file. It never contains
// credentials and does not replace any original target, certificate or receipt.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.tmp/prompt15-location.json');
if (!currentLocation() && fs.existsSync(file)) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== 1 || record.sourceRoot !== 'D:\\gen' || record.destinationRoot !== root || !/^[a-f0-9]{64}$/.test(record.manifestSha256 ?? '')) throw Error('Invalid local workspace location');
  installLocation(record, {inherit: true});
}
