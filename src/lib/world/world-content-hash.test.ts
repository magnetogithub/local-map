import {describe, expect, it} from "vitest";

import type {WorldDomainHashRoots} from "./domain-hash-root";
import {worldContentHash} from "./world-content-hash";

const hash = (character: string) => character.repeat(64);
const roots: WorldDomainHashRoots = {
  countriesRootHash: hash("a"),
  presentationRootHash: hash("b"),
  territoriesRootHash: hash("c"),
  topologyRootHash: hash("d"),
};
const content = () => ({
  schemaVersion: 2,
  seedVersion: "natural-earth-2020-v2",
  policyVersion: "world-policy-v1",
  hashRoots: roots,
});

describe("10-28 worldContentHash", () => {
  it("ignores revision, command metadata, and UI state", () => {
    const first = {
      ...content(),
      revision: 1,
      issuedAt: "2026-09-01T00:00:00Z",
      commandId: "command-one",
      uiState: {selectedCountryId: "AAA"},
    };
    const second = {
      ...content(),
      revision: 999,
      issuedAt: "2030-01-01T00:00:00Z",
      commandId: "command-two",
      uiState: {selectedCountryId: "BBB"},
    };

    expect(worldContentHash(first)).toBe(worldContentHash(second));
  });

  it.each([
    ["schemaVersion", {schemaVersion: 3}],
    ["seedVersion", {seedVersion: "natural-earth-2030-v1"}],
    ["policyVersion", {policyVersion: "world-policy-v2"}],
  ] as const)("changes when %s changes", (_field, patch) => {
    expect(worldContentHash({...content(), ...patch})).not.toBe(worldContentHash(content()));
  });

  it.each(Object.keys(roots) as Array<keyof WorldDomainHashRoots>)(
    "changes when domain root %s changes",
    (field) => {
      expect(
        worldContentHash({...content(), hashRoots: {...roots, [field]: hash("e")}}),
      ).not.toBe(worldContentHash(content()));
    },
  );

  it("rejects incomplete or malformed root and version inputs", () => {
    expect(() => worldContentHash({...content(), hashRoots: {...roots, topologyRootHash: "bad"}}))
      .toThrow(/topologyRootHash/);
    expect(() => worldContentHash({...content(), policyVersion: " policy-v1"}))
      .toThrow(/policyVersion/);
  });
});
