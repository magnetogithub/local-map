import {describe, expect, it} from "vitest";
import type {ZodType} from "zod";

import {deriveTerritoryId} from "@/lib/world/territory-id";

import {
  commandBatchV2CommandSchema,
  localCommandReferenceV2Schema,
} from "./command-batch-v2";
import {
  countryCreateV2CommandSchema,
  countryIdentityV2Schema,
  countryNamesV2Schema,
  countryPresentationOverrideV2Schema,
} from "./country-create-v2";
import {countryDeleteV2CommandSchema} from "./country-delete-v2";
import {
  countryDissolveDispositionV2Schema,
  countryDissolveTerritoryDispositionV2Schema,
  countryDissolveV2CommandSchema,
} from "./country-dissolve-v2";
import {countryEstablishV2CommandSchema} from "./country-establish-v2";
import {
  countryMergeV2CommandSchema,
  mergeMetadataInheritanceV2Schema,
  mergeResultCountryV2Schema,
} from "./country-merge-v2";
import {countryRenameV2CommandSchema} from "./country-rename-v2";
import {
  countrySplitResultV2Schema,
  countrySplitV2CommandSchema,
} from "./country-split-v2";
import {territoryAssignV2CommandSchema} from "./territory-assign-v2";
import {
  polygonGeometryV2Schema,
  territoryPartitionResultV2Schema,
  territoryPartitionV2CommandSchema,
} from "./territory-partition-v2";
import {territoryReplaceV2CommandSchema} from "./territory-replace-v2";
import {
  partitionResultReferenceV2Schema,
  territorySourceReferenceV2Schema,
  territoryTransferV2CommandSchema,
} from "./territory-transfer-v2";
import {territoryUnclaimV2CommandSchema} from "./territory-unclaim-v2";

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
const envelope = (commandId: string, type: string, payload: object) => ({
  commandId,
  type,
  expectedRevision: 21,
  payload,
});

type SchemaCase = Readonly<{
  name: string;
  schema: ZodType;
  input: ReturnType<typeof envelope>;
}>;

const alphaTerritory = territory("alpha");
const betaTerritory = territory("beta");
const deleteLeaf = envelope("delete-leaf", "country.delete", {countryId: "OLD"});
const schemaCases: SchemaCase[] = [
  {
    name: "country.create",
    schema: countryCreateV2CommandSchema,
    input: envelope("create-a", "country.create", {country: identity("AAA")}),
  },
  {
    name: "country.establish",
    schema: countryEstablishV2CommandSchema,
    input: envelope("establish-a", "country.establish", {
      country: identity("AAA"),
      territoryIds: [alphaTerritory],
    }),
  },
  {
    name: "country.rename",
    schema: countryRenameV2CommandSchema,
    input: envelope("rename-a", "country.rename", {
      countryId: "AAA",
      changes: {english: "A Republic"},
    }),
  },
  {
    name: "country.delete",
    schema: countryDeleteV2CommandSchema,
    input: deleteLeaf,
  },
  {
    name: "country.dissolve",
    schema: countryDissolveV2CommandSchema,
    input: envelope("dissolve-a", "country.dissolve", {
      sourceCountryId: "AAA",
      territoryDispositions: [
        {territoryId: alphaTerritory, disposition: {type: "unclaim"}},
      ],
    }),
  },
  {
    name: "territory.partition",
    schema: territoryPartitionV2CommandSchema,
    input: envelope("partition-a", "territory.partition", {
      sourceTerritoryId: alphaTerritory,
      partitions: [
        {partitionKey: "west", geometry: polygon(0)},
        {partitionKey: "east", geometry: polygon(1)},
      ],
    }),
  },
  {
    name: "territory.assign",
    schema: territoryAssignV2CommandSchema,
    input: envelope("assign-a", "territory.assign", {
      territoryId: alphaTerritory,
      targetCountryId: "AAA",
    }),
  },
  {
    name: "territory.unclaim",
    schema: territoryUnclaimV2CommandSchema,
    input: envelope("unclaim-a", "territory.unclaim", {
      territoryIds: [alphaTerritory],
    }),
  },
  {
    name: "territory.replace",
    schema: territoryReplaceV2CommandSchema,
    input: envelope("replace-a", "territory.replace", {
      territoryId: alphaTerritory,
      geometry: polygon(),
    }),
  },
  {
    name: "territory.transfer",
    schema: territoryTransferV2CommandSchema,
    input: envelope("transfer-a", "territory.transfer", {
      source: {kind: "territory-id", territoryId: alphaTerritory},
      targetCountryId: "BBB",
    }),
  },
  {
    name: "country.split",
    schema: countrySplitV2CommandSchema,
    input: envelope("split-a", "country.split", {
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
    input: envelope("merge-a", "country.merge", {
      sourceCountryIds: ["AAA", "BBB"],
      resultCountry: {kind: "existing-country", countryId: "AAA"},
      metadataInheritance: {mode: "preserve-result"},
    }),
  },
  {
    name: "command.batch",
    schema: commandBatchV2CommandSchema,
    input: envelope("batch-a", "command.batch", {commands: [deleteLeaf]}),
  },
];

const partitionReference = {
  kind: "partition-result",
  commandId: "partition-a",
  partitionKey: "west",
};
const structuredSchemaCases: ReadonlyArray<{
  name: string;
  schema: ZodType;
  input: object;
}> = [
  {name: "country names", schema: countryNamesV2Schema, input: identity("AAA").names},
  {
    name: "presentation override",
    schema: countryPresentationOverrideV2Schema,
    input: {center: [1, 1], policyVersion: "presentation-v2", reason: "reviewed"},
  },
  {name: "country identity", schema: countryIdentityV2Schema, input: identity("AAA")},
  {
    name: "dissolve disposition",
    schema: countryDissolveDispositionV2Schema,
    input: {type: "transfer", targetCountryId: "BBB"},
  },
  {
    name: "Territory disposition entry",
    schema: countryDissolveTerritoryDispositionV2Schema,
    input: {territoryId: alphaTerritory, disposition: {type: "unclaim"}},
  },
  {name: "geometry", schema: polygonGeometryV2Schema, input: polygon()},
  {
    name: "partition result",
    schema: territoryPartitionResultV2Schema,
    input: {partitionKey: "west", geometry: polygon()},
  },
  {
    name: "Territory source reference",
    schema: territorySourceReferenceV2Schema,
    input: {kind: "territory-id", territoryId: alphaTerritory},
  },
  {
    name: "partition-result reference",
    schema: partitionResultReferenceV2Schema,
    input: partitionReference,
  },
  {
    name: "local command reference",
    schema: localCommandReferenceV2Schema,
    input: partitionReference,
  },
  {
    name: "split result",
    schema: countrySplitResultV2Schema,
    input: {
      country: identity("AAA"),
      territorySources: [{kind: "territory-id", territoryId: alphaTerritory}],
    },
  },
  {
    name: "merge result reference",
    schema: mergeResultCountryV2Schema,
    input: {kind: "existing-country", countryId: "AAA"},
  },
  {
    name: "metadata inheritance",
    schema: mergeMetadataInheritanceV2Schema,
    input: {mode: "preserve-result"},
  },
];

const inherited = <T extends object>(value: T): T => Object.create(value) as T;

const nullPrototypeTree = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(nullPrototypeTree);
  if (value === null || typeof value !== "object") return value;
  return Object.assign(
    Object.create(null),
    Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, nullPrototypeTree(nested)]),
    ),
  );
};

describe("10-45 v2 command schema purity", () => {
  it.each(schemaCases)("does not mutate $name input", ({schema, input}) => {
    const before = structuredClone(input);

    expect(schema.safeParse(input).success).toBe(true);
    expect(input).toEqual(before);
  });

  it.each(schemaCases)("rejects top-level unknown fields for $name", ({schema, input}) => {
    const candidate = {...input, unknownTopLevel: true};
    const before = structuredClone(candidate);

    expect(schema.safeParse(candidate).success).toBe(false);
    expect(candidate).toEqual(before);
  });

  it.each(schemaCases)("rejects payload unknown fields for $name", ({schema, input}) => {
    const candidate = {...input, payload: {...input.payload, unknownPayload: true}};
    const before = structuredClone(candidate);

    expect(schema.safeParse(candidate).success).toBe(false);
    expect(candidate).toEqual(before);
  });

  it.each(schemaCases)("rejects inherited command fields for $name", ({schema, input}) => {
    const candidate = inherited(input);
    const prototypeBefore = Object.getPrototypeOf(candidate);

    expect(Object.keys(candidate)).toHaveLength(0);
    expect(schema.safeParse(candidate).success).toBe(false);
    expect(Object.getPrototypeOf(candidate)).toBe(prototypeBefore);
  });

  it.each(schemaCases)("rejects inherited payload fields for $name", ({schema, input}) => {
    const payload = inherited(input.payload);
    const candidate = {...input, payload};

    expect(Object.keys(payload)).toHaveLength(0);
    expect(schema.safeParse(candidate).success).toBe(false);
    expect(Object.getPrototypeOf(payload)).toBe(input.payload);
  });

  it.each(schemaCases)("accepts null-prototype plain data for $name", ({schema, input}) => {
    const candidate = nullPrototypeTree(input);

    expect(schema.safeParse(candidate).success).toBe(true);
  });

  it.each(structuredSchemaCases)(
    "rejects inherited fields through direct $name schema calls",
    ({schema, input}) => {
      const candidate = inherited(input);

      expect(schema.safeParse(candidate).success).toBe(false);
      expect(() => schema.parse(candidate)).toThrow();
    },
  );

  it.each(structuredSchemaCases)(
    "accepts null-prototype records through direct $name schema calls",
    ({schema, input}) => {
      expect(schema.safeParse(nullPrototypeTree(input)).success).toBe(true);
    },
  );

  it("rejects inherited country identity and nested names", () => {
    const createCase = schemaCases.find(({name}) => name === "country.create")!;
    const createPayload = createCase.input.payload as {country: ReturnType<typeof identity>};
    const inheritedCountry = {
      ...createCase.input,
      payload: {...createPayload, country: inherited(createPayload.country)},
    };
    const inheritedNames = {
      ...createCase.input,
      payload: {
        ...createPayload,
        country: {...createPayload.country, names: inherited(createPayload.country.names)},
      },
    };

    expect(createCase.schema.safeParse(inheritedCountry).success).toBe(false);
    expect(createCase.schema.safeParse(inheritedNames).success).toBe(false);
  });

  it("rejects inherited presentation override and rename changes", () => {
    const createInput = envelope("create-presentation", "country.create", {
      country: {
        ...identity("AAA"),
        presentationOverride: {
          center: [1, 1],
          policyVersion: "presentation-v2",
          reason: "reviewed",
        },
      },
    });
    const country = (createInput.payload as {country: {presentationOverride: object}}).country;
    const renameCase = schemaCases.find(({name}) => name === "country.rename")!;
    const renamePayload = renameCase.input.payload as {countryId: string; changes: object};

    expect(
      countryCreateV2CommandSchema.safeParse({
        ...createInput,
        payload: {
          country: {...country, presentationOverride: inherited(country.presentationOverride)},
        },
      }).success,
    ).toBe(false);
    expect(
      renameCase.schema.safeParse({
        ...renameCase.input,
        payload: {...renamePayload, changes: inherited(renamePayload.changes)},
      }).success,
    ).toBe(false);
  });

  it("rejects inherited disposition, partition result, and geometry", () => {
    const dissolveCase = schemaCases.find(({name}) => name === "country.dissolve")!;
    const dissolvePayload = dissolveCase.input.payload as {
      sourceCountryId: string;
      territoryDispositions: {territoryId: string; disposition: object}[];
    };
    const partitionCase = schemaCases.find(({name}) => name === "territory.partition")!;
    const partitionPayload = partitionCase.input.payload as {
      sourceTerritoryId: string;
      partitions: {partitionKey: string; geometry: object}[];
    };

    expect(
      dissolveCase.schema.safeParse({
        ...dissolveCase.input,
        payload: {
          ...dissolvePayload,
          territoryDispositions: [{
            ...dissolvePayload.territoryDispositions[0],
            disposition: inherited(dissolvePayload.territoryDispositions[0].disposition),
          }],
        },
      }).success,
    ).toBe(false);
    expect(
      partitionCase.schema.safeParse({
        ...partitionCase.input,
        payload: {
          ...partitionPayload,
          partitions: [
            inherited(partitionPayload.partitions[0]),
            partitionPayload.partitions[1],
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      partitionCase.schema.safeParse({
        ...partitionCase.input,
        payload: {
          ...partitionPayload,
          partitions: [
            {...partitionPayload.partitions[0], geometry: inherited(partitionPayload.partitions[0].geometry)},
            partitionPayload.partitions[1],
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects inherited Territory and partition-result references", () => {
    const transferCase = schemaCases.find(({name}) => name === "territory.transfer")!;
    const transferPayload = transferCase.input.payload as {source: object; targetCountryId: string};
    const localReference = {
      kind: "partition-result",
      commandId: "partition-a",
      partitionKey: "west",
    };

    expect(
      transferCase.schema.safeParse({
        ...transferCase.input,
        payload: {...transferPayload, source: inherited(transferPayload.source)},
      }).success,
    ).toBe(false);
    expect(
      transferCase.schema.safeParse({
        ...transferCase.input,
        payload: {...transferPayload, source: inherited(localReference)},
      }).success,
    ).toBe(false);
  });

  it("rejects inherited split and merge nested objects", () => {
    const splitCase = schemaCases.find(({name}) => name === "country.split")!;
    const splitPayload = splitCase.input.payload as {
      sourceCountryId: string;
      resultCountries: object[];
    };
    const mergeCase = schemaCases.find(({name}) => name === "country.merge")!;
    const mergePayload = mergeCase.input.payload as {
      sourceCountryIds: string[];
      resultCountry: object;
      metadataInheritance: object;
    };

    expect(
      splitCase.schema.safeParse({
        ...splitCase.input,
        payload: {
          ...splitPayload,
          resultCountries: [inherited(splitPayload.resultCountries[0]), splitPayload.resultCountries[1]],
        },
      }).success,
    ).toBe(false);
    expect(
      mergeCase.schema.safeParse({
        ...mergeCase.input,
        payload: {...mergePayload, resultCountry: inherited(mergePayload.resultCountry)},
      }).success,
    ).toBe(false);
    expect(
      mergeCase.schema.safeParse({
        ...mergeCase.input,
        payload: {
          ...mergePayload,
          metadataInheritance: inherited(mergePayload.metadataInheritance),
        },
      }).success,
    ).toBe(false);
  });

  it("rejects inherited batch leaf, nested batch, and nested batch payload", () => {
    const batchCase = schemaCases.find(({name}) => name === "command.batch")!;
    const inheritedLeaf = envelope("batch-leaf", "command.batch", {
      commands: [inherited(deleteLeaf)],
    });
    const nestedBatch = envelope("nested", "command.batch", {commands: [deleteLeaf]});
    const inheritedNestedBatch = envelope("root", "command.batch", {
      commands: [inherited(nestedBatch)],
    });
    const inheritedNestedPayload = envelope("root", "command.batch", {
      commands: [{...nestedBatch, payload: inherited(nestedBatch.payload)}],
    });

    expect(batchCase.schema.safeParse(inheritedLeaf).success).toBe(false);
    expect(batchCase.schema.safeParse(inheritedNestedBatch).success).toBe(false);
    expect(batchCase.schema.safeParse(inheritedNestedPayload).success).toBe(false);
  });

  it("rejects class command instances as typed commands and batch leaves", () => {
    class DeleteCommand {
      commandId = "class-delete";
      type = "country.delete";
      expectedRevision = 21;
      payload = {countryId: "AAA"};
    }
    const instance = new DeleteCommand();

    expect(countryDeleteV2CommandSchema.safeParse(instance).success).toBe(false);
    expect(commandBatchV2CommandSchema.safeParse(envelope("batch", "command.batch", {
      commands: [instance],
    })).success).toBe(false);
  });

  it("rejects nested symbols and non-enumerable unknown data", () => {
    const createCase = schemaCases.find(({name}) => name === "country.create")!;
    const createPayload = createCase.input.payload as {country: ReturnType<typeof identity>};
    const countryWithSymbol = {...createPayload.country} as ReturnType<typeof identity> & {
      [key: symbol]: unknown;
    };
    countryWithSymbol[Symbol("country-secret")] = true;
    const countryWithHidden = {...createPayload.country};
    Object.defineProperty(countryWithHidden, "hidden", {value: true, enumerable: false});

    expect(createCase.schema.safeParse({
      ...createCase.input,
      payload: {country: countryWithSymbol},
    }).success).toBe(false);
    expect(createCase.schema.safeParse({
      ...createCase.input,
      payload: {country: countryWithHidden},
    }).success).toBe(false);
  });
});
