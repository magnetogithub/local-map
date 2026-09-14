export type CanonicalPrimitive = string | number | boolean | null;
export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | Readonly<{[key: string]: CanonicalValue}>;

const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalError = (path: string, detail: string): never => {
  throw new TypeError(`Canonical serialization rejected ${path}: ${detail}`);
};

function stringifyValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) canonicalError(path, "number must be finite");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "undefined":
      return canonicalError(path, "undefined is not supported");
    case "function":
    case "symbol":
    case "bigint":
      return canonicalError(path, `${typeof value} is not supported`);
  }

  if (ancestors.has(value)) canonicalError(path, "circular structure");
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(stringifyValue(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      canonicalError(path, "only arrays and plain objects are supported");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      canonicalError(path, "symbol properties are not supported");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort(compareCodeUnits);
    const fields = keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) {
        canonicalError(`${path}.${key}`, "non-enumerable properties are not supported");
      }
      if (!("value" in descriptor)) {
        canonicalError(`${path}.${key}`, "accessor properties are not supported");
      }
      return `${JSON.stringify(key)}:${stringifyValue(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
      )}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces canonical JSON text without locale-sensitive formatting or object insertion order.
 * Unsupported runtime-only values fail closed instead of being silently omitted.
 */
export function canonicalStringify(value: unknown): string {
  return stringifyValue(value, "$", new Set());
}

/** Produces the exact UTF-8 byte sequence used by domain hashing. */
export function canonicalSerialize(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(value));
}
