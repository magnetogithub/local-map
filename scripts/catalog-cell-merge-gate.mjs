// Separate admission from the historical country-generation proof. A merge
// carries its own baseline, plan, replay and independent geometry certificate.
export function acceptContainedCellMerge({bundle, inputBytes, proofBytes, checkedPin, digest}) {
  const correction = bundle.report.manualCellMerge, proof = JSON.parse(proofBytes);
  if (correction?.schemaVersion !== 'catalog-contained-cell-merge-v1' || correction.administrativeTruthClaim !== false ||
      proof.schemaVersion !== 'catalog-contained-cell-merge-independent-v1' || proof.pass !== true ||
      proof.after?.sha256 !== digest(inputBytes) || proof.after?.byteLength !== inputBytes.length ||
      JSON.stringify(proof.before) !== JSON.stringify(correction.baseline.bundle) ||
      JSON.stringify(proof.baselinePointer) !== JSON.stringify(correction.baseline.pointer) ||
      JSON.stringify(proof.plan) !== JSON.stringify(correction.plan)) throw Error('UNVERIFIED_CONTAINED_CELL_MERGE');
  for (const key of ['scope', 'coverage', 'topology', 'lineage', 'sourcePreservation', 'reproducibility']) {
    if (proof.checks?.[key] !== true) throw Error(`MISSING_CELL_MERGE_ACCEPTANCE:${key}`);
  }
  for (const identity of [...Object.values(correction.baseline), correction.plan, ...correction.code, ...proof.sourcePins, proof.verifier]) checkedPin(identity, 'cell-merge');
  if (!correction.code.some(p => p.path === proof.verifier.path && p.sha256 === proof.verifier.sha256)) throw Error('CELL_MERGE_VERIFIER_CHANGED');
  const baselinePointer = JSON.parse(checkedPin(correction.baseline.pointer, 'cell-merge.pointer'));
  const index = JSON.parse(checkedPin({path: `${baselinePointer.root}/artifact-index.json`, ...baselinePointer.index}, 'cell-merge.index'));
  const provenanceArtifact = index.artifacts.find(p => p.path === 'provenance.json');
  const provenance = JSON.parse(checkedPin({...provenanceArtifact, path: `${baselinePointer.root}/provenance.json`}, 'cell-merge.provenance'));
  if (provenance.inputRoot !== correction.baseline.bundle.sha256 ||
      provenance.incrementalVerification?.sha256 === undefined) throw Error('CELL_MERGE_BASELINE_NOT_ADMITTED');
  const previousProof = JSON.parse(checkedPin(provenance.incrementalVerification, 'cell-merge.previous-proof'));
  if (previousProof.pass !== true || previousProof.after.sha256 !== correction.baseline.bundle.sha256) throw Error('CELL_MERGE_PREVIOUS_PROOF_MISMATCH');
  return {baselinePointer, baselineBundle: JSON.parse(checkedPin(correction.baseline.bundle, 'cell-merge.bundle'))};
}
