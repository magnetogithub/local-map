import {describe, expect, it} from "vitest";
import type {ZodType} from "zod";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {commandBatchV2CommandSchema} from "./command-batch-v2";
import {countryCreateV2CommandSchema} from "./country-create-v2";
import {countryDeleteV2CommandSchema} from "./country-delete-v2";
import {countryDissolveV2CommandSchema} from "./country-dissolve-v2";
import {countryEstablishV2CommandSchema} from "./country-establish-v2";
import {countryMergeV2CommandSchema} from "./country-merge-v2";
import {countryRenameV2CommandSchema} from "./country-rename-v2";
import {countrySplitV2CommandSchema} from "./country-split-v2";
import {safeParseMapCommandV2Envelope} from "./map-command-v2";
import {territoryAssignV2CommandSchema} from "./territory-assign-v2";
import {territoryPartitionV2CommandSchema} from "./territory-partition-v2";
import {territoryReplaceV2CommandSchema} from "./territory-replace-v2";
import {territoryTransferV2CommandSchema} from "./territory-transfer-v2";
import {territoryUnclaimV2CommandSchema} from "./territory-unclaim-v2";

type CommandFixture = Readonly<{
  name: string;
  schema: ZodType;
  input: {
    commandId: string;
    type: string;
    expectedRevision: number;
    payload: object;
  };
}>;

const dataDescriptor = (value: unknown): PropertyDescriptor => ({
  configurable: true,
  enumerable: false,
  value,
  writable: true,
});

function withObjectPrototypeDescriptors<T>(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  run: () => T,
): T {
  const entries = Object.entries(descriptors);
  const originals = entries.map(([key]) => [
    key,
    Object.getOwnPropertyDescriptor(Object.prototype, key),
  ] as const);

  for (const [key, descriptor] of entries) {
    Object.defineProperty(Object.prototype, key, descriptor);
  }
  try {
    return run();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, key);
      } else {
        Object.defineProperty(Object.prototype, key, descriptor);
      }
    }
  }
}

const envelope = (commandId: string, type: string, payload: object) => ({
  commandId,
  type,
  expectedRevision: 21,
  payload,
});
const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId});
const identity = (id: string) => ({
  id,
  names: {
    shortKo: id,
    officialKo: `${id} Republic`,
    mapKo: id,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const polygon = (offset = 0) => ({
  type: "Polygon" as const,
  coordinates: [[[offset, 0], [offset + 1, 0], [offset + 1, 1], [offset, 0]]],
});

const alphaTerritory = territory("prototype-alpha");
const betaTerritory = territory("prototype-beta");
const deleteLeaf = envelope("delete-leaf", "country.delete", {countryId: "OLD"});
const directCommandFixtures: CommandFixture[] = [
  {
    name: "country.create",
    schema: countryCreateV2CommandSchema,
    input: envelope("create", "country.create", {country: identity("AAA")}),
  },
  {
    name: "country.establish",
    schema: countryEstablishV2CommandSchema,
    input: envelope("establish", "country.establish", {
      country: identity("AAA"),
      territoryIds: [alphaTerritory],
    }),
  },
  {
    name: "country.rename",
    schema: countryRenameV2CommandSchema,
    input: envelope("rename", "country.rename", {
      countryId: "AAA",
      changes: {english: "A Republic"},
    }),
  },
  {name: "country.delete", schema: countryDeleteV2CommandSchema, input: deleteLeaf},
  {
    name: "country.dissolve",
    schema: countryDissolveV2CommandSchema,
    input: envelope("dissolve", "country.dissolve", {
      sourceCountryId: "AAA",
      territoryDispositions: [
        {territoryId: alphaTerritory, disposition: {type: "unclaim"}},
      ],
    }),
  },
  {
    name: "territory.partition",
    schema: territoryPartitionV2CommandSchema,
    input: envelope("partition", "territory.partition", {
      sourceTerritoryId: alphaTerritory,
      partitions: [
        {partitionKey: "west", geometry: polygon()},
        {partitionKey: "east", geometry: polygon(1)},
      ],
    }),
  },
  {
    name: "territory.assign",
    schema: territoryAssignV2CommandSchema,
    input: envelope("assign", "territory.assign", {
      territoryId: alphaTerritory,
      targetCountryId: "AAA",
    }),
  },
  {
    name: "territory.unclaim",
    schema: territoryUnclaimV2CommandSchema,
    input: envelope("unclaim", "territory.unclaim", {territoryIds: [alphaTerritory]}),
  },
  {
    name: "territory.replace",
    schema: territoryReplaceV2CommandSchema,
    input: envelope("replace", "territory.replace", {
      territoryId: alphaTerritory,
      geometry: polygon(),
    }),
  },
  {
    name: "territory.transfer",
    schema: territoryTransferV2CommandSchema,
    input: envelope("transfer", "territory.transfer", {
      source: {kind: "territory-id", territoryId: alphaTerritory},
      targetCountryId: "BBB",
    }),
  },
  {
    name: "country.split",
    schema: countrySplitV2CommandSchema,
    input: envelope("split", "country.split", {
      sourceCountryId: "OLD",
      resultCountries: [
        {
          country: identity("AAA"),
          territorySources: [{kind: "territory-id", territoryId: alphaTerritory}],
        },
        {
          country: identity("BBB"),
          territorySources: [{kind: "territory-id", territoryId: betaTerritory}],
        },
      ],
    }),
  },
  {
    name: "country.merge",
    schema: countryMergeV2CommandSchema,
    input: envelope("merge", "country.merge", {
      sourceCountryIds: ["AAA", "BBB"],
      resultCountry: {kind: "existing-country", countryId: "AAA"},
      metadataInheritance: {mode: "preserve-result"},
    }),
  },
];

const inheritedEnvelopeDescriptors = (input: CommandFixture["input"]) => ({
  commandId: dataDescriptor(input.commandId),
  type: dataDescriptor(input.type),
  expectedRevision: dataDescriptor(input.expectedRevision),
  payload: dataDescriptor(input.payload),
});

const nullPrototypeDeleteCommand = () => {
  const payload = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(payload, "countryId", {
    configurable: true,
    enumerable: true,
    value: "AAA",
    writable: true,
  });
  const command = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(envelope(
    "null-prototype-delete",
    "country.delete",
    payload,
  ))) {
    Object.defineProperty(command, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return command;
};

describe("10-31~10-45 Object.prototype pollution boundary", () => {
  it("rejects an empty envelope when all required fields exist only on Object.prototype", () => {
    const accepted = withObjectPrototypeDescriptors(
      inheritedEnvelopeDescriptors(deleteLeaf),
      () => safeParseMapCommandV2Envelope({}).success,
    );

    expect(accepted).toBe(false);
  });

  it("rejects inherited commandId without executing its getter", () => {
    let getterCalls = 0;
    const accepted = withObjectPrototypeDescriptors(
      {
        ...inheritedEnvelopeDescriptors(deleteLeaf),
        commandId: {
          configurable: true,
          enumerable: false,
          get() {
            getterCalls += 1;
            return "inherited-getter";
          },
        },
      },
      () => safeParseMapCommandV2Envelope({}).success,
    );

    expect(accepted).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects an envelope that mixes own and inherited required fields", () => {
    const candidate = {commandId: "mixed", type: "country.delete"};
    const accepted = withObjectPrototypeDescriptors(
      {
        expectedRevision: dataDescriptor(21),
        payload: dataDescriptor({countryId: "AAA"}),
      },
      () => safeParseMapCommandV2Envelope(candidate).success,
    );

    expect(accepted).toBe(false);
  });

  it("rejects a payload whose required field exists only on Object.prototype", () => {
    const accepted = withObjectPrototypeDescriptors(
      {countryId: dataDescriptor("AAA")},
      () => countryDeleteV2CommandSchema.safeParse(
        envelope("delete", "country.delete", {}),
      ).success,
    );

    expect(accepted).toBe(false);
  });

  it.each(directCommandFixtures)(
    "rejects an empty direct $name command supplied by Object.prototype",
    ({schema, input}) => {
      const accepted = withObjectPrototypeDescriptors(
        inheritedEnvelopeDescriptors(input),
        () => schema.safeParse({}).success,
      );

      expect(accepted).toBe(false);
    },
  );

  it("rejects polluted empty batch leaves and nested batches", () => {
    const leafAccepted = withObjectPrototypeDescriptors(
      inheritedEnvelopeDescriptors(deleteLeaf),
      () => commandBatchV2CommandSchema.safeParse(
        envelope("batch-root", "command.batch", {commands: [{}]}),
      ).success,
    );
    const nestedBatch = envelope("nested", "command.batch", {commands: [deleteLeaf]});
    const nestedAccepted = withObjectPrototypeDescriptors(
      inheritedEnvelopeDescriptors(nestedBatch),
      () => commandBatchV2CommandSchema.safeParse(
        envelope("batch-root", "command.batch", {commands: [{}]}),
      ).success,
    );

    expect(leafAccepted).toBe(false);
    expect(nestedAccepted).toBe(false);
  });

  it("keeps ordinary and null-prototype valid inputs accepted under pollution", () => {
    const ordinary = envelope("ordinary", "country.delete", {countryId: "AAA"});
    const nullPrototype = nullPrototypeDeleteCommand();
    const accepted = withObjectPrototypeDescriptors(
      inheritedEnvelopeDescriptors(deleteLeaf),
      () => ({
        ordinary: countryDeleteV2CommandSchema.safeParse(ordinary).success,
        nullPrototype: countryDeleteV2CommandSchema.safeParse(nullPrototype).success,
      }),
    );

    expect(accepted).toEqual({ordinary: true, nullPrototype: true});
  });

  it("does not mutate rejected input while Object.prototype is polluted", () => {
    const candidate = {commandId: "mixed", type: "country.delete"};
    const descriptorsBefore = Object.getOwnPropertyDescriptors(candidate);
    const prototypeBefore = Object.getPrototypeOf(candidate);
    const accepted = withObjectPrototypeDescriptors(
      {
        expectedRevision: dataDescriptor(21),
        payload: dataDescriptor({countryId: "AAA"}),
      },
      () => safeParseMapCommandV2Envelope(candidate).success,
    );

    expect(accepted).toBe(false);
    expect(Object.getOwnPropertyDescriptors(candidate)).toEqual(descriptorsBefore);
    expect(Object.getPrototypeOf(candidate)).toBe(prototypeBefore);
  });
});
