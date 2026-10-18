import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inside, resolveInside, fileIdentity, validateIdentities, sourceSnapshot, atomicJSON} from './protocol.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => digest(a) === digest(b);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = (root, name) => {
  const file = resolveInside(root, name);
  if (!fs.statSync(file).isDirectory() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw Error('Target binding: product root must be a real workspace directory');
  return file;
};

// Source identity is separate from its storage path and from a model's summary.
export function productSnapshot(productRoot) {
  const files = Object.fromEntries(Object.entries(sourceSnapshot(productRoot)).filter(([name])=>
    !['scripts/prompt15-orchestrator/','automation/prompt15/','docs/automation/'].some(prefix=>name.startsWith(prefix))));
  const visit = relative => {
    // This approved archive store is a shared dependency input (as node_modules
    // is), not source. Its actual files belong in the bound input manifest.
    if(relative.replaceAll('\\','/')==='validation/archives')return;
    const file = path.join(productRoot, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error(`Target binding: linked product source ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (name !== 'node_modules') visit(path.join(relative, name));
    } else files[relative.replaceAll('\\', '/')] = fileIdentity(productRoot, relative).sha256;
  };
  for (const name of ['e2e', 'validation']) visit(name);
  for (const name of fs.readdirSync(productRoot).sort()) if (/^(tsconfig.*\.json|.*\.config\.[cm]?[jt]s|vitest\.setup\.[jt]s)$/.test(name)) visit(name);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export function captureProductTarget(root, productRoot, directory, {requestIdentity = null, responseIdentity = null, turnId = null, artifactManifest = null, review = null} = {}) {
  productRoot = canonical(root, productRoot);
  if (!fs.existsSync(path.join(productRoot, 'package.json'))) throw Error('Target binding: missing product package.json');
  directory = resolveInside(root, directory);
  if (![path.join(root,'reports'),path.join(root,'.tmp')].some(base=>inside(base,directory)&&directory!==base)) throw Error('Target binding: receipts must stay in report/scratch storage');
  if (fs.existsSync(directory)) throw Error('Target binding: preserve an existing target receipt');
  if (responseIdentity && (!requestIdentity || !turnId)) throw Error('Target binding: confirmed implementation turn and original request required');
  validateIdentities(root, [requestIdentity, responseIdentity].filter(Boolean));
  let extraInputs = [];
  if (artifactManifest) {
    const file = resolveInside(root, artifactManifest);
    const manifest = read(file);
    if (manifest.version !== 1 || !Array.isArray(manifest.inputs)) throw Error('Target binding: invalid product input manifest');
    validateIdentities(root, manifest.inputs);
    extraInputs = manifest.inputs.map(pin => ({...pin, path: path.relative(root, resolveInside(root, pin.path)).replaceAll('\\', '/')}));
    for(const pin of extraInputs){
      const relative=pin.path,file=resolveInside(root,relative);
      if(!inside(productRoot,file)&&/^(src\/|e2e\/|validation\/|scripts\/|package(?:-lock)?\.json$|tsconfig.*\.json$|.*config\.[cm]?[jt]s$)/.test(relative)) throw Error('Target binding: artifact manifest selected repository product inputs');
    }
    extraInputs.push(fileIdentity(root,file));
  }
  fs.mkdirSync(directory, {recursive: true});
  const source = productSnapshot(productRoot);
  const manifestFile = path.join(directory, 'product-inputs.json');
  atomicJSON(manifestFile, {version: 1, productRoot, source, extraInputs});
  const relativeInput = pin => ({...pin, path: inside(productRoot, resolveInside(root, pin.path)) ? path.relative(productRoot, resolveInside(root, pin.path)).replaceAll('\\', '/') : path.resolve(root, pin.path)});
  const revision = digest({source, extraInputs: extraInputs.map(relativeInput).sort((a,b)=>a.path.localeCompare(b.path))});
  const binding = {version: 1, productRoot, review, revision, manifest: fileIdentity(root, manifestFile), requestIdentity, responseIdentity, turnId};
  const target = {...binding, targetId: digest(binding)};
  atomicJSON(path.join(directory, 'target.json'), target);
  return target;
}

export function validateProductTarget(root, target, {checkSource = true, checkExtra = true} = {}) {
  if (!target || target.version !== 1) throw Error('Target binding: explicit product target required; no repository fallback');
  const {targetId, ...binding} = target;
  if (digest(binding) !== targetId) throw Error('Target binding: identity changed');
  const productRoot = canonical(root, target.productRoot);
  validateIdentities(root, [target.manifest, target.requestIdentity, target.responseIdentity].filter(Boolean));
  if (target.responseIdentity && read(resolveInside(root,target.responseIdentity.path)).turnId !== target.turnId) throw Error('Target binding: implementation turn identity mismatch');
  const manifest = read(resolveInside(root, target.manifest.path));
  if (manifest.version !== 1 || path.resolve(manifest.productRoot) !== productRoot || !manifest.source || !Array.isArray(manifest.extraInputs)) throw Error('Target binding: manifest/root mismatch');
  if (checkSource && !same(manifest.source, productSnapshot(productRoot))) throw Error('Target binding: product source changed after handoff');
  if (checkExtra) validateIdentities(root, manifest.extraInputs);
  return manifest;
}

export function attestProductTarget(root, target, verification) {
  validateProductTarget(root, target);
  if (verification.targetId !== target.targetId || path.resolve(verification.candidateRoot ?? '') !== path.resolve(target.productRoot)) throw Error('Target binding: verifier inspected a different product target');
  if (!verification.inputs.some(pin => same(pin, target.manifest))) throw Error('Target binding: verdict must attest the exact product input manifest');
  verification.candidateRevision = target.revision;
  verification.productTarget = target;
  return verification;
}

export function failureAttemptKey(verification) {
  if (!verification.candidateRevision) return null;
  const gates = verification.checks.filter(check => check.status === 'fail').map(check => check.id).sort();
  return `${verification.review}:candidate:${verification.candidateRevision}:gates:${digest(gates)}`;
}
