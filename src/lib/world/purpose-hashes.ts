import {canonicalSerialize} from "./canonical-serializer";
import {assertSha256Hex} from "./domain-hash-root";
import {sha256Hex} from "./sha256";

export const COMMIT_HASH_INPUT_FIELDS = [
  "policyVersion",
  "previousCommitHash",
  "revision",
  "worldContentHash",
] as const;

export const ARTIFACT_HASH_INPUT_FIELDS = [
  "artifactContentHash",
  "projectionKind",
  "projectionVersion",
  "revision",
] as const;

export const HISTORY_HASH_INPUT_FIELDS = ["commandHashes", "cursor"] as const;

export type CommitHashInput = Readonly<{
  revision: number;
  worldContentHash: string;
  policyVersion: string;
  previousCommitHash: string | null;
}>;

export type ArtifactHashInput = Readonly<{
  revision: number;
  projectionKind: string;
  projectionVersion: string;
  artifactContentHash: string;
}>;

export type HistoryHashInput = Readonly<{
  commandHashes: readonly string[];
  cursor: number;
}>;

const PURPOSE_HASH_CONTRACT_VERSION = 1 as const;

const readRevision = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("revision must be a non-negative safe integer");
  }
  return value;
};

const readCanonicalText = (value: string, context: string) => {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${context} must be a non-empty canonical string`);
  }
  return value;
};

export function commitHash(input: CommitHashInput): string {
  assertSha256Hex(input.worldContentHash, "commitHash worldContentHash");
  if (input.previousCommitHash !== null) {
    assertSha256Hex(input.previousCommitHash, "commitHash previousCommitHash");
  }
  return sha256Hex(
    canonicalSerialize({
      namespace: "commit",
      contractVersion: PURPOSE_HASH_CONTRACT_VERSION,
      revision: readRevision(input.revision),
      worldContentHash: input.worldContentHash,
      policyVersion: readCanonicalText(input.policyVersion, "policyVersion"),
      previousCommitHash: input.previousCommitHash,
    }),
  );
}

export function artifactHash(input: ArtifactHashInput): string {
  assertSha256Hex(input.artifactContentHash, "artifactHash artifactContentHash");
  return sha256Hex(
    canonicalSerialize({
      namespace: "artifact",
      contractVersion: PURPOSE_HASH_CONTRACT_VERSION,
      revision: readRevision(input.revision),
      projectionKind: readCanonicalText(input.projectionKind, "projectionKind"),
      projectionVersion: readCanonicalText(input.projectionVersion, "projectionVersion"),
      artifactContentHash: input.artifactContentHash,
    }),
  );
}

export function historyHash(input: HistoryHashInput): string {
  if (
    !Number.isSafeInteger(input.cursor) ||
    input.cursor < 0 ||
    input.cursor > input.commandHashes.length
  ) {
    throw new TypeError("history cursor must address the command boundary from 0 through length");
  }
  input.commandHashes.forEach((commandHash, index) =>
    assertSha256Hex(commandHash, `history commandHashes[${index}]`),
  );
  return sha256Hex(
    canonicalSerialize({
      namespace: "history",
      contractVersion: PURPOSE_HASH_CONTRACT_VERSION,
      commandHashes: input.commandHashes,
      cursor: input.cursor,
    }),
  );
}
