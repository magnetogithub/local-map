import {z} from "zod";

type DataPropertyDescriptor = PropertyDescriptor & {value: unknown};

const dataProperty = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is DataPropertyDescriptor =>
  descriptor !== undefined && "value" in descriptor;

function defineSafeDataProperty(
  target: object,
  key: string,
  value: unknown,
) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function rebuildArrayData(
  value: unknown[],
  path: string,
  activeObjects: WeakSet<object>,
  rebuiltObjects: WeakMap<object, unknown>,
): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} must use Array.prototype`);
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new TypeError(`${path} must not contain symbol properties`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = dataProperty(lengthDescriptor) ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new TypeError(`${path}.length must be a valid array length`);
  }
  if (keys.length !== (length as number) + 1) {
    throw new TypeError(`${path} must be a dense array without extra properties`);
  }

  const rebuilt: unknown[] = [];
  rebuiltObjects.set(value, rebuilt);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError(`${path} contains an invalid array property`);
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= (length as number) || String(index) !== key) {
      throw new TypeError(`${path}.${key} is not a canonical array index`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !dataProperty(descriptor)) {
      throw new TypeError(`${path}[${key}] must be an own enumerable data property`);
    }
    defineSafeDataProperty(
      rebuilt,
      key,
      rebuildPlainData(descriptor.value, `${path}[${key}]`, activeObjects, rebuiltObjects),
    );
  }
  return rebuilt;
}

function rebuildRecordData(
  value: object,
  path: string,
  activeObjects: WeakSet<object>,
  rebuiltObjects: WeakMap<object, unknown>,
): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object or null-prototype record`);
  }

  const rebuilt = Object.create(null) as Record<string, unknown>;
  rebuiltObjects.set(value, rebuilt);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new TypeError(`${path} must not contain symbol properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !dataProperty(descriptor)) {
      throw new TypeError(`${path}.${key} must be an own enumerable data property`);
    }
    defineSafeDataProperty(
      rebuilt,
      key,
      rebuildPlainData(descriptor.value, `${path}.${key}`, activeObjects, rebuiltObjects),
    );
  }
  return rebuilt;
}

function rebuildPlainData(
  value: unknown,
  path: string,
  activeObjects: WeakSet<object>,
  rebuiltObjects: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not JSON-compatible command data`);
  }
  if (activeObjects.has(value)) {
    throw new TypeError(`${path} must not contain a circular reference`);
  }
  const previouslyRebuilt = rebuiltObjects.get(value);
  if (previouslyRebuilt !== undefined) return previouslyRebuilt;

  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      return rebuildArrayData(value, path, activeObjects, rebuiltObjects);
    }
    return rebuildRecordData(value, path, activeObjects, rebuiltObjects);
  } finally {
    activeObjects.delete(value);
  }
}

export function rebuildPlainCommandDataTree(input: unknown): unknown {
  return rebuildPlainData(input, "command", new WeakSet(), new WeakMap());
}

export function assertPlainCommandDataTree(input: unknown): void {
  rebuildPlainCommandDataTree(input);
}

export const plainCommandDataV2Schema = z.unknown().transform((input, context) => {
  try {
    return rebuildPlainCommandDataTree(input);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid command data tree",
    });
    return z.NEVER;
  }
});

export const wrapCommandSchemaWithPlainDataBoundary = <Schema extends z.ZodType>(
  schema: Schema,
) => plainCommandDataV2Schema.pipe(schema);
