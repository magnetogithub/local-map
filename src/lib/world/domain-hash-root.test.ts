import {describe, expect, it} from "vitest";

import {
  buildDomainRootHash,
  buildWorldDomainHashRoots,
  type WorldLeafHashRecords,
} from "./domain-hash-root";

const hash = (character: string) => character.repeat(64);
const leaves = (): WorldLeafHashRecords => ({
  countryCoreHashes: {BBB: hash("b"), AAA: hash("a")},
  countryPresentationHashes: {BBB: hash("d"), AAA: hash("c")},
  territoryGeometryHashes: {t2: hash("f"), t1: hash("e")},
  territoryOwnershipHashes: {t2: hash("8"), t1: hash("7")},
  topologyEdgeHashes: {edge2: hash("2"), edge1: hash("1")},
});

describe("10-27 domain root builder", () => {
  it("is independent of leaf record insertion order", () => {
    expect(buildDomainRootHash("countries", {BBB: hash("b"), AAA: hash("a")})).toBe(
      buildDomainRootHash("countries", {AAA: hash("a"), BBB: hash("b")}),
    );
  });

  it("commits leaf keys and domain namespace, not only hash values", () => {
    expect(buildDomainRootHash("countries", {AAA: hash("a")})).not.toBe(
      buildDomainRootHash("countries", {BBB: hash("a")}),
    );
    expect(buildDomainRootHash("countries", {AAA: hash("a")})).not.toBe(
      buildDomainRootHash("presentation", {AAA: hash("a")}),
    );
  });

  it.each([
    ["countryCoreHashes", "countriesRootHash"],
    ["countryPresentationHashes", "presentationRootHash"],
    ["territoryGeometryHashes", "territoriesRootHash"],
    ["territoryOwnershipHashes", "territoriesRootHash"],
    ["topologyEdgeHashes", "topologyRootHash"],
  ] as const)("changes only the owning root for %s", (leafField, rootField) => {
    const originalLeaves = leaves();
    const originalRoots = buildWorldDomainHashRoots(originalLeaves);
    const firstKey = Object.keys(originalLeaves[leafField]).sort()[0];
    const changedRoots = buildWorldDomainHashRoots({
      ...originalLeaves,
      [leafField]: {...originalLeaves[leafField], [firstKey]: hash("9")},
    });

    for (const field of Object.keys(originalRoots) as Array<keyof typeof originalRoots>) {
      if (field === rootField) expect(changedRoots[field]).not.toBe(originalRoots[field]);
      else expect(changedRoots[field]).toBe(originalRoots[field]);
    }
  });

  it("rejects malformed leaf hashes and ambiguous empty keys", () => {
    expect(() => buildDomainRootHash("countries", {AAA: "not-a-hash"})).toThrow(/leaf hash/i);
    expect(() => buildDomainRootHash("countries", {"": hash("a")})).toThrow(/leaf key/i);
  });
});
