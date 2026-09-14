import {describe, expect, it} from "vitest";

import {
  ARTIFACT_HASH_INPUT_FIELDS,
  COMMIT_HASH_INPUT_FIELDS,
  HISTORY_HASH_INPUT_FIELDS,
  artifactHash,
  commitHash,
  historyHash,
} from "./purpose-hashes";

const hash = (character: string) => character.repeat(64);

describe("10-29 commit, artifact, and history hash contracts", () => {
  it("publishes three explicit and non-identical input field sets", () => {
    expect(COMMIT_HASH_INPUT_FIELDS).toEqual([
      "policyVersion",
      "previousCommitHash",
      "revision",
      "worldContentHash",
    ]);
    expect(ARTIFACT_HASH_INPUT_FIELDS).toEqual([
      "artifactContentHash",
      "projectionKind",
      "projectionVersion",
      "revision",
    ]);
    expect(HISTORY_HASH_INPUT_FIELDS).toEqual(["commandHashes", "cursor"]);
    expect(new Set([
      JSON.stringify(COMMIT_HASH_INPUT_FIELDS),
      JSON.stringify(ARTIFACT_HASH_INPUT_FIELDS),
      JSON.stringify(HISTORY_HASH_INPUT_FIELDS),
    ])).toHaveLength(3);
  });

  it("namespaces purpose hashes so superficially shared values cannot collide", () => {
    const commit = commitHash({
      revision: 1,
      worldContentHash: hash("a"),
      policyVersion: "policy-v1",
      previousCommitHash: null,
    });
    const artifact = artifactHash({
      revision: 1,
      projectionKind: "map",
      projectionVersion: "policy-v1",
      artifactContentHash: hash("a"),
    });
    const history = historyHash({commandHashes: [hash("a")], cursor: 1});

    expect(new Set([commit, artifact, history])).toHaveLength(3);
  });

  it("commitHash commits revision, world content, policy, and previous commit only", () => {
    const input = {
      revision: 2,
      worldContentHash: hash("a"),
      policyVersion: "policy-v1",
      previousCommitHash: hash("b"),
    };
    const baseline = commitHash(input);
    for (const patch of [
      {revision: 3},
      {worldContentHash: hash("c")},
      {policyVersion: "policy-v2"},
      {previousCommitHash: null},
    ]) {
      expect(commitHash({...input, ...patch})).not.toBe(baseline);
    }
    const withArtifactMetadata = {...input, artifactHash: hash("d")};
    expect(commitHash(withArtifactMetadata)).toBe(baseline);
  });

  it("artifactHash commits one revision-specific projection output", () => {
    const input = {
      revision: 2,
      projectionKind: "map",
      projectionVersion: "map-v1",
      artifactContentHash: hash("a"),
    };
    const baseline = artifactHash(input);
    for (const patch of [
      {revision: 3},
      {projectionKind: "search"},
      {projectionVersion: "map-v2"},
      {artifactContentHash: hash("b")},
    ]) {
      expect(artifactHash({...input, ...patch})).not.toBe(baseline);
    }
    const withWorldMetadata = {...input, worldContentHash: hash("c")};
    expect(artifactHash(withWorldMetadata)).toBe(baseline);
  });

  it("historyHash commits ordered commands and the undo/redo cursor", () => {
    const commands = [hash("a"), hash("b")];
    const baseline = historyHash({commandHashes: commands, cursor: 2});

    expect(historyHash({commandHashes: [...commands].reverse(), cursor: 2})).not.toBe(baseline);
    expect(historyHash({commandHashes: commands, cursor: 1})).not.toBe(baseline);
  });

  it("rejects invalid hashes, revisions, versions, and history cursors", () => {
    expect(() => commitHash({
      revision: -1,
      worldContentHash: hash("a"),
      policyVersion: "policy-v1",
      previousCommitHash: null,
    })).toThrow(/revision/);
    expect(() => artifactHash({
      revision: 1,
      projectionKind: " map",
      projectionVersion: "map-v1",
      artifactContentHash: hash("a"),
    })).toThrow(/projectionKind/);
    expect(() => historyHash({commandHashes: [hash("a")], cursor: 2})).toThrow(/cursor/);
  });
});
