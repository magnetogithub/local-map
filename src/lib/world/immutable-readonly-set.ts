const collectIterator = <T>(iterator: Iterator<T>): T[] => {
  const values: T[] = [];
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    values.push(next.value);
  }
  return values;
};

class ImmutableReadonlySet<T> implements ReadonlySet<T> {
  private readonly valuesSnapshot: readonly T[];

  constructor(values: Iterable<T>) {
    this.valuesSnapshot = Object.freeze([...new Set(values)]);
    Object.freeze(this);
  }

  get size() {
    return this.valuesSnapshot.length;
  }

  has(value: T) {
    return this.valuesSnapshot.includes(value);
  }

  forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) {
    this.valuesSnapshot.forEach((value) => callback.call(thisArg, value, value, this));
  }

  entries(): SetIterator<[T, T]> {
    return this.valuesSnapshot.map((value) => [value, value] as [T, T]).values();
  }

  keys(): SetIterator<T> {
    return this.valuesSnapshot.values();
  }

  values(): SetIterator<T> {
    return this.valuesSnapshot.values();
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.valuesSnapshot.values();
  }

  union<U>(other: ReadonlySetLike<U>): Set<T | U> {
    return new Set<T | U>([...this.valuesSnapshot, ...collectIterator(other.keys())]);
  }

  intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
    const otherValues = other as ReadonlySetLike<unknown>;
    return new Set(
      this.valuesSnapshot.filter((value): value is T & U => otherValues.has(value)),
    );
  }

  difference<U>(other: ReadonlySetLike<U>): Set<T> {
    const otherValues = other as ReadonlySetLike<unknown>;
    return new Set(this.valuesSnapshot.filter((value) => !otherValues.has(value)));
  }

  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const result = this.difference(other) as Set<T | U>;
    for (const value of collectIterator(other.keys())) {
      if (!this.has(value as unknown as T)) result.add(value);
    }
    return result;
  }

  isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
    return this.valuesSnapshot.every((value) => other.has(value));
  }

  isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
    for (const value of collectIterator(other.keys())) {
      if (!this.has(value as T)) return false;
    }
    return true;
  }

  isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
    return this.valuesSnapshot.every((value) => !other.has(value));
  }
}

export function createImmutableReadonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  return new ImmutableReadonlySet(values);
}
