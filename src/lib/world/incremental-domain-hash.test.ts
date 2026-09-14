import {describe, expect, it} from "vitest";

import {buildWorldDomainHashRoots} from "./domain-hash-root";
import {
  applyIncrementalLeafHashChanges,
  createIncrementalDomainHashState,
  type LeafHashChanges,
} from "./incremental-domain-hash";

const hash = (character: string) => character.repeat(64);
const ownRecord = <Value>(entries: ReadonlyArray<readonly [string, Value]>) =>
  Object.fromEntries(entries) as Record<string, Value>;
const specialLeafKeys = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
] as const;
const initial = () =>
  createIncrementalDomainHashState({
    countryCoreHashes: {BBB: hash("b"), AAA: hash("a")},
    countryPresentationHashes: {BBB: hash("d"), AAA: hash("c")},
    territoryGeometryHashes: {t2: hash("f"), t1: hash("e")},
    territoryOwnershipHashes: {t2: hash("8"), t1: hash("7")},
    topologyEdgeHashes: {edge2: hash("2"), edge1: hash("1")},
  });

describe("10-30 incremental hash root update", () => {
  it("recomputes only the countries root for a countryCore leaf change", () => {
    const current = initial();
    const result = applyIncrementalLeafHashChanges(current, {
      countryCoreHashes: {AAA: hash("9")},
    });

    expect(result.recomputedRootFields).toEqual(["countriesRootHash"]);
    expect(result.metrics).toEqual({
      changedLeaves: 1,
      rootRecomputations: 1,
      deepWorldSerializations: 0,
    });
    expect(result.state.hashRoots.countriesRootHash).not.toBe(
      current.hashRoots.countriesRootHash,
    );
    expect(result.state.hashRoots.presentationRootHash).toBe(
      current.hashRoots.presentationRootHash,
    );
    expect(result.state.hashRoots.territoriesRootHash).toBe(
      current.hashRoots.territoriesRootHash,
    );
    expect(result.state.hashRoots.topologyRootHash).toBe(current.hashRoots.topologyRootHash);
    expect(result.state.leafHashes.countryPresentationHashes).toBe(
      current.leafHashes.countryPresentationHashes,
    );
  });

  it("coalesces geometry and ownership leaf changes into one territories root update", () => {
    const result = applyIncrementalLeafHashChanges(initial(), {
      territoryGeometryHashes: {t1: hash("9")},
      territoryOwnershipHashes: {t2: hash("6")},
    });

    expect(result.recomputedRootFields).toEqual(["territoriesRootHash"]);
    expect(result.metrics).toEqual({
      changedLeaves: 2,
      rootRecomputations: 1,
      deepWorldSerializations: 0,
    });
  });

  it("supports deterministic create, update, and delete changes", () => {
    const current = initial();
    const firstChanges: LeafHashChanges = {
      topologyEdgeHashes: {edge1: null, edge3: hash("3")},
      countryCoreHashes: {CCC: hash("3"), AAA: hash("9")},
    };
    const secondChanges: LeafHashChanges = {
      countryCoreHashes: {AAA: hash("9"), CCC: hash("3")},
      topologyEdgeHashes: {edge3: hash("3"), edge1: null},
    };
    const first = applyIncrementalLeafHashChanges(current, firstChanges);
    const second = applyIncrementalLeafHashChanges(current, secondChanges);

    expect(first.state).toEqual(second.state);
    expect(first.recomputedRootFields).toEqual([
      "countriesRootHash",
      "topologyRootHash",
    ]);
    expect(first.metrics.deepWorldSerializations).toBe(0);
  });

  it("preserves state identity and performs no work for semantic no-op changes", () => {
    const current = initial();
    const result = applyIncrementalLeafHashChanges(current, {
      countryCoreHashes: {AAA: hash("a")},
      topologyEdgeHashes: {missing: null},
    });

    expect(result.state).toBe(current);
    expect(result.recomputedRootFields).toEqual([]);
    expect(result.metrics).toEqual({
      changedLeaves: 0,
      rootRecomputations: 0,
      deepWorldSerializations: 0,
    });
  });

  it("rejects malformed changed leaf hashes before publishing a next state", () => {
    const current = initial();

    expect(() =>
      applyIncrementalLeafHashChanges(current, {countryCoreHashes: {AAA: "bad"}}),
    ).toThrow(/leaf hash/i);
    expect(current.leafHashes.countryCoreHashes.AAA).toBe(hash("a"));
  });

  it("preserves an own __proto__ leaf in the initial snapshot and full roots", () => {
    const countryCoreHashes = ownRecord([
      ["AAA", hash("a")],
      ["__proto__", hash("b")],
    ]);
    const input = {
      countryCoreHashes,
      countryPresentationHashes: {},
      territoryGeometryHashes: {},
      territoryOwnershipHashes: {},
      topologyEdgeHashes: {},
    };
    const state = createIncrementalDomainHashState(input);

    expect(Object.hasOwn(state.leafHashes.countryCoreHashes, "__proto__")).toBe(true);
    expect(state.leafHashes.countryCoreHashes.__proto__).toBe(hash("b"));
    expect(Object.keys(state.leafHashes.countryCoreHashes)).toContain("__proto__");
    expect(state.hashRoots).toEqual(buildWorldDomainHashRoots(state.leafHashes));
    expect(Object.hasOwn(countryCoreHashes, "__proto__")).toBe(true);
  });

  it("creates an own __proto__ leaf without pollution and matches a full root rebuild", () => {
    const current = initial();
    const previousRoots = current.hashRoots;
    const previousPrototype = Object.getPrototypeOf(current.leafHashes.countryCoreHashes);
    const objectPrototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    const changes = {
      countryCoreHashes: ownRecord([["__proto__", hash("9")]]),
    };
    const changesBefore = Object.entries(changes.countryCoreHashes);
    const result = applyIncrementalLeafHashChanges(current, changes);

    expect(result.metrics).toEqual({
      changedLeaves: 1,
      rootRecomputations: 1,
      deepWorldSerializations: 0,
    });
    expect(result.recomputedRootFields).toEqual(["countriesRootHash"]);
    expect(result.state.hashRoots.countriesRootHash).not.toBe(previousRoots.countriesRootHash);
    expect(result.state.hashRoots.presentationRootHash).toBe(previousRoots.presentationRootHash);
    expect(result.state.hashRoots.territoriesRootHash).toBe(previousRoots.territoriesRootHash);
    expect(result.state.hashRoots.topologyRootHash).toBe(previousRoots.topologyRootHash);
    expect(Object.hasOwn(result.state.leafHashes.countryCoreHashes, "__proto__")).toBe(true);
    expect(result.state.leafHashes.countryCoreHashes.__proto__).toBe(hash("9"));
    expect(Object.getPrototypeOf(result.state.leafHashes.countryCoreHashes)).toBe(
      previousPrototype,
    );
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(
      objectPrototypeDescriptors,
    );
    expect(result.state.hashRoots).toEqual(buildWorldDomainHashRoots(result.state.leafHashes));
    expect(Object.hasOwn(current.leafHashes.countryCoreHashes, "__proto__")).toBe(false);
    expect(Object.entries(changes.countryCoreHashes)).toEqual(changesBefore);
  });

  it("updates an existing own __proto__ leaf and only its root", () => {
    const current = createIncrementalDomainHashState({
      ...initial().leafHashes,
      countryCoreHashes: ownRecord([
        ["AAA", hash("a")],
        ["__proto__", hash("b")],
      ]),
    });
    const result = applyIncrementalLeafHashChanges(current, {
      countryCoreHashes: ownRecord([["__proto__", hash("9")]]),
    });

    expect(result.metrics.changedLeaves).toBe(1);
    expect(result.metrics.rootRecomputations).toBe(1);
    expect(result.recomputedRootFields).toEqual(["countriesRootHash"]);
    expect(result.state.hashRoots.countriesRootHash).not.toBe(
      current.hashRoots.countriesRootHash,
    );
    expect(result.state.hashRoots.presentationRootHash).toBe(
      current.hashRoots.presentationRootHash,
    );
    expect(result.state.hashRoots.territoriesRootHash).toBe(
      current.hashRoots.territoriesRootHash,
    );
    expect(result.state.hashRoots.topologyRootHash).toBe(current.hashRoots.topologyRootHash);
    expect(result.state.leafHashes.countryCoreHashes.__proto__).toBe(hash("9"));
    expect(result.state.hashRoots).toEqual(buildWorldDomainHashRoots(result.state.leafHashes));
    expect(current.leafHashes.countryCoreHashes.__proto__).toBe(hash("b"));
  });

  it("deletes an existing own __proto__ leaf and only its root", () => {
    const current = createIncrementalDomainHashState({
      ...initial().leafHashes,
      countryCoreHashes: ownRecord([
        ["AAA", hash("a")],
        ["__proto__", hash("b")],
      ]),
    });
    const result = applyIncrementalLeafHashChanges(current, {
      countryCoreHashes: ownRecord([["__proto__", null]]),
    });

    expect(result.metrics.changedLeaves).toBe(1);
    expect(result.recomputedRootFields).toEqual(["countriesRootHash"]);
    expect(Object.hasOwn(result.state.leafHashes.countryCoreHashes, "__proto__")).toBe(false);
    expect(result.state.hashRoots.countriesRootHash).not.toBe(
      current.hashRoots.countriesRootHash,
    );
    expect(result.state.hashRoots.presentationRootHash).toBe(
      current.hashRoots.presentationRootHash,
    );
    expect(result.state.hashRoots.territoriesRootHash).toBe(
      current.hashRoots.territoriesRootHash,
    );
    expect(result.state.hashRoots.topologyRootHash).toBe(current.hashRoots.topologyRootHash);
    expect(result.state.hashRoots).toEqual(buildWorldDomainHashRoots(result.state.leafHashes));
    expect(Object.hasOwn(current.leafHashes.countryCoreHashes, "__proto__")).toBe(true);
  });

  it.each(specialLeafKeys.slice(1))(
    "creates, updates, and deletes the own special leaf key %s",
    (specialKey) => {
      const current = initial();
      expect(Object.hasOwn(current.leafHashes.countryCoreHashes, specialKey)).toBe(false);

      const created = applyIncrementalLeafHashChanges(current, {
        countryCoreHashes: ownRecord([[specialKey, hash("5")]]),
      });
      expect(created.recomputedRootFields).toEqual(["countriesRootHash"]);
      expect(Object.hasOwn(created.state.leafHashes.countryCoreHashes, specialKey)).toBe(true);
      expect(created.state.leafHashes.countryCoreHashes[specialKey]).toBe(hash("5"));
      expect(created.state.hashRoots.presentationRootHash).toBe(
        current.hashRoots.presentationRootHash,
      );
      expect(created.state.hashRoots.territoriesRootHash).toBe(
        current.hashRoots.territoriesRootHash,
      );
      expect(created.state.hashRoots.topologyRootHash).toBe(current.hashRoots.topologyRootHash);
      expect(Object.getPrototypeOf(created.state.leafHashes.countryCoreHashes)).toBe(
        Object.getPrototypeOf(current.leafHashes.countryCoreHashes),
      );
      expect(created.state.hashRoots).toEqual(
        buildWorldDomainHashRoots(created.state.leafHashes),
      );

      const updated = applyIncrementalLeafHashChanges(created.state, {
        countryCoreHashes: ownRecord([[specialKey, hash("6")]]),
      });
      expect(updated.metrics.changedLeaves).toBe(1);
      expect(updated.metrics.rootRecomputations).toBe(1);
      expect(updated.state.leafHashes.countryCoreHashes[specialKey]).toBe(hash("6"));
      expect(updated.state.hashRoots).toEqual(
        buildWorldDomainHashRoots(updated.state.leafHashes),
      );

      const deleted = applyIncrementalLeafHashChanges(updated.state, {
        countryCoreHashes: ownRecord([[specialKey, null]]),
      });
      expect(deleted.metrics.changedLeaves).toBe(1);
      expect(deleted.metrics.rootRecomputations).toBe(1);
      expect(Object.hasOwn(deleted.state.leafHashes.countryCoreHashes, specialKey)).toBe(false);
      expect(deleted.state.hashRoots).toEqual(
        buildWorldDomainHashRoots(deleted.state.leafHashes),
      );
    },
  );

  it("is deterministic and prototype-safe for differently ordered special-key changes", () => {
    const current = initial();
    const currentCoreBefore = Object.entries(current.leafHashes.countryCoreHashes);
    const currentRootsBefore = {...current.hashRoots};
    const objectPrototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    const forwardEntries = specialLeafKeys.map(
      (key, index) => [key, hash(String(index + 1))] as const,
    );
    const reverseEntries = [...forwardEntries].reverse();
    const firstChanges = {countryCoreHashes: ownRecord(forwardEntries)};
    const secondChanges = {countryCoreHashes: ownRecord(reverseEntries)};
    const firstChangesBefore = Object.entries(firstChanges.countryCoreHashes);
    const secondChangesBefore = Object.entries(secondChanges.countryCoreHashes);
    const first = applyIncrementalLeafHashChanges(current, firstChanges);
    const second = applyIncrementalLeafHashChanges(current, secondChanges);

    expect(first.state).toEqual(second.state);
    expect(first.recomputedRootFields).toEqual(second.recomputedRootFields);
    expect(first.metrics).toEqual(second.metrics);
    expect(first.metrics.deepWorldSerializations).toBe(0);
    expect(first.state.hashRoots).toEqual(buildWorldDomainHashRoots(first.state.leafHashes));
    for (const specialKey of specialLeafKeys) {
      expect(Object.hasOwn(first.state.leafHashes.countryCoreHashes, specialKey)).toBe(true);
    }
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(
      objectPrototypeDescriptors,
    );
    expect(Object.entries(firstChanges.countryCoreHashes)).toEqual(firstChangesBefore);
    expect(Object.entries(secondChanges.countryCoreHashes)).toEqual(secondChangesBefore);
    expect(Object.isFrozen(first.state.leafHashes.countryCoreHashes)).toBe(true);
    expect(Object.isFrozen(first.state.hashRoots)).toBe(true);
    expect(Object.entries(current.leafHashes.countryCoreHashes)).toEqual(currentCoreBefore);
    expect(current.hashRoots).toEqual(currentRootsBefore);
  });
});
