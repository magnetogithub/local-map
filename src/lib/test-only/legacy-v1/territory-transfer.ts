import polygonClipping, {type MultiPolygon} from "polygon-clipping";
import {z} from "zod";

import type {PolygonGeometry, Position} from "@/lib/map/country-label-layout";
import type {WorldState} from "./world-state";

import {mapCommandEnvelopeSchema} from "../../commands/map-command";
import {
  normalizePolygonGeometry,
  territoryReplaceGeometrySchema,
} from "./territory-replace";

export const MAX_TRANSFER_AREA_TOLERANCE = 1e-6;

export const territoryTransferPolicySchema = z.strictObject({
  operation: z.literal("difference-union"),
  areaTolerance: z.number().finite().positive().max(MAX_TRANSFER_AREA_TOLERANCE),
});

export const territoryTransferPayloadSchema = z.strictObject({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  transferGeometry: territoryReplaceGeometrySchema,
  policy: territoryTransferPolicySchema,
});

export const territoryTransferCommandSchema = mapCommandEnvelopeSchema.extend({
  type: z.literal("territory.transfer"),
  payload: territoryTransferPayloadSchema,
});

export type TerritoryTransferPolicy = z.infer<typeof territoryTransferPolicySchema>;
export type TerritoryTransferPayload = z.infer<typeof territoryTransferPayloadSchema>;
export type TerritoryTransferCommand = z.infer<typeof territoryTransferCommandSchema>;

export type TerritoryTransferMeasurements = {
  transferArea: number;
  sourceOverlapArea: number;
  transferOutsideSourceArea: number;
  targetCollisionArea: number;
  sourceRemovedArea: number;
  targetAddedArea: number;
  totalAreaError: number;
  sourceRemovalError: number;
  targetAdditionError: number;
};

export type TerritoryTransferPlan = {
  command: TerritoryTransferCommand;
  fromGeometry: PolygonGeometry;
  toGeometry: PolygonGeometry;
  measurements: TerritoryTransferMeasurements;
};

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const geometryToMultiPolygon = (geometry: PolygonGeometry): MultiPolygon =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as MultiPolygon;

const ringArea = (ring: readonly Position[]) =>
  Math.abs(
    ring.slice(0, -1).reduce((area, point, index) => {
      const next = ring[index + 1];
      return area + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2,
  );

const polygonArea = (polygon: readonly Position[][]) =>
  Math.max(0, ringArea(polygon[0]) - polygon.slice(1).reduce((area, hole) => area + ringArea(hole), 0));

export const polygonGeometryArea = (geometry: PolygonGeometry) =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates).reduce(
    (area, polygon) => area + polygonArea(polygon),
    0,
  );

const clippingArea = (geometry: MultiPolygon) =>
  geometry.reduce((area, polygon) => area + polygonArea(polygon as Position[][]), 0);

function normalizeClippingResult(result: MultiPolygon, context: string): PolygonGeometry {
  if (result.length === 0) throw new Error(`${context} produced empty geometry`);
  return normalizePolygonGeometry(
    result.length === 1
      ? {type: "Polygon", coordinates: result[0]}
      : {type: "MultiPolygon", coordinates: result},
  );
}

function analyzeTerritoryTransfer(
  state: Pick<WorldState, "countriesById">,
  command: TerritoryTransferCommand,
): Omit<TerritoryTransferPlan, "command"> {
  const {from, to, transferGeometry, policy} = command.payload;
  const fromGeometry = state.countriesById[from].geometry;
  const toGeometry = state.countriesById[to].geometry;
  const sourceMultiPolygon = geometryToMultiPolygon(fromGeometry);
  const targetMultiPolygon = geometryToMultiPolygon(toGeometry);
  const transferMultiPolygon = geometryToMultiPolygon(transferGeometry);
  const transferArea = polygonGeometryArea(transferGeometry);
  const sourceIntersection = polygonClipping.intersection(
    sourceMultiPolygon,
    transferMultiPolygon,
  );
  const sourceOverlapArea = clippingArea(sourceIntersection);
  const transferOutsideSourceArea = Math.max(0, transferArea - sourceOverlapArea);
  const targetCollisionArea = clippingArea(
    polygonClipping.intersection(targetMultiPolygon, transferMultiPolygon),
  );

  if (sourceOverlapArea <= policy.areaTolerance) {
    throw new Error(`Transfer geometry does not overlap source country: ${from}`);
  }
  if (transferOutsideSourceArea > policy.areaTolerance) {
    throw new Error(
      `Transfer geometry extends outside source country by ${transferOutsideSourceArea}`,
    );
  }
  if (targetCollisionArea > policy.areaTolerance) {
    throw new Error(`Transfer geometry collides with target country by ${targetCollisionArea}`);
  }

  const fromGeometryAfter = normalizeClippingResult(
    polygonClipping.difference(sourceMultiPolygon, transferMultiPolygon),
    `Transfer source ${from}`,
  );
  const toGeometryAfter = normalizeClippingResult(
    polygonClipping.union(targetMultiPolygon, transferMultiPolygon),
    `Transfer target ${to}`,
  );
  const fromAreaBefore = polygonGeometryArea(fromGeometry);
  const toAreaBefore = polygonGeometryArea(toGeometry);
  const fromAreaAfter = polygonGeometryArea(fromGeometryAfter);
  const toAreaAfter = polygonGeometryArea(toGeometryAfter);
  const sourceRemovedArea = fromAreaBefore - fromAreaAfter;
  const targetAddedArea = toAreaAfter - toAreaBefore;
  const totalAreaError = Math.abs(fromAreaBefore + toAreaBefore - fromAreaAfter - toAreaAfter);
  const sourceRemovalError = Math.abs(sourceRemovedArea - transferArea);
  const targetAdditionError = Math.abs(targetAddedArea - transferArea);

  if (
    totalAreaError > policy.areaTolerance ||
    sourceRemovalError > policy.areaTolerance ||
    targetAdditionError > policy.areaTolerance
  ) {
    throw new Error(
      `Territory transfer exceeds area tolerance: total=${totalAreaError}, source=${sourceRemovalError}, target=${targetAdditionError}`,
    );
  }

  return {
    fromGeometry: fromGeometryAfter,
    toGeometry: toGeometryAfter,
    measurements: {
      transferArea,
      sourceOverlapArea,
      transferOutsideSourceArea,
      targetCollisionArea,
      sourceRemovedArea,
      targetAddedArea,
      totalAreaError,
      sourceRemovalError,
      targetAdditionError,
    },
  };
}

export const territoryTransferCommandSchemaFor = (
  state: Pick<WorldState, "countriesById">,
) =>
  territoryTransferCommandSchema.superRefine((command, context) => {
    const {from, to} = command.payload;
    if (!hasOwn(state.countriesById, from)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "from"],
        message: `Source country does not exist: ${from}`,
      });
    }
    if (!hasOwn(state.countriesById, to)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "to"],
        message: `Target country does not exist: ${to}`,
      });
    }
    if (from === to) {
      context.addIssue({
        code: "custom",
        path: ["payload", "to"],
        message: "Source and target countries must differ",
      });
    }
    if (
      from === to ||
      !hasOwn(state.countriesById, from) ||
      !hasOwn(state.countriesById, to)
    ) {
      return;
    }

    try {
      analyzeTerritoryTransfer(state, command);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["payload", "transferGeometry"],
        message: error instanceof Error ? error.message : "Invalid territory transfer",
      });
    }
  });

export const parseTerritoryTransferCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
): TerritoryTransferCommand => territoryTransferCommandSchemaFor(state).parse(input);

export const safeParseTerritoryTransferCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
) => territoryTransferCommandSchemaFor(state).safeParse(input);

export function planTerritoryTransfer(
  state: Pick<WorldState, "countriesById">,
  input: unknown,
): TerritoryTransferPlan {
  const command = parseTerritoryTransferCommand(input, state);
  return {command, ...analyzeTerritoryTransfer(state, command)};
}

export function applyTerritoryTransferCommand(state: WorldState, input: unknown): WorldState {
  const plan = planTerritoryTransfer(state, input);
  const {from, to} = plan.command.payload;
  return {
    ...state,
    revision: state.revision + 1,
    countriesById: {
      ...state.countriesById,
      [from]: {...state.countriesById[from], geometry: plan.fromGeometry},
      [to]: {...state.countriesById[to], geometry: plan.toGeometry},
    },
  };
}
