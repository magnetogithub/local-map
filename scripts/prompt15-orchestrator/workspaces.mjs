import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inside, resolveInside, owns, locatedBaseline} from './protocol.mjs';

const ignored = new Set(['.git', '.codex', '.agents', '.aws', 'node_modules', '.next', 'out', 'build', 'coverage', '.tmp', '.reports', 'test-results']);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function workspaceSnapshot(root) {
  const entries = {};
  const visit = relative => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) { entries[relative] = `link:${fs.readlinkSync(file)}`; return; }
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) {
      if (!ignored.has(name) && !name.startsWith('.next-')) visit(relative ? `${relative}/${name}` : name);
    }
    else if (stat.isFile()) entries[relative] = hash(file);
  };
  visit('');
  return entries;
}

export function prepareWorkspace(root, destination, plan, {controlRoot = root, sourceOnly = false} = {}) {
  if (!inside(path.join(controlRoot, 'reports'), destination)) throw Error('Branch workspace must stay in project reports');
  if (fs.existsSync(destination)) throw Error('Branch workspace already exists; never overwrite uncertain work');
  fs.mkdirSync(destination, {recursive: true});
  const copy = relative => {
    const source = path.join(root, relative), target = path.join(destination, relative);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw Error(`Unexpected source link in branch baseline: ${relative}`);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    if (stat.isDirectory()) fs.cpSync(source, target, {recursive: true, dereference: false,
      ...(sourceOnly ? {filter:file=>!path.relative(root,file).split(path.sep).includes('node_modules')&&path.relative(root,file).replaceAll('\\','/')!=='validation/archives'} : {})});
    else fs.copyFileSync(source, target);
  };
  // Source and configuration are actual copies, never hardlinks into another worker.
  for (const name of fs.readdirSync(root)) {
    if (ignored.has(name) || name.startsWith('.next-') || ['reports', 'data', 'public'].includes(name) || name.startsWith('.env') && name !== '.env.example') continue;
    if (sourceOnly && !['src','scripts','e2e','docs','prompts','automation','tools','validation','AGENTS.md','CLAUDE.md','.env.example'].includes(name) && !/^(package.*\.json|tsconfig.*\.json|.*config\.[cm]?[jt]s|vitest\.setup\.[jt]s)$/.test(name)) continue;
    copy(name);
  }
  // Large immutable inputs are readable from the original root. Materialize any
  // explicitly owned subtree so changes in that subtree remain local to this worker.
  const inputView = relative => {
    const source = path.join(root, relative), target = path.join(destination, relative);
    const local = relative.replaceAll('\\', '/');
    if (owns(plan, local)) { copy(relative); return; }
    const containsOwnedPath = plan.writablePaths.some(name => name.replaceAll('\\', '/').startsWith(`${local}/`));
    const stat = fs.statSync(source);
    if (containsOwnedPath && stat.isDirectory()) {
      fs.mkdirSync(target, {recursive: true});
      for (const child of fs.readdirSync(source)) inputView(path.join(relative, child));
    } else if (stat.isFile()) copy(relative);
    else {
      if (!inside(fs.realpathSync(controlRoot), fs.realpathSync(source))) throw Error(`Shared input escapes control root: ${relative}`);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.symlinkSync(source, target, stat.isDirectory() ? 'junction' : 'file');
    }
  };
  for (const name of ['data', 'public', 'node_modules']) if (fs.existsSync(path.join(root, name))) inputView(name);
  if (sourceOnly && fs.existsSync(path.join(root,'validation/node_modules'))) inputView('validation/node_modules');
  // fs.cp re-creates a nested Windows junction as an unprivileged file symlink.
  // Rebuild this approved dependency view explicitly as a directory junction.
  if (sourceOnly && fs.existsSync(path.join(root,'validation/archives'))) inputView('validation/archives');
  // Prompt 14 generators consume approved reports as inputs. Share this exact
  // subtree, never the entire orchestration/archive report tree.
  if (fs.existsSync(path.join(root, 'reports/prompt14'))) inputView('reports/prompt14');
  fs.mkdirSync(path.join(destination, '.reports'), {recursive: true});
  return {directory: destination, baseline: workspaceSnapshot(destination)};
}

export function planWorkspaceMerge(root, workspace, plan, declaredChanges) {
  const after = workspaceSnapshot(workspace.directory);
  const changed = [...new Set([...Object.keys(workspace.baseline), ...Object.keys(after)])].filter(name => locatedBaseline(workspace.baseline[name]) !== after[name]);
  for (const name of declaredChanges) if (!owns(plan, name)) throw Error(`Branch reported an unowned change: ${name}`);
  for (const name of changed) {
    if (!owns(plan, name)) throw Error(`Parallel write outside assigned ownership: ${name}`);
    if (after[name]?.startsWith('link:') || workspace.baseline[name]?.startsWith('link:')) throw Error(`Branch may not change input links: ${name}`);
    const target = resolveInside(root, name);
    const current = fs.existsSync(target) ? hash(target) : undefined;
    if (current !== workspace.baseline[name]) throw Error(`Main workspace changed since branch baseline: ${name}`);
  }
  return changed.map(name => ({name, source: path.join(workspace.directory, name), target: resolveInside(root, name), remove: after[name] === undefined}));
}

export function applyWorkspaceMerge(changes) {
  for (const change of changes) {
    if (change.remove) fs.unlinkSync(change.target);
    else { fs.mkdirSync(path.dirname(change.target), {recursive: true}); fs.copyFileSync(change.source, change.target); }
  }
}
