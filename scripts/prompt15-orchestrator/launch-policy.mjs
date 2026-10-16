import fs from 'node:fs';
import path from 'node:path';
import {fileIdentity, resolveInside, validateIdentities, validateVerification, normalizeVerification, PROMPT14_GATES} from './protocol.mjs';
import {validateProductTarget, captureProductTarget} from './product-target.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function verifiedInputs(root, verification) {
  const pins = new Map(verification.inputs.map(pin => [path.resolve(root,pin.path).toLowerCase(), pin.sha256]));
  for (const expected of verification.inputManifests ?? []) {
    if (pins.get(path.resolve(root,expected.path).toLowerCase()) !== expected.sha256) throw Error('Manual baseline gate: input manifest must be attested by the verdict');
    validateIdentities(root,[expected]);
    if (expected.byteLength > 16*1024*1024) throw Error('Manual baseline gate: oversized shared input manifest');
    const manifest=read(resolveInside(root,expected.path));
    if (manifest.version !== 1 || !Array.isArray(manifest.inputs) || manifest.inputs.length > 100000) throw Error('Manual baseline gate: invalid shared input closure');
    for (const pin of manifest.inputs) {
      // Node itself can be pinned outside the repository; arbitrary outside
      // paths cannot become accepted product inputs through a manifest.
      if (path.resolve(root,pin.path).toLowerCase() === process.execPath.toLowerCase()) validateIdentities(path.dirname(process.execPath),[{...pin,path:process.execPath}]);
      else validateIdentities(root,[pin]);
      const key=path.resolve(root,pin.path).toLowerCase();
      if (pins.has(key) && pins.get(key)!==pin.sha256) throw Error('Manual baseline gate: conflicting verified input identities');
      pins.set(key,pin.sha256);
    }
  }
  return pins;
}
export function validateManualBaseline(root, receiptPath) {
  const receipt = read(resolveInside(root, receiptPath));
  if (receipt.version !== 1 || receipt.review !== 'prompt14' || receipt.verdict !== 'pass' || receipt.mode !== 'manual-independent') throw Error('Manual baseline gate: explicit independent Prompt 14 PASS receipt required');
  validateIdentities(root, [receipt.verification]);
  const file = resolveInside(root, receipt.verification.path);
  const verification = normalizeVerification(root, path.dirname(file), read(file));
  validateVerification(root, path.dirname(file), 'prompt14', verification, PROMPT14_GATES);
  if (verification.verdict !== 'pass') throw Error('Manual baseline gate: non-PASS cannot authorize orchestration');
  const manifest = validateProductTarget(root, receipt.target);
  // The manual verifier must pin every product source byte that will seed A.
  const pins = verifiedInputs(root,verification);
  for (const [relative, sha256] of Object.entries(manifest.source)) {
    if (pins.get(path.join(receipt.target.productRoot, relative).toLowerCase()) !== sha256) throw Error(`Manual baseline gate: missing verified product input ${relative}`);
  }
  return receipt;
}

export function assertLaunchAllowed(root, config, state = null) {
  if (config.executionMode === 'manual-prompt14') throw Error('Manual baseline gate: Prompt 14 is being verified manually; orchestration start/resume is disabled');
  if (config.baselineVerification || state?.baselinePending) throw Error('Manual baseline gate: legacy automatic Prompt 14 loop is retired; start a fresh run from the accepted manual candidate');
  if (!config.boundProductTargets) return null; // Read-only compatibility for old control fixtures.
  if (config.executionMode !== 'orchestrated' || !config.manualBaselineReceipt) throw Error('Manual baseline gate: explicit enable and accepted manual baseline required');
  return validateManualBaseline(root, config.manualBaselineReceipt);
}

// Offline intake only. This does not enable execution, issue a product PASS,
// mutate the candidate, or start a model. The independently written verdict wins.
export function prepareManualBaselineReceipt(root, verificationPath, candidateRoot, outputDirectory) {
  const file = resolveInside(root, verificationPath);
  const verification = normalizeVerification(root, path.dirname(file), read(file));
  validateVerification(root, path.dirname(file), 'prompt14', verification, PROMPT14_GATES);
  if (verification.verdict !== 'pass') throw Error('Manual baseline gate: independent verdict is not PASS');
  const target = captureProductTarget(root, candidateRoot, path.join(outputDirectory, 'target'),{review:'prompt14',artifactManifest:verification.productInputManifestPath??null});
  const receipt = {version: 1, review: 'prompt14', verdict: 'pass', mode: 'manual-independent', verification: fileIdentity(root, file), target};
  // Validate before writing an acceptance receipt; a PASS string is insufficient.
  const temporary = resolveInside(root, path.join(outputDirectory, 'baseline-receipt.json'));
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2)+'\n', {flag: 'wx'});
  try { validateManualBaseline(root, temporary); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
  return {receipt, path: temporary};
}
