import {COUNTRY_ID_PATTERN, type CountryId} from "./country-id";

export const compareWorldV3Ids = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export function readWorldV3Record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a plain object record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${context} must be a plain object record`);
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new Error(`${context} must not contain symbol fields`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (["__proto__", "constructor", "prototype"].includes(key) ||
      !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${context} contains a forbidden field: ${key}`);
    }
  }
  return value as Record<string, unknown>;
}

export function assertWorldV3Keys(input: Record<string, unknown>, keys: readonly string[], context: string) {
  const actual = Object.keys(input).sort(compareWorldV3Ids);
  const expected = [...keys].sort(compareWorldV3Ids);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} contains unknown or missing fields`);
  }
}

export function readWorldV3Array(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${context} must be a plain array`);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new Error(`${context} contains symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length ||
      !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${context} contains a forbidden array field: ${key}`);
    }
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(descriptors, String(index))) throw new Error(`${context} must not contain array holes`);
  }
  return value;
}

/** Checks nested legacy country modules before their existing validators are reused. */
export function assertWorldV3DataTree(value: unknown, context: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) throw new Error(`${context} must not contain circular data`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of readWorldV3Array(value, context)) assertWorldV3DataTree(item, context, ancestors);
  } else {
    for (const [key, item] of Object.entries(readWorldV3Record(value, context))) {
      assertWorldV3DataTree(item, `${context}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

export function readWorldV3CountryId(value: unknown, context: string): CountryId {
  if (typeof value !== "string" || !COUNTRY_ID_PATTERN.test(value)) {
    throw new Error(`${context} must be a canonical CountryId`);
  }
  return value as CountryId;
}

export function readWorldV3Version(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${context} must be a bounded ASCII canonical version`);
  }
  return value;
}

export function readWorldV3Order<T extends string>(
  value: unknown, readId: (value: unknown, context: string) => T, context: string,
): readonly T[] {
  const ids = Array.from(readWorldV3Array(value, context), (item) => readId(item, context));
  if (ids.some((id, index) => index > 0 && compareWorldV3Ids(ids[index - 1], id) >= 0)) {
    throw new Error(`${context} must be bytewise sorted without duplicates`);
  }
  return Object.freeze(ids);
}

export function assertWorldV3RecordOrder(input: Record<string, unknown>, order: readonly string[], context: string) {
  const keys = Object.keys(input).sort(compareWorldV3Ids);
  if (keys.length !== order.length || keys.some((key, index) => key !== order[index])) {
    throw new Error(`${context} record and order must contain exactly the same IDs`);
  }
}
